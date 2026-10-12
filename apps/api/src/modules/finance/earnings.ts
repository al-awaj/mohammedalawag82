import type { Executor } from '../../db/pool.js';
import { audit, type ActorContext } from '../../lib/audit.js';
import { conflict, notFound } from '../../lib/errors.js';
import { fromUnits, min, percentOf, roundToMinor, toUnits } from '../../lib/money.js';
import { getSetting } from '../settings/registry.js';
import { post, systemAccount } from './ledger.js';

type EarningStatus = 'not_due' | 'under_review' | 'due' | 'on_hold_dispute' | 'ready_for_settlement' | 'settled' | 'settlement_failed' | 're_reviewed';

async function setStatus(c: Executor, id: string, from: string, to: EarningStatus, actorId: string | null, reason: string | null, extra = '') {
  await c.query(`UPDATE provider_earnings SET status = $2, status_reason = $3 ${extra} WHERE id = $1`, [id, to, reason]);
  await c.query('INSERT INTO provider_earning_events (earning_id, from_status, to_status, actor_id, reason) VALUES ($1, $2, $3, $4, $5)', [id, from, to, actorId, reason]);
}

/**
 * Amounts collected for a booking from succeeded payments, split by model. The platform amount is net
 * of refunds already approved out of customer advances, so later postings never count them twice.
 */
export async function collected(c: Executor, bookingId: string) {
  const r = (await c.query<{ platform: string; direct: string }>(
    `SELECT (coalesce(sum(a.verified_amount) FILTER (WHERE p.model = 'platform'), 0)
             - coalesce((SELECT sum(r.amount) FROM refunds r WHERE r.booking_id = $1 AND r.charge_to = 'customer_advances'
                           AND r.status IN ('approved', 'processing', 'completed')), 0))::numeric(20,4)::text AS platform,
            coalesce(sum(a.verified_amount) FILTER (WHERE p.model = 'direct'), 0)::numeric(20,4)::text AS direct
       FROM payment_allocations a JOIN payments p ON p.id = a.payment_id
      WHERE a.booking_id = $1 AND p.status = 'succeeded'`, [bookingId])).rows[0]!;
  return r;
}

/** What was already paid out to the provider early for a booking (interim settlements, clause 44). */
export async function interimPaid(c: Executor, bookingId: string): Promise<string> {
  return (await c.query<{ v: string }>(
    `SELECT coalesce(sum(i.amount), 0)::numeric(20,4)::text AS v FROM settlement_items i JOIN settlements s ON s.id = i.settlement_id
      WHERE i.booking_id = $1 AND s.kind = 'interim' AND i.status = 'paid'`, [bookingId])).rows[0]!.v;
}

/** Creates (once) and refreshes the earning record of a confirmed booking. */
export async function syncEarning(c: Executor, bookingId: string) {
  const b = (await c.query<{ provider_id: string; country_id: string; currency_code: string; total: string; discount_platform_borne: string }>(
    'SELECT provider_id, country_id, currency_code, total, discount_platform_borne FROM bookings WHERE id = $1', [bookingId])).rows[0]!;
  const commission = (await c.query<{ commission_amount: string }>('SELECT commission_amount FROM booking_commissions WHERE booking_id = $1', [bookingId])).rows[0]?.commission_amount ?? '0';
  const col = await collected(c, bookingId);
  // A discount borne by the platform is paid to the provider by the platform (clause 55: never taken from the provider).
  const net = fromUnits(toUnits(col.platform) + toUnits(b.discount_platform_borne) - toUnits(commission));
  const created = await c.query(
    `INSERT INTO provider_earnings (booking_id, provider_id, country_id, currency_code, booking_total, collected_by_platform, collected_directly, commission_amount, net_amount, platform_discount)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (booking_id) DO UPDATE SET collected_by_platform = EXCLUDED.collected_by_platform, collected_directly = EXCLUDED.collected_directly,
       net_amount = EXCLUDED.net_amount, platform_discount = EXCLUDED.platform_discount
     WHERE provider_earnings.status = 'not_due'
     RETURNING (xmax = 0) AS inserted, id`,
    [bookingId, b.provider_id, b.country_id, b.currency_code.trim(), b.total, col.platform, col.direct, commission, net, b.discount_platform_borne]);
  const row = created.rows[0] as { inserted: boolean; id: string } | undefined;
  if (row?.inserted) await c.query(`INSERT INTO provider_earning_events (earning_id, from_status, to_status) VALUES ($1, NULL, 'not_due')`, [row.id]);
}

