import { z } from 'zod';
import type pg from 'pg';
import type { App, Deps } from '../../deps.js';
import { actorOf, can, requireKind, requirePermission, requireUser } from '../../auth/guard.js';
import { withTx, type Db, type Executor } from '../../db/pool.js';
import { audit, systemActor, type ActorContext } from '../../lib/audit.js';
import { badRequest, conflict, mapUniqueViolation, notFound } from '../../lib/errors.js';
import { notifyUser } from '../../lib/notify.js';
import { idParams, reasonSchema } from '../common.js';
import { providerOf } from '../catalog/shared.js';
import { getSetting } from '../settings/registry.js';
import { releaseBlock, reserve } from '../availability/engine.js';

/**
 * Booking date changes (clause 26). The customer proposes a new start; the duration, price and every snapshot
 * stay the same. The new slot is held for the approval window, and the provider (or staff) approves or rejects.
 * Approval moves the booking and its calendar block in one transaction; the old slot is freed.
 */
const MOVABLE = ['awaiting_payment', 'confirmed'];
const COLUMNS = `r.id, r.booking_id AS "bookingId", r.old_start_at AS "oldStartAt", r.old_end_at AS "oldEndAt", r.new_start_at AS "newStartAt",
  r.new_end_at AS "newEndAt", r.reason, r.status, r.deadline, r.decided_at AS "decidedAt", r.decision_reason AS "decisionReason", r.created_at AS "createdAt"`;

interface BookingRow {
  id: string; number: string; customer_id: string; provider_id: string; service_id: string; rental_item_id: string | null; units: number;
  start_at: Date; end_at: Date; status: string; calendar_block_id: string | null; country_id: string; provider_user: string;
}

async function lockBooking(c: Executor, id: string): Promise<BookingRow | undefined> {
  return (await c.query<BookingRow>(
    `SELECT b.id, b.number, b.customer_id, b.provider_id, b.service_id, b.rental_item_id, b.units, b.start_at, b.end_at, b.status,
            b.calendar_block_id, b.country_id, p.user_id AS provider_user
       FROM bookings b JOIN providers p ON p.id = b.provider_id WHERE b.id = $1 FOR UPDATE OF b`, [id])).rows[0];
}

/** New start: an exact instant, or a local day (and optional local time) in the booking country's timezone, keeping the current time of day. */
export type NewStart = { start: Date } | { date: string; time?: string | null };

