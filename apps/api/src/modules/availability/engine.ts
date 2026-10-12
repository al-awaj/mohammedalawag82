import type pg from 'pg';
import type { Db, Executor } from '../../db/pool.js';
import { audit, systemActor } from '../../lib/audit.js';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors.js';
import { getSetting } from '../settings/registry.js';

export type BlockKind = 'hold' | 'booking' | 'external' | 'closed';
export type BookingMode = 'time_slot' | 'full_day' | 'date_range' | 'quantity_rental';

export interface ServiceCalendar {
  id: string;
  status: string;
  provider_status: string;
  country_id: string;
  timezone: string;
  booking_mode: BookingMode;
  buffer_before_minutes: number;
  buffer_after_minutes: number;
  max_concurrent_bookings: number;
  duration_minutes: number | null;
  slot_step_minutes: number | null;
}

interface Interval { start: number; end: number; units: number }

/** Highest number of units used at any instant of [start, end) by the given intervals (sweep line). */
export function peakUsage(blocks: Interval[], start: number, end: number): number {
  const events: [number, number][] = [];
  for (const b of blocks) {
    const s = Math.max(b.start, start);
    const e = Math.min(b.end, end);
    if (s < e) events.push([s, b.units], [e, -b.units]);
  }
  // Ends before starts at the same instant: [a,b) and [b,c) do not overlap.
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0;
  let peak = 0;
  for (const [, delta] of events) {
    cur += delta;
    peak = Math.max(peak, cur);
  }
  return peak;
}

export async function loadServiceCalendar(exec: Executor, serviceId: string, lock = false): Promise<ServiceCalendar> {
  const s = (await exec.query<ServiceCalendar>(
    `SELECT s.id, s.status, p.status AS provider_status, s.country_id, co.timezone, t.booking_mode, t.buffer_before_minutes,
            t.buffer_after_minutes, s.max_concurrent_bookings, s.duration_minutes, s.slot_step_minutes
       FROM services s JOIN service_types t ON t.id = s.service_type_id JOIN providers p ON p.id = s.provider_id
       JOIN countries co ON co.id = s.country_id
      WHERE s.id = $1 ${lock ? 'FOR UPDATE OF s' : ''}`, [serviceId])).rows[0];
  if (!s) throw notFound();
  return s;
}

/** Local (service timezone) view of an instant: date, minutes since midnight, weekday. Computed by PostgreSQL's tz database. */
async function localParts(exec: Executor, tz: string, ...instants: Date[]) {
  const { rows } = await exec.query<{ d: string; m: number; dow: number }>(
    `SELECT to_char(x AT TIME ZONE $1, 'YYYY-MM-DD') AS d,
            (extract(hour FROM x AT TIME ZONE $1) * 60 + extract(minute FROM x AT TIME ZONE $1))::int AS m,
            extract(dow FROM x AT TIME ZONE $1)::int AS dow,
            extract(second FROM x AT TIME ZONE $1) = 0 AS whole
       FROM unnest($2::timestamptz[]) WITH ORDINALITY AS u(x, i) ORDER BY i`, [tz, instants]);
  return rows;
}

async function hasRules(exec: Executor, serviceId: string): Promise<boolean> {
  return Boolean((await exec.query('SELECT 1 FROM availability_rules WHERE service_id = $1 LIMIT 1', [serviceId])).rowCount);
}

/**
 * Checks the period against the booking mode and, when `enforceSchedule`, the weekly opening hours.
 * Day-based modes must cover whole local days; time slots must fit inside one opening window and
 * start on the slot grid.
 */