/**
 * Service completed (clause 43): recognise commission revenue and move the provider's share out of
 * customer advances. Becomes due immediately, or after a staff review when the country requires it.
 */
export async function onBookingCompleted(c: Executor, bookingId: string, ctx: ActorContext) {
  await syncEarning(c, bookingId);
  const e = (await c.query<{ id: string; status: string; provider_id: string; country_id: string; currency_code: string; collected_by_platform: string; commission_amount: string; net_amount: string; platform_discount: string }>(
    'SELECT * FROM provider_earnings WHERE booking_id = $1 FOR UPDATE', [bookingId])).rows[0]!;
  if (e.status !== 'not_due') return;
  const review = await getSetting(c, 'earnings.require_review', e.country_id);
  const cur = e.currency_code.trim();
  const payable = await systemAccount(c, e.country_id, cur, review ? 'provider_payable_not_due' : 'provider_payable_due');
  // Amounts paid out early (interim) already left customer advances and reduce what is still owed.
  const early = toUnits(await interimPaid(c, bookingId));
  await post(c, {
    countryId: e.country_id, description: `Booking completed: recognise commission and provider share`, sourceType: 'booking_completion', sourceId: bookingId,
    idempotencyKey: `booking_completion:${bookingId}`, createdBy: ctx.actorId,
    lines: [
      { accountId: await systemAccount(c, e.country_id, cur, 'customer_advances'), debit: fromUnits(toUnits(e.collected_by_platform) - early), currency: cur, bookingId, providerId: e.provider_id },
      { accountId: await systemAccount(c, e.country_id, cur, 'platform_discount_cost'), debit: e.platform_discount, currency: cur, bookingId, providerId: e.provider_id },
      { accountId: await systemAccount(c, e.country_id, cur, 'commission_revenue'), credit: e.commission_amount, currency: cur, bookingId, providerId: e.provider_id },
      // Net may be negative when the provider was paid directly: then the provider owes the commission.
      { accountId: payable, credit: fromUnits(toUnits(e.net_amount) - early), currency: cur, bookingId, providerId: e.provider_id },
    ],
  });
  await setStatus(c, e.id, e.status, review ? 'under_review' : 'due', ctx.actorId, null, review ? '' : ', due_at = now()');
  await audit(c, ctx, { action: 'earning.recognised', entityType: 'provider_earning', entityId: e.id, after: { status: review ? 'under_review' : 'due', net: e.net_amount, commission: e.commission_amount } });
}

const CLOSABLE = ['no_show', 'rejected', 'expired', 'cancelled_by_customer', 'cancelled_by_provider', 'cancelled_by_admin'];

/**
 * Settles the money of a booking that ended without the service being delivered (cancelled, no-show,
 * rejected, expired) once no refund is still open. What the platform keeps after refunds (the retained
 * amount under the cancellation policy) is treated like delivered revenue: the booking's own commission
 * rule is applied to it and the rest becomes due to the provider. Interim payouts reduce what is owed;
 * if they exceed it, the provider owes the difference.
 */
