import { withTx, type Db, type Executor } from '../../db/pool.js';
import { audit, type ActorContext } from '../../lib/audit.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { fromUnits, percentOf, roundToMinor, toUnits } from '../../lib/money.js';
import { closeBookingFinancials } from '../finance/earnings.js';
import { refundableFor, requestRefunds, type RefundSource } from '../finance/refunds.js';
import { getSetting } from '../settings/registry.js';
import { cancelUnpaid, freeCalendar, lockBooking, notify, transition, type BookingStatus } from './service.js';

export type CancelBy = 'customer' | 'provider' | 'admin' | 'no_show';

interface Policy { tiers: { hoursBefore: number; refundPercentOfPaid: number }[]; depositRefundable: boolean; selfCancelAllowed: boolean; requiresManualReview: boolean }

export interface CancellationQuote {
  mode: 'unpaid' | 'immediate' | 'review' | 'not_allowed';
  hoursBefore: number;
  platformPaid: string;
  directPaid: string;
  refund: string;
  retained: string;
  refundPercent: number | null;
  policy: Policy | null;
  note: string | null;
}

const PAID_CANCELLABLE: Record<Exclude<CancelBy, 'no_show'>, BookingStatus[]> = {
  customer: ['awaiting_payment', 'confirmed'],
  provider: ['awaiting_payment', 'confirmed'],
  admin: ['awaiting_payment', 'confirmed', 'in_progress'],
};

/**
 * What cancelling would mean now, from the policy snapshotted in the booking (clause 49).
 * - Provider cancels: the customer gets the configured share back (100% by default).
 * - Customer cancels / no-show: the tier for the hours left before the start applies to the platform
 *   payments; a non-refundable deposit is kept first. No-show counts as zero hours (owner's decision).
 * - No policy, or a policy requiring manual review: a staff decision is needed.
 * Direct payments went to the provider and are reported, never refunded by the platform.
 */
export async function quoteCancellation(c: Executor, bookingId: string, by: CancelBy): Promise<CancellationQuote> {
  const b = (await c.query<{ status: BookingStatus; start_at: Date; cancellation_policy: Policy | null; deposit_type: string; upfront_amount: string; currency_code: string; country_id: string; now: Date }>(
    'SELECT status, start_at, cancellation_policy, deposit_type, upfront_amount, currency_code, country_id, now() AS now FROM bookings WHERE id = $1', [bookingId])).rows[0];
  if (!b) throw notFound();
  const r = await refundableFor(c, bookingId);
  const hoursBefore = by === 'no_show' ? 0 : Math.max(0, (b.start_at.getTime() - b.now.getTime()) / 3_600_000);
  const base: CancellationQuote = {
    mode: 'immediate', hoursBefore: Math.floor(hoursBefore * 100) / 100, platformPaid: fromUnits(r.platformPaid), directPaid: fromUnits(r.directPaid),
    refund: '0.0000', retained: fromUnits(r.available), refundPercent: null, policy: b.cancellation_policy, note: null,
  };
  if (by !== 'no_show' && r.platformPaid === 0n && r.directPaid === 0n) return { ...base, mode: 'unpaid' };
  if (by !== 'no_show' && !PAID_CANCELLABLE[by].includes(b.status)) return { ...base, mode: 'not_allowed', note: `not cancellable in status ${b.status}` };

  const minor = (await c.query<{ m: number }>('SELECT minor_units AS m FROM currencies WHERE code = $1', [b.currency_code.trim()])).rows[0]!.m;
  const withRefund = (refund: bigint, pct: number | null, mode: CancellationQuote['mode'] = 'immediate', note: string | null = null): CancellationQuote =>
    ({ ...base, mode, refund: fromUnits(refund), retained: fromUnits(r.available - refund), refundPercent: pct, note });

  if (by === 'provider') {
    const pct = await getSetting(c, 'refunds.provider_cancellation_percent', b.country_id);
    return withRefund(roundToMinor(percentOf(r.available, String(pct)), minor), pct);
  }
  if (by === 'admin') return withRefund(r.available, 100, 'immediate', 'staff may set a lower amount');

  const p = b.cancellation_policy;
  if (!p) return withRefund(0n, null, 'review', 'no cancellation policy on this booking: a staff decision is required');
  if (by === 'customer' && !p.selfCancelAllowed) return withRefund(0n, null, 'not_allowed', 'the policy does not allow self-cancellation');

  const tier = [...p.tiers].sort((x, y) => y.hoursBefore - x.hoursBefore).find((t) => hoursBefore >= t.hoursBefore);
  const pct = tier?.refundPercentOfPaid ?? 0;
  const deposit = b.deposit_type === 'none' ? 0n : toUnits(b.upfront_amount);
  const keptDeposit = p.depositRefundable ? 0n : (deposit < r.platformPaid ? deposit : r.platformPaid);
  const alreadyRefunded = r.platformPaid - r.available;
  let refundBase = r.platformPaid - keptDeposit - alreadyRefunded;
  if (refundBase < 0n) refundBase = 0n;
  const refund = roundToMinor(percentOf(refundBase, String(pct)), minor);
  return withRefund(refund, pct, p.requiresManualReview ? 'review' : 'immediate', p.requiresManualReview ? 'the policy requires a staff review' : null);
}