async function checkShape(exec: Executor, svc: ServiceCalendar, start: Date, end: Date, enforceSchedule: boolean, kind: BlockKind) {
  const [ls, le] = await localParts(exec, svc.timezone, start, end);
  const dayBased = svc.booking_mode !== 'time_slot';
  if (dayBased && kind !== 'closed' && kind !== 'external') {
    if (ls!.m !== 0 || le!.m !== 0) throw badRequest('PERIOD_INVALID', { reason: 'must start and end at local midnight' });
    const days = (await exec.query<{ n: number }>('SELECT ($2::date - $1::date) AS n', [ls!.d, le!.d])).rows[0]!.n;
    if (svc.booking_mode === 'full_day' && days !== 1) throw badRequest('PERIOD_INVALID', { reason: 'exactly one day' });
  }
  if (!enforceSchedule || !(await hasRules(exec, svc.id))) return;

  if (dayBased) {
    // Every local day touched must be an opening day.
    const closed = await exec.query(
      `SELECT d FROM generate_series($2::date, $3::date - 1, interval '1 day') AS d
        WHERE NOT EXISTS (SELECT 1 FROM availability_rules r WHERE r.service_id = $1 AND r.weekday = extract(dow FROM d))`,
      [svc.id, ls!.d, le!.d]);
    if (closed.rowCount) throw badRequest('OUTSIDE_SCHEDULE');
    return;
  }
  const rule = (await exec.query<{ start_min: number }>(
    `SELECT (extract(hour FROM r.start_time) * 60 + extract(minute FROM r.start_time))::int AS start_min
       FROM availability_rules r
      WHERE r.service_id = $1 AND r.weekday = $2
        AND ($3::timestamptz AT TIME ZONE $5)::time >= r.start_time
        AND ($4::timestamptz AT TIME ZONE $5) <= ($3::timestamptz AT TIME ZONE $5)::date + r.end_time
      LIMIT 1`, [svc.id, ls!.dow, start, end, svc.timezone])).rows[0];
  if (!rule) throw badRequest('OUTSIDE_SCHEDULE');
  const step = svc.slot_step_minutes ?? svc.duration_minutes;
  if (step && (ls!.m - rule.start_min) % step !== 0) throw badRequest('OUTSIDE_SCHEDULE', { reason: 'not on the slot grid', stepMinutes: step });
}

/** Releases holds that have run out; called inline before conflict checks and by the scheduled job. */
async function releaseExpiredOverlapping(c: Executor, serviceId: string) {
  await c.query(
    `UPDATE calendar_blocks SET status = 'released', released_at = now(), release_reason = 'expired'
      WHERE service_id = $1 AND kind = 'hold' AND status = 'active' AND expires_at <= now()`, [serviceId]);
}

export interface ReserveInput {
  serviceId: string;
  rentalItemId?: string | null;
  start: Date;
  end: Date;
  units?: number;
  kind: BlockKind;
  /** Customer-facing reservations must respect publication state and opening hours. */
  enforceSchedule: boolean;
  bookingRef?: string | null;
  reason?: string | null;
  internalNotes?: string | null;
  actorId: string | null;
}

export interface Reservation { id: string; expiresAt: Date | null }

/**
 * Reserves a period inside the caller's transaction. Concurrent callers for the same service are
 * serialized by locking the service row; the exclusion constraint is a second, database-level guard.
 */
export async function reserve(c: pg.PoolClient, input: ReserveInput): Promise<Reservation> {
  const { start, end, kind } = input;
  if (!(start < end)) throw badRequest('PERIOD_INVALID', { reason: 'start must be before end' });
  const svc = await loadServiceCalendar(c, input.serviceId, true);

  if (kind === 'hold' || kind === 'booking') {
    if (svc.status !== 'published' || svc.provider_status !== 'active') throw conflict('SERVICE_NOT_BOOKABLE');
    const past = (await c.query<{ past: boolean }>('SELECT $1::timestamptz <= now() AS past', [start])).rows[0]!.past;
    if (past) throw badRequest('PERIOD_IN_PAST');
  }

  const rental = svc.booking_mode === 'quantity_rental';
  let capacity = svc.max_concurrent_bookings;
  if (input.rentalItemId) {
    if (!rental) throw badRequest('RENTAL_ITEMS_NOT_ALLOWED');
    const item = (await c.query<{ quantity_total: number; status: string }>(
      'SELECT quantity_total, status FROM rental_items WHERE id = $1 AND service_id = $2 FOR UPDATE', [input.rentalItemId, svc.id])).rows[0];
    if (!item) throw notFound();
    if (item.status !== 'active' && (kind === 'hold' || kind === 'booking')) throw conflict('SERVICE_NOT_BOOKABLE');
    capacity = item.quantity_total;
  } else if (rental && kind !== 'closed') {
    throw badRequest('RENTAL_ITEM_REQUIRED');
  }
  await checkShape(c, svc, start, end, input.enforceSchedule, kind);

  // Closures take the whole service/item; buffers (preparation, cleaning, travel) widen the others.
  const units = kind === 'closed' ? Math.max(capacity, 1) : input.units ?? 1;
  if (units > capacity && kind !== 'closed') throw conflict('SLOT_UNAVAILABLE', { capacity });
  const bufBefore = kind === 'closed' || rental ? 0 : svc.buffer_before_minutes;
  const bufAfter = kind === 'closed' || rental ? 0 : svc.buffer_after_minutes;
  const blocked = (await c.query<{ s: Date; e: Date }>(
    `SELECT $1::timestamptz - make_interval(mins => $3) AS s, $2::timestamptz + make_interval(mins => $4) AS e`,
    [start, end, bufBefore, bufAfter])).rows[0]!;

  await releaseExpiredOverlapping(c, svc.id);
  // For a rental item, service-wide closures count as fully occupying it.
  const existing = (await c.query<{ s: Date; e: Date; units: number; rental_item_id: string | null; kind: string }>(
    `SELECT lower(blocked_period) AS s, upper(blocked_period) AS e, units, rental_item_id, kind FROM calendar_blocks
      WHERE service_id = $1 AND status = 'active' AND blocked_period && tstzrange($2, $3)
        AND ($4::uuid IS NULL OR rental_item_id = $4 OR rental_item_id IS NULL)`,
    [svc.id, blocked.s, blocked.e, input.rentalItemId ?? null])).rows;
  const intervals = existing.map((b) => ({
    start: b.s.getTime(), end: b.e.getTime(),
    units: input.rentalItemId && b.rental_item_id === null ? capacity : b.units,
  }));
  const peak = peakUsage(intervals, blocked.s.getTime(), blocked.e.getTime());
  if (peak + (kind === 'closed' ? 1 : units) > capacity) throw conflict('SLOT_UNAVAILABLE', { capacity, inUse: peak });

  const holdMinutes = kind === 'hold' ? await getSetting(c, 'booking.hold_minutes', svc.country_id) : null;
  try {
    const row = (await c.query<{ id: string; expires_at: Date | null }>(
      `INSERT INTO calendar_blocks (service_id, rental_item_id, kind, period, blocked_period, units, exclusive, expires_at,
                                    booking_ref, reason, internal_notes, created_by)
       VALUES ($1, $2, $3, tstzrange($4, $5), tstzrange($6, $7), $8, $9,
               CASE WHEN $10::int IS NULL THEN NULL ELSE now() + make_interval(mins => $10::int) END, $11, $12, $13, $14)
       RETURNING id, expires_at`,
      [svc.id, input.rentalItemId ?? null, kind, start, end, blocked.s, blocked.e, units, !rental && capacity === 1,
        holdMinutes, input.bookingRef ?? null, input.reason ?? null, input.internalNotes ?? null, input.actorId])).rows[0]!;
    return { id: row.id, expiresAt: row.expires_at };
  } catch (err) {
    if ((err as { code?: string }).code === '23P01') throw conflict('SLOT_UNAVAILABLE');
    throw err;
  }
}

