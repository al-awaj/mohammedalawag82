import type { Executor } from '../../db/pool.js';
import { audit, type ActorContext } from '../../lib/audit.js';
import { conflict, notFound } from '../../lib/errors.js';
import { fromUnits, toUnits } from '../../lib/money.js';
import { getSetting } from '../settings/registry.js';
import { post, systemAccount } from './ledger.js';

type EarningStatus = 'not_due' | 'under_review' | 'due' | 'on_hold_dispute' | 'ready_for_settlement' | 'settled' | 'settlement_failed' | 're_reviewed';

async function setStatus(c: Executor, id: string, from: string, to: EarningStatus, actorId: string | null, reason: string | null, extra = '') {
  await c.query(`UPDATE provider_earnings SET status = $2, status_reason = $3 ${extra} WHERE id = $1`, [id, to, reason]);
  await c.query('INSERT INTO provider_earning_events (earning_id, from_status, to_status, actor_id, reason) VALUES ($1, $2, $3, $4, $5)', [id, from, to, actorId, reason]);
}

/** Amounts collected for a booking from succeeded payments, split by model. */
export async function collected(c: Executor, bookingId: string) {
  const r = (await c.query<{ platform: string; direct: string }>(
    `SELECT coalesce(sum(a.verified_amount) FILTER (WHERE p.model = 'platform'), 0)::numeric(20,4)::text AS platform,
            coalesce(sum(a.verified_amount) FILTER (WHERE p.model = 'direct'), 0)::numeric(20,4)::text AS direct
       FROM payment_allocations a JOIN payments p ON p.id = a.payment_id
      WHERE a.booking_id = $1 AND p.status = 'succeeded'`, [bookingId])).rows[0]!;
  return r;
}

/** Creates (once) and refreshes the earning record of a confirmed booking. */
export async function syncEarning(c: Executor, bookingId: string) {
  const b = (await c.query<{ provider_id: string; country_id: string; currency_code: string; total: string }>(
    'SELECT provider_id, country_id, currency_code, total FROM bookings WHERE id = $1', [bookingId])).rows[0]!;
  const commission = (await c.query<{ commission_amount: string }>('SELECT commission_amount FROM booking_commissions WHERE booking_id = $1', [bookingId])).rows[0]?.commission_amount ?? '0';
  const col = await collected(c, bookingId);
  const net = fromUnits(toUnits(col.platform) - toUnits(commission));
  const created = await c.query(
    `INSERT INTO provider_earnings (booking_id, provider_id, country_id, currency_code, booking_total, collected_by_platform, collected_directly, commission_amount, net_amount)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (booking_id) DO UPDATE SET collected_by_platform = EXCLUDED.collected_by_platform, collected_directly = EXCLUDED.collected_directly,
       net_amount = EXCLUDED.net_amount
     WHERE provider_earnings.status = 'not_due'
     RETURNING (xmax = 0) AS inserted, id`,
    [bookingId, b.provider_id, b.country_id, b.currency_code.trim(), b.total, col.platform, col.direct, commission, net]);
  const row = created.rows[0] as { inserted: boolean; id: string } | undefined;
  if (row?.inserted) await c.query(`INSERT INTO provider_earning_events (earning_id, from_status, to_status) VALUES ($1, NULL, 'not_due')`, [row.id]);
}

/**
 * Service completed (clause 43): recognise commission revenue and move the provider's share out of
 * customer advances. Becomes due immediately, or after a staff review when the country requires it.
 */
export async function onBookingCompleted(c: Executor, bookingId: string, ctx: ActorContext) {
  await syncEarning(c, bookingId);
  const e = (await c.query<{ id: string; status: string; provider_id: string; country_id: string; currency_code: string; collected_by_platform: string; commission_amount: string; net_amount: string }>(
    'SELECT * FROM provider_earnings WHERE booking_id = $1 FOR UPDATE', [bookingId])).rows[0]!;
  if (e.status !== 'not_due') return;
  const review = await getSetting(c, 'earnings.require_review', e.country_id);
  const cur = e.currency_code.trim();
  const payable = await systemAccount(c, e.country_id, cur, review ? 'provider_payable_not_due' : 'provider_payable_due');
  await post(c, {
    countryId: e.country_id, description: `Booking completed: recognise commission and provider share`, sourceType: 'booking_completion', sourceId: bookingId,
    idempotencyKey: `booking_completion:${bookingId}`, createdBy: ctx.actorId,
    lines: [
      { accountId: await systemAccount(c, e.country_id, cur, 'customer_advances'), debit: e.collected_by_platform, currency: cur, bookingId, providerId: e.provider_id },
      { accountId: await systemAccount(c, e.country_id, cur, 'commission_revenue'), credit: e.commission_amount, currency: cur, bookingId, providerId: e.provider_id },
      // Net may be negative when the provider was paid directly: then the provider owes the commission.
      { accountId: payable, credit: e.net_amount, currency: cur, bookingId, providerId: e.provider_id },
    ],
  });
  await setStatus(c, e.id, e.status, review ? 'under_review' : 'due', ctx.actorId, null, review ? '' : ', due_at = now()');
  await audit(c, ctx, { action: 'earning.recognised', entityType: 'provider_earning', entityId: e.id, after: { status: review ? 'under_review' : 'due', net: e.net_amount, commission: e.commission_amount } });
}

/** No-show outcomes need a human decision before any money moves. */
export async function onBookingNoShow(c: Executor, bookingId: string, ctx: ActorContext) {
  await syncEarning(c, bookingId);
  const e = (await c.query<{ id: string; status: string }>('SELECT id, status FROM provider_earnings WHERE booking_id = $1 FOR UPDATE', [bookingId])).rows[0]!;
  if (e.status === 'not_due') await setStatus(c, e.id, e.status, 'under_review', ctx.actorId, 'customer no-show: needs a financial decision');
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
