import type { Executor } from '../../db/pool.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { loadServiceCalendar, peakUsage } from './engine.js';

export const MAX_RANGE_DAYS = 62;

export interface DayAvailability {
  date: string;
  open: boolean;
  windows: { start: string; end: string }[];
  /** Occupied intervals with no detail about who or why (clause 27 privacy). */
  busy: { start: string; end: string; units: number }[];
  available: boolean;
  slots?: { start: string; end: string; available: boolean }[];
}

/**
 * Availability of a service (or one rentable item) for each local day in [from, to].
 * Uses the same block data and peak-usage rule as `reserve`, so what is shown as free can be booked.
 */
export async function getAvailability(exec: Executor, serviceId: string, from: string, to: string, rentalItemId?: string) {
  const days = (await exec.query<{ n: number }>('SELECT ($2::date - $1::date) AS n', [from, to])).rows[0]!.n;
  if (days < 0 || days >= MAX_RANGE_DAYS) throw badRequest('PERIOD_INVALID', { maxDays: MAX_RANGE_DAYS });
  const svc = await loadServiceCalendar(exec, serviceId);
  const rental = svc.booking_mode === 'quantity_rental';

  let capacity = svc.max_concurrent_bookings;
  if (rental) {
    if (!rentalItemId) throw badRequest('RENTAL_ITEM_REQUIRED');
    const item = (await exec.query<{ quantity_total: number }>(
      `SELECT quantity_total FROM rental_items WHERE id = $1 AND service_id = $2 AND status = 'active'`, [rentalItemId, serviceId])).rows[0];
    if (!item) throw notFound();
    capacity = item.quantity_total;
  }

  // Opening windows converted from local wall-clock time to UTC by PostgreSQL (handles DST correctly).
  const windows = (await exec.query<{ day: string; ws: Date; we: Date; open: boolean }>(
    `WITH days AS (SELECT d::date AS day FROM generate_series($2::date, $3::date, interval '1 day') AS d),
          has AS (SELECT EXISTS (SELECT 1 FROM availability_rules WHERE service_id = $1) AS any)
     SELECT to_char(days.day, 'YYYY-MM-DD') AS day,
            CASE WHEN has.any THEN (days.day + r.start_time) AT TIME ZONE $4 ELSE days.day::timestamp AT TIME ZONE $4 END AS ws,
            CASE WHEN has.any THEN (days.day + r.end_time) AT TIME ZONE $4 ELSE (days.day + 1)::timestamp AT TIME ZONE $4 END AS we,
            (NOT has.any OR r.id IS NOT NULL) AS open
       FROM days CROSS JOIN has
       LEFT JOIN availability_rules r ON has.any AND r.service_id = $1 AND r.weekday = extract(dow FROM days.day)
      ORDER BY days.day, ws`, [serviceId, from, to, svc.timezone])).rows;

  const rangeStart = (await exec.query<{ s: Date; e: Date; now: Date }>(
    `SELECT $1::date::timestamp AT TIME ZONE $3 AS s, ($2::date + 1)::timestamp AT TIME ZONE $3 AS e, now() AS now`, [from, to, svc.timezone])).rows[0]!;
  const blocks = (await exec.query<{ s: Date; e: Date; units: number; rental_item_id: string | null }>(
    `SELECT lower(blocked_period) AS s, upper(blocked_period) AS e, units, rental_item_id FROM calendar_blocks
      WHERE service_id = $1 AND status = 'active' AND NOT (kind = 'hold' AND expires_at <= now())
        AND blocked_period && tstzrange($2, $3) AND ($4::uuid IS NULL OR rental_item_id = $4 OR rental_item_id IS NULL)`,
    [serviceId, rangeStart.s, rangeStart.e, rentalItemId ?? null])).rows;
  const intervals = blocks.map((b) => ({
    start: b.s.getTime(), end: b.e.getTime(), units: rentalItemId && b.rental_item_id === null ? capacity : b.units,
  }));
  const now = rangeStart.now.getTime();
  const before = rental ? 0 : svc.buffer_before_minutes * 60_000;
  const after = rental ? 0 : svc.buffer_after_minutes * 60_000;
  const fits = (s: number, e: number) => s > now && peakUsage(intervals, s - before, e + after) + 1 <= capacity;

  const dayBounds = new Map((await exec.query<{ day: string; s: Date; e: Date }>(
    `SELECT to_char(d, 'YYYY-MM-DD') AS day, d::date::timestamp AT TIME ZONE $3 AS s, (d::date + 1)::timestamp AT TIME ZONE $3 AS e
       FROM generate_series($1::date, $2::date, interval '1 day') AS d`, [from, to, svc.timezone])).rows.map((r) => [r.day, r]));

  const byDay = new Map<string, DayAvailability>();
  for (const w of windows) {
    const day = byDay.get(w.day) ?? { date: w.day, open: false, windows: [], busy: [], available: false };
    byDay.set(w.day, day);
    if (!w.open) continue;
    day.open = true;
    day.windows.push({ start: w.ws.toISOString(), end: w.we.toISOString() });
  }

  for (const day of byDay.values()) {
    if (!day.open) continue;
    const dayStart = Math.min(...day.windows.map((w) => Date.parse(w.start)));
    const dayEnd = Math.max(...day.windows.map((w) => Date.parse(w.end)));
    day.busy = blocks
      .filter((b) => b.s.getTime() < dayEnd && b.e.getTime() > dayStart)
      .map((b) => ({ start: b.s.toISOString(), end: b.e.toISOString(), units: rentalItemId && b.rental_item_id === null ? capacity : b.units }));

    if (svc.booking_mode === 'time_slot') {
      const step = (svc.slot_step_minutes ?? svc.duration_minutes ?? 60) * 60_000;
      const len = (svc.duration_minutes ?? svc.slot_step_minutes ?? 60) * 60_000;
      day.slots = [];
      for (const w of day.windows) {
        for (let s = Date.parse(w.start); s + len <= Date.parse(w.end); s += step) {
          day.slots.push({ start: new Date(s).toISOString(), end: new Date(s + len).toISOString(), available: fits(s, s + len) });
        }
      }
      day.available = day.slots.some((s) => s.available);
    } else {
      // Day-based modes reserve the whole local day, which must start in the future (same rule as reserve()).
      const b = dayBounds.get(day.date)!;
      day.available = fits(b.s.getTime(), b.e.getTime());
    }
  }
  return { serviceId, timezone: svc.timezone, bookingMode: svc.booking_mode, capacity, days: [...byDay.values()] };
}