const TO_STATUS: Record<Exclude<CancelBy, 'no_show'>, BookingStatus> = {
  customer: 'cancelled_by_customer', provider: 'cancelled_by_provider', admin: 'cancelled_by_admin',
};
const SOURCE: Record<CancelBy, RefundSource> = {
  customer: 'cancellation_policy', provider: 'provider_cancellation', admin: 'admin_cancellation', no_show: 'no_show_policy',
};

/** Cancels a booking with its money handled per policy. Unpaid bookings keep the simple path. */
export async function cancelBooking(
  db: Db, bookingId: string, by: Exclude<CancelBy, 'no_show'>, reason: string, ctx: ActorContext,
  opts: { customerId?: string; providerId?: string; refundAmount?: string } = {},
) {
  const pre = await quoteCancellation(db, bookingId, by);
  if (pre.mode === 'unpaid') return cancelUnpaid(db, bookingId, by, reason, ctx, { customerId: opts.customerId, providerId: opts.providerId });

  return withTx(db, async (c) => {
    const b = await lockBooking(c, bookingId);
    if (opts.customerId && b.customer_id !== opts.customerId) throw notFound();
    if (opts.providerId && b.provider_id !== opts.providerId) throw notFound();
    const q = await quoteCancellation(c, bookingId, by); // recomputed under the lock
    if (q.mode === 'not_allowed') throw conflict('CANCELLATION_NOT_ALLOWED', { reason: q.note });

    if (q.mode === 'review') {
      const pending = await c.query(`SELECT 1 FROM cancellation_requests WHERE booking_id = $1 AND status = 'pending'`, [bookingId]);
      if (pending.rowCount) throw conflict('CANCELLATION_ALREADY_REQUESTED');
      const id = (await c.query<{ id: string }>(
        'INSERT INTO cancellation_requests (booking_id, requested_by, reason, computed_refund) VALUES ($1, $2, $3, $4) RETURNING id',
        [bookingId, ctx.actorId, reason, q.refund])).rows[0]!.id;
      await audit(c, ctx, { action: 'booking.cancellation_requested', entityType: 'booking', entityId: bookingId, after: { requestId: id, computedRefund: q.refund }, reason });
      return { status: b.status, cancellationRequestId: id, quote: q };
    }

    let refund = q.refund;
    if (by === 'admin' && opts.refundAmount !== undefined) {
      if (toUnits(opts.refundAmount) < 0n || toUnits(opts.refundAmount) > toUnits(q.refund)) throw badRequest('REFUND_EXCEEDS_REFUNDABLE', { max: q.refund });
      refund = opts.refundAmount;
    }
    await freeCalendar(c, b, ctx.actorId, `cancelled by ${by}`);
    await transition(c, b, TO_STATUS[by], ctx, reason, { hold_expires_at: null });
    const refunds = await requestRefunds(c, bookingId, refund, SOURCE[by], reason, ctx);
    await closeBookingFinancials(c, bookingId, ctx);
    const other = by === 'customer' ? (await c.query<{ user_id: string }>('SELECT user_id FROM providers WHERE id = $1', [b.provider_id])).rows[0]!.user_id : b.customer_id;
    await notify(c, other, 'booking.cancelled', { bookingId, number: b.number, reason, refund });
    return { status: b.status, refundIds: refunds, quote: { ...q, refund } };
  });
}