/**
 * Turns a hold into a confirmed booking block. A hold that expired or was released is never
 * confirmed as-is: availability is checked again from scratch (clause 28).
 */
export async function confirmHold(c: pg.PoolClient, blockId: string, bookingRef: string, actorId: string | null): Promise<Reservation> {
  const b = (await c.query<{ id: string; service_id: string; rental_item_id: string | null; period_s: Date; period_e: Date; units: number; status: string; kind: string; live: boolean }>(
    `SELECT id, service_id, rental_item_id, lower(period) AS period_s, upper(period) AS period_e, units, status, kind,
            (status = 'active' AND expires_at > now()) AS live
       FROM calendar_blocks WHERE id = $1 FOR UPDATE`, [blockId])).rows[0];
  if (!b || b.kind !== 'hold') throw notFound();
  if (b.live) {
    await c.query(`UPDATE calendar_blocks SET kind = 'booking', expires_at = NULL, booking_ref = $2 WHERE id = $1`, [blockId, bookingRef]);
    return { id: blockId, expiresAt: null };
  }
  if (b.status === 'active') {
    await c.query(`UPDATE calendar_blocks SET status = 'released', released_at = now(), release_reason = 'expired' WHERE id = $1`, [blockId]);
  }
  return reserve(c, {
    serviceId: b.service_id, rentalItemId: b.rental_item_id, start: b.period_s, end: b.period_e, units: b.units,
    kind: 'booking', enforceSchedule: true, bookingRef, actorId,
  });
}

export async function releaseBlock(c: Executor, blockId: string, actorId: string | null, reason: string): Promise<void> {
  const r = await c.query(
    `UPDATE calendar_blocks SET status = 'released', released_at = now(), released_by = $2, release_reason = $3
      WHERE id = $1 AND status = 'active'`, [blockId, actorId, reason]);
  if (!r.rowCount) throw new AppError('INVALID_STATUS_TRANSITION', 409);
}

/** Scheduled job: frees every expired hold. Uses database time, never the client's. */
export async function releaseExpiredHolds(db: Db): Promise<number> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ id: string; booking_ref: string | null }>(
      `UPDATE calendar_blocks SET status = 'released', released_at = now(), release_reason = 'expired'
        WHERE kind = 'hold' AND status = 'active' AND expires_at <= now() RETURNING id, booking_ref`);
    if (rows.length) {
      await audit(client, systemActor, { action: 'calendar.holds_expired', entityType: 'calendar_block', after: { blockIds: rows.map((r) => r.id) } });
    }
    await client.query('COMMIT');
    return rows.length;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