export async function closeBookingFinancials(c: Executor, bookingId: string, ctx: ActorContext) {
  const b = (await c.query<{ status: string; provider_id: string; country_id: string; currency_code: string }>(
    'SELECT status, provider_id, country_id, currency_code FROM bookings WHERE id = $1', [bookingId])).rows[0]!;
  if (!CLOSABLE.includes(b.status)) return;
  const open = await c.query(`SELECT 1 FROM refunds WHERE booking_id = $1 AND status IN ('requested', 'approved', 'processing')`, [bookingId]);
  if (open.rowCount) return;
  const already = await c.query('SELECT 1 FROM journal_entries WHERE idempotency_key = $1', [`booking_closure:${bookingId}`]);
  if (already.rowCount) return;

  const col = await collected(c, bookingId);
  // Already net of refunds (none are open at this point).
  const retained = toUnits(col.platform);
  const early = toUnits(await interimPaid(c, bookingId));
  if (retained === 0n && early === 0n && toUnits(col.direct) === 0n) {
    // Nothing was kept or paid out: no earning to create.
    await c.query(`UPDATE provider_earnings SET status = 'settled', status_reason = 'nothing payable', net_amount = 0, commission_amount = 0 WHERE booking_id = $1 AND status = 'not_due'`, [bookingId]);
    return;
  }
  const cur = b.currency_code.trim();
  const minor = (await c.query<{ m: number }>('SELECT minor_units AS m FROM currencies WHERE code = $1', [cur])).rows[0]!.m;
  const rule = (await c.query<{ rate_type: string | null; rate_value: string | null }>('SELECT rate_type, rate_value FROM booking_commissions WHERE booking_id = $1', [bookingId])).rows[0];
  const base = retained + toUnits(col.direct);
  const commission = !rule?.rate_type || base <= 0n ? 0n
    : rule.rate_type === 'percent' ? roundToMinor(percentOf(base, rule.rate_value!), minor)
    : min(roundToMinor(toUnits(rule.rate_value!), minor), base);
  const net = retained - commission;

  await syncEarning(c, bookingId); // creates the earning row if the booking never got one
  const earning = (await c.query<{ id: string; status: string }>('SELECT id, status FROM provider_earnings WHERE booking_id = $1 FOR UPDATE', [bookingId])).rows[0]!;
  await post(c, {
    countryId: b.country_id, description: 'Booking closed without service: retained amount, commission and provider share', sourceType: 'booking_closure',
    sourceId: bookingId, idempotencyKey: `booking_closure:${bookingId}`, createdBy: ctx.actorId,
    lines: [
      { accountId: await systemAccount(c, b.country_id, cur, 'customer_advances'), debit: fromUnits(retained - early), currency: cur, bookingId, providerId: b.provider_id },
      { accountId: await systemAccount(c, b.country_id, cur, 'commission_revenue'), credit: fromUnits(commission), currency: cur, bookingId, providerId: b.provider_id },
      { accountId: await systemAccount(c, b.country_id, cur, 'provider_payable_due'), credit: fromUnits(net - early), currency: cur, bookingId, providerId: b.provider_id },
    ],
  });
  const remaining = net - early;
  // A platform-borne discount is only paid for a delivered service.
  await c.query('UPDATE provider_earnings SET commission_amount = $2, net_amount = $3, platform_discount = 0 WHERE id = $1', [earning.id, fromUnits(commission), fromUnits(net)]);
  await setStatus(c, earning.id, earning.status, remaining === 0n ? 'settled' : 'due', ctx.actorId,
    remaining === 0n ? 'closed: nothing left to settle' : `closed after ${b.status}`, remaining === 0n ? '' : ', due_at = now()');
  await audit(c, ctx, { action: 'booking.financials_closed', entityType: 'booking', entityId: bookingId, after: { retained: fromUnits(retained), commission: fromUnits(commission), net: fromUnits(net), interimPaid: fromUnits(early) } });
}

/** Staff approves a completed booking's earning under review: not-due payable becomes due. */
export async function approveEarningReview(c: Executor, earningId: string, ctx: ActorContext, note: string | null) {
  const e = (await c.query<{ id: string; status: string; booking_id: string; provider_id: string; country_id: string; currency_code: string; net_amount: string }>(
    'SELECT * FROM provider_earnings WHERE id = $1 FOR UPDATE', [earningId])).rows[0];
  if (!e) throw notFound();
  if (e.status !== 'under_review') throw conflict('INVALID_STATUS_TRANSITION', { from: e.status });
  const recognised = await c.query('SELECT 1 FROM journal_entries WHERE idempotency_key = $1', [`booking_completion:${e.booking_id}`]);
  // A no-show has nothing recognised yet; its financial outcome is decided in the refunds/settlement flow (phase 7).
  if (!recognised.rowCount) throw conflict('INVALID_STATUS_TRANSITION', { reason: 'no completed service to release' });
  const cur = e.currency_code.trim();
  await post(c, {
    countryId: e.country_id, description: 'Earning review approved', sourceType: 'earning_review', sourceId: e.id,
    idempotencyKey: `earning_review:${e.id}`, createdBy: ctx.actorId,
    lines: [
      { accountId: await systemAccount(c, e.country_id, cur, 'provider_payable_not_due'), debit: e.net_amount, currency: cur, bookingId: e.booking_id, providerId: e.provider_id },
      { accountId: await systemAccount(c, e.country_id, cur, 'provider_payable_due'), credit: e.net_amount, currency: cur, bookingId: e.booking_id, providerId: e.provider_id },
    ],
  });
  await setStatus(c, e.id, e.status, 'due', ctx.actorId, note, ', due_at = now()');
  await audit(c, ctx, { action: 'earning.review_approved', entityType: 'provider_earning', entityId: e.id, reason: note });
}