/** Provider marks a no-show after the start: the cancellation policy applies as if cancelled at the start time. */
export async function markNoShow(db: Db, providerId: string, bookingId: string, ctx: ActorContext) {
  return withTx(db, async (c) => {
    const b = await lockBooking(c, bookingId);
    if (b.provider_id !== providerId) throw notFound();
    if (b.status !== 'confirmed') throw conflict('INVALID_STATUS_TRANSITION', { from: b.status });
    const started = (await c.query<{ s: boolean }>('SELECT start_at <= now() AS s FROM bookings WHERE id = $1', [bookingId])).rows[0]!.s;
    if (!started) throw conflict('INVALID_STATUS_TRANSITION', { reason: 'the booking has not started yet' });
    await transition(c, b, 'no_show', ctx, null);
    const q = await quoteCancellation(c, bookingId, 'no_show');
    if (q.mode === 'review') {
      await c.query('INSERT INTO cancellation_requests (booking_id, requested_by, reason, computed_refund) VALUES ($1, $2, $3, $4)',
        [bookingId, ctx.actorId, 'customer no-show', q.refund]);
    } else {
      await requestRefunds(c, bookingId, q.refund, 'no_show_policy', 'customer no-show (cancellation policy at start time)', ctx);
      await closeBookingFinancials(c, bookingId, ctx);
    }
    await notify(c, b.customer_id, 'booking.no_show', { bookingId, number: b.number, refund: q.refund });
    return { status: b.status, quote: q };
  });
}

/** Staff decision on a cancellation that needed review (or a no-show without an automatic rule). */
export async function decideCancellationRequest(db: Db, requestId: string, decision: 'approve' | 'reject', refundAmount: string | undefined, reason: string, ctx: ActorContext) {
  return withTx(db, async (c) => {
    const r = (await c.query<{ id: string; booking_id: string; status: string; computed_refund: string; reason: string }>(
      'SELECT * FROM cancellation_requests WHERE id = $1 FOR UPDATE', [requestId])).rows[0];
    if (!r) throw notFound();
    if (r.status !== 'pending') throw conflict('INVALID_STATUS_TRANSITION', { from: r.status });
    const b = await lockBooking(c, r.booking_id);
    if (decision === 'reject') {
      await c.query(`UPDATE cancellation_requests SET status = 'rejected', decided_by = $2, decided_at = now(), decision_reason = $3 WHERE id = $1`, [requestId, ctx.actorId, reason]);
      if (b.status === 'no_show') {
        // Rejecting a no-show refund means nothing is refunded: close with everything retained.
        await closeBookingFinancials(c, b.id, ctx);
      }
      await audit(c, ctx, { action: 'booking.cancellation_rejected', entityType: 'booking', entityId: b.id, reason });
      await notify(c, b.customer_id, 'booking.cancellation_rejected', { bookingId: b.id, number: b.number, reason });
      return { status: 'rejected' };
    }
    const available = (await refundableFor(c, b.id)).available;
    const amount = refundAmount ?? r.computed_refund;
    if (toUnits(amount) < 0n || toUnits(amount) > available) throw badRequest('REFUND_EXCEEDS_REFUNDABLE', { max: fromUnits(available) });
    if (b.status !== 'no_show') {
      if (!PAID_CANCELLABLE.customer.includes(b.status)) throw conflict('INVALID_STATUS_TRANSITION', { from: b.status });
      await freeCalendar(c, b, ctx.actorId, 'cancellation approved');
      await transition(c, b, 'cancelled_by_customer', ctx, r.reason, { hold_expires_at: null });
    }
    await c.query(`UPDATE cancellation_requests SET status = 'approved', approved_refund = $2, decided_by = $3, decided_at = now(), decision_reason = $4 WHERE id = $1`,
      [requestId, amount, ctx.actorId, reason]);
    await requestRefunds(c, b.id, amount, b.status === 'no_show' ? 'no_show_policy' : 'cancellation_policy', reason, ctx);
    await closeBookingFinancials(c, b.id, ctx);
    await audit(c, ctx, { action: 'booking.cancellation_approved', entityType: 'booking', entityId: b.id, after: { refund: amount }, reason });
    await notify(c, b.customer_id, 'booking.cancellation_approved', { bookingId: b.id, number: b.number, refund: amount });
    return { status: 'approved', refund: amount };
  });
}