export async function requestReschedule(db: Db, bookingId: string, customerId: string, target: NewStart, reason: string | null, actor: ActorContext) {
  return withTx(db, async (c) => {
    const b = await lockBooking(c, bookingId);
    if (!b || b.customer_id !== customerId) throw notFound();
    const start = 'start' in target ? target.start : (await c.query<{ s: Date }>(
      `SELECT (($2::date + coalesce($3::time, (b.start_at AT TIME ZONE co.timezone)::time)) AT TIME ZONE co.timezone) AS s
         FROM bookings b JOIN countries co ON co.id = b.country_id WHERE b.id = $1`, [b.id, target.date, target.time ?? null])).rows[0]!.s;
    if (!MOVABLE.includes(b.status)) throw conflict('INVALID_STATUS', { status: b.status });
    if (b.start_at <= new Date()) throw conflict('BOOKING_STARTED');
    const end = new Date(start.getTime() + (b.end_at.getTime() - b.start_at.getTime()));
    if (start.getTime() === b.start_at.getTime()) throw badRequest('VALIDATION_FAILED', [{ path: '/start', message: 'same as the current date' }]);
    const hours = await getSetting(c, 'booking.approval_window_hours', b.country_id);
    // Hold the new slot for the approval window; availability, opening hours and buffers are checked as for a new booking.
    const hold = await reserve(c as pg.PoolClient, {
      serviceId: b.service_id, rentalItemId: b.rental_item_id, start, end, units: b.units, kind: 'hold', enforceSchedule: true,
      actorId: customerId, holdMinutes: hours * 60, reason: `reschedule ${b.number}`,
    });
    const id = (await c.query<{ id: string }>(
      `INSERT INTO booking_reschedule_requests (booking_id, requested_by, old_start_at, old_end_at, new_start_at, new_end_at, hold_block_id, reason, deadline)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [b.id, customerId, b.start_at, b.end_at, start, end, hold.id, reason, hold.expiresAt])
      .catch((e) => mapUniqueViolation(e, { booking_reschedule_open: 'RESCHEDULE_PENDING' }))).rows[0]!.id;
    await audit(c, actor, { action: 'booking.reschedule_requested', entityType: 'booking', entityId: b.id, reason,
      before: { startAt: b.start_at, endAt: b.end_at }, after: { requestId: id, startAt: start, endAt: end } });
    await notifyUser(c, b.provider_user, 'booking.reschedule_requested', { number: b.number, newStart: start.toISOString() });
    return { id, newStartAt: start, newEndAt: end, deadline: hold.expiresAt };
  });
}

type Decider = { kind: 'provider'; providerId: string } | { kind: 'staff'; userId: string } | { kind: 'customer'; customerId: string };

export async function decideReschedule(db: Db, requestId: string, decision: 'approve' | 'reject' | 'withdraw', who: Decider, reason: string | null, actor: ActorContext) {
  return withTx(db, async (c) => {
    const r = (await c.query<{ id: string; booking_id: string; status: string; new_start_at: Date; new_end_at: Date; hold_block_id: string | null; deadline: Date }>(
      'SELECT id, booking_id, status, new_start_at, new_end_at, hold_block_id, deadline FROM booking_reschedule_requests WHERE id = $1 FOR UPDATE', [requestId])).rows[0];
    if (!r) throw notFound();
    const b = await lockBooking(c, r.booking_id);
    if (!b) throw notFound();
    if (who.kind === 'provider' && b.provider_id !== who.providerId) throw notFound();
    if (who.kind === 'customer' && b.customer_id !== who.customerId) throw notFound();
    if (decision === 'withdraw' && who.kind !== 'customer') throw notFound();
    if (decision !== 'withdraw' && who.kind === 'customer') throw notFound();
    if (r.status !== 'pending') throw conflict('INVALID_STATUS', { status: r.status });
    const deciderId = who.kind === 'provider' ? actor.actorId : who.kind === 'staff' ? who.userId : who.customerId;

    if (decision !== 'approve') {
      if (r.hold_block_id) await c.query(`UPDATE calendar_blocks SET status = 'released', released_at = now(), release_reason = $2 WHERE id = $1 AND status = 'active'`, [r.hold_block_id, `reschedule_${decision}`]);
      const status = decision === 'reject' ? 'rejected' : 'withdrawn';
      await c.query(`UPDATE booking_reschedule_requests SET status = $2, decided_by = $3, decided_at = now(), decision_reason = $4 WHERE id = $1`, [r.id, status, deciderId, reason]);
      await audit(c, actor, { action: `booking.reschedule_${status}`, entityType: 'booking', entityId: b.id, reason, after: { requestId: r.id } });
      if (status === 'rejected') await notifyUser(c, b.customer_id, 'booking.reschedule_rejected', { number: b.number, reason: reason ?? '' });
      else await notifyUser(c, b.provider_user, 'booking.reschedule_withdrawn', { number: b.number });
      return { id: r.id, status };
    }

    if (r.deadline <= new Date()) throw conflict('RESCHEDULE_EXPIRED');
    if (!MOVABLE.includes(b.status)) throw conflict('INVALID_STATUS', { status: b.status });
    // The hold normally still stands; if it was released (it should not be before the deadline) the slot is re-checked.
    let blockId = r.hold_block_id;
    const live = blockId ? (await c.query<{ live: boolean }>(`SELECT status = 'active' AND expires_at > now() AS live FROM calendar_blocks WHERE id = $1 FOR UPDATE`, [blockId])).rows[0]?.live : false;
    if (live) {
      await c.query(`UPDATE calendar_blocks SET kind = 'booking', expires_at = NULL, booking_ref = $2, reason = NULL WHERE id = $1`, [blockId, b.id]);
    } else {
      blockId = (await reserve(c as pg.PoolClient, {
        serviceId: b.service_id, rentalItemId: b.rental_item_id, start: r.new_start_at, end: r.new_end_at, units: b.units,
        kind: 'booking', enforceSchedule: true, bookingRef: b.id, actorId: deciderId,
      })).id;
    }
    if (b.calendar_block_id) await releaseBlock(c, b.calendar_block_id, deciderId, `rescheduled to ${r.new_start_at.toISOString()}`).catch(() => undefined);
    const shift = r.new_start_at.getTime() - b.start_at.getTime();
    await c.query(
      `UPDATE bookings SET start_at = $2, end_at = $3, calendar_block_id = $4,
         balance_due_at = CASE WHEN balance_due_at IS NULL THEN NULL ELSE balance_due_at + make_interval(secs => $5::double precision / 1000) END
       WHERE id = $1`, [b.id, r.new_start_at, r.new_end_at, blockId, shift]);
    await c.query(`UPDATE booking_reschedule_requests SET status = 'approved', decided_by = $2, decided_at = now(), decision_reason = $3 WHERE id = $1`, [r.id, deciderId, reason]);
    await audit(c, actor, { action: 'booking.rescheduled', entityType: 'booking', entityId: b.id, reason,
      before: { startAt: b.start_at, endAt: b.end_at }, after: { requestId: r.id, startAt: r.new_start_at, endAt: r.new_end_at } });
    await notifyUser(c, b.customer_id, 'booking.rescheduled', { number: b.number, newStart: r.new_start_at.toISOString() });
    return { id: r.id, status: 'approved' };
  });
}

/** Scheduled job: requests past their deadline, or whose booking was cancelled meanwhile, expire and their held slot is freed. */
export async function expireRescheduleRequests(db: Db): Promise<number> {
  return withTx(db, async (c) => {
    const rows = (await c.query<{ id: string; booking_id: string; hold_block_id: string | null }>(
      `UPDATE booking_reschedule_requests SET status = 'expired', decided_at = now()
        WHERE status = 'pending' AND (deadline <= now() OR booking_id IN (SELECT id FROM bookings WHERE status <> ALL($1)))
       RETURNING id, booking_id, hold_block_id`, [MOVABLE])).rows;
    for (const r of rows) {
      if (r.hold_block_id) await c.query(`UPDATE calendar_blocks SET status = 'released', released_at = now(), release_reason = 'expired' WHERE id = $1 AND status = 'active'`, [r.hold_block_id]);
      const b = (await c.query<{ customer_id: string; number: string }>('SELECT customer_id, number FROM bookings WHERE id = $1', [r.booking_id])).rows[0]!;
      await notifyUser(c, b.customer_id, 'booking.reschedule_expired', { number: b.number });
      await audit(c, systemActor, { action: 'booking.reschedule_expired', entityType: 'booking', entityId: r.booking_id, after: { requestId: r.id } });
    }
    return rows.length;
  });
}

export async function rescheduleRequests(exec: Executor, bookingId: string) {
  return (await exec.query(`SELECT ${COLUMNS} FROM booking_reschedule_requests r WHERE r.booking_id = $1 ORDER BY r.created_at DESC`, [bookingId])).rows;
}

export async function rescheduleRoutes(app: App, deps: Deps) {
  const { db } = deps;
  const sec = [{ bearer: [] }];
  const customer = { onRequest: deps.authenticate, preValidation: requireKind('customer') };
  const provider = { onRequest: deps.authenticate, preValidation: requireKind('provider') };
  const decision = z.object({ reason: reasonSchema.optional() }).nullish();

  app.get('/bookings/:id/reschedule-requests', { ...customer, schema: { tags: ['bookings'], security: sec, params: idParams } }, async (req) => {
    if (!(await db.query('SELECT 1 FROM bookings WHERE id = $1 AND customer_id = $2', [req.params.id, requireUser(req).id])).rowCount) throw notFound();
    return rescheduleRequests(db, req.params.id);
  });

  app.post('/bookings/:id/reschedule', {
    ...customer,
    schema: {
      tags: ['bookings'], security: sec, params: idParams,
      body: z.object({
        start: z.iso.datetime({ offset: true }).optional(),
        date: z.iso.date().optional(),
        time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullish(),
        reason: z.string().trim().max(1000).nullish(),
      }).refine((b) => !!b.start !== !!b.date, 'give either start or date'),
    },
  }, async (req, reply) => {
    const b = req.body;
    const target: NewStart = b.start ? { start: new Date(b.start) } : { date: b.date!, time: b.time ?? null };
    return reply.status(201).send(await requestReschedule(db, req.params.id, requireUser(req).id, target, b.reason ?? null, actorOf(req)));
  });

  app.post('/reschedule-requests/:id/withdraw', { ...customer, schema: { tags: ['bookings'], security: sec, params: idParams } },
    async (req) => decideReschedule(db, req.params.id, 'withdraw', { kind: 'customer', customerId: requireUser(req).id }, null, actorOf(req)));

  app.get('/provider/bookings/:id/reschedule-requests', { ...provider, schema: { tags: ['provider-panel'], security: sec, params: idParams } }, async (req) => {
    const p = await providerOf(db, req, { forWrite: false });
    if (!(await db.query('SELECT 1 FROM bookings WHERE id = $1 AND provider_id = $2', [req.params.id, p.id])).rowCount) throw notFound();
    return rescheduleRequests(db, req.params.id);
  });

  app.get('/provider/reschedule-requests', { ...provider, schema: { tags: ['provider-panel'], security: sec } }, async (req) => {
    const p = await providerOf(db, req, { forWrite: false });
    return (await db.query(
      `SELECT ${COLUMNS}, b.number AS "bookingNumber", b.service_title AS "serviceTitle" FROM booking_reschedule_requests r JOIN bookings b ON b.id = r.booking_id
        WHERE b.provider_id = $1 AND r.status = 'pending' ORDER BY r.deadline`, [p.id])).rows;
  });

  for (const d of ['approve', 'reject'] as const) {
    app.post(`/provider/reschedule-requests/:id/${d}`, { ...provider, schema: { tags: ['provider-panel'], security: sec, params: idParams, body: decision } }, async (req) => {
      const p = await providerOf(db, req, { forWrite: true });
      const body = req.body as { reason?: string } | null | undefined;
      if (d === 'reject' && !body?.reason) throw badRequest('REASON_REQUIRED');
      return decideReschedule(db, (req.params as { id: string }).id, d, { kind: 'provider', providerId: p.id }, body?.reason ?? null, actorOf(req));
    });
    app.post(`/admin/reschedule-requests/:id/${d}`, {
      onRequest: deps.authenticate, preValidation: requirePermission('bookings.manage'), schema: { tags: ['admin:bookings'], security: sec, params: idParams, body: decision },
    }, async (req) => {
      const user = requireUser(req);
      const id = (req.params as { id: string }).id;
      const country = (await db.query<{ country_id: string }>('SELECT b.country_id FROM booking_reschedule_requests r JOIN bookings b ON b.id = r.booking_id WHERE r.id = $1', [id])).rows[0];
      if (!country || !can(user, 'bookings.manage', country.country_id)) throw notFound();
      const body = req.body as { reason?: string } | null | undefined;
      if (d === 'reject' && !body?.reason) throw badRequest('REASON_REQUIRED');
      return decideReschedule(db, id, d, { kind: 'staff', userId: user.id }, body?.reason ?? null, actorOf(req));
    });
  }

  app.get('/admin/bookings/:id/reschedule-requests', {
    onRequest: deps.authenticate, preValidation: requirePermission('bookings.view'), schema: { tags: ['admin:bookings'], security: sec, params: idParams },
  }, async (req) => {
    const b = (await db.query<{ country_id: string }>('SELECT country_id FROM bookings WHERE id = $1', [req.params.id])).rows[0];
    if (!b || !can(requireUser(req), 'bookings.view', b.country_id)) throw notFound();
    return rescheduleRequests(db, req.params.id);
  });
}
