import type { Config } from '../../config.js';
import type { Executor } from '../../db/pool.js';
import { audit, type ActorContext } from '../../lib/audit.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { fromUnits, min, toUnits } from '../../lib/money.js';
import { notifyUser } from '../../lib/notify.js';
import { closeBookingFinancials } from './earnings.js';
import { adapterFor, type IntegrationRow } from './gateways.js';
import { post, systemAccount } from './ledger.js';
import { issueRefundNote } from '../documents/service.js';

export type RefundSource = 'cancellation_policy' | 'provider_cancellation' | 'admin_cancellation' | 'no_show_policy' | 'slot_unavailable' | 'booking_cancelled' | 'manual' | 'dispute';

interface Refundable { paymentId: string; method: string; verified: bigint; refunded: bigint; available: bigint; succeededAt: Date }

/** Platform money received for a booking, per payment, and how much of it can still be refunded. */
export async function refundableFor(c: Executor, bookingId: string) {
  const rows = (await c.query<{ payment_id: string; method: string; verified: string; refunded: string; succeeded_at: Date }>(
    `SELECT p.id AS payment_id, p.method, a.verified_amount AS verified, p.succeeded_at,
            coalesce((SELECT sum(r.amount) FROM refunds r WHERE r.payment_id = p.id AND r.booking_id = a.booking_id AND r.status NOT IN ('rejected', 'failed')), 0)::text AS refunded
       FROM payment_allocations a JOIN payments p ON p.id = a.payment_id
      WHERE a.booking_id = $1 AND p.status = 'succeeded' AND p.model = 'platform' AND a.verified_amount > 0
      ORDER BY p.succeeded_at DESC`, [bookingId])).rows;
  const items: Refundable[] = rows.map((r) => {
    const verified = toUnits(r.verified);
    const refunded = toUnits(r.refunded);
    return { paymentId: r.payment_id, method: r.method, verified, refunded, available: verified - refunded, succeededAt: r.succeeded_at };
  });
  const direct = (await c.query<{ v: string }>(
    `SELECT coalesce(sum(a.verified_amount), 0)::text AS v FROM payment_allocations a JOIN payments p ON p.id = a.payment_id
      WHERE a.booking_id = $1 AND p.status = 'succeeded' AND p.model = 'direct'`, [bookingId])).rows[0]!.v;
  return {
    items,
    platformPaid: items.reduce((s, i) => s + i.verified, 0n),
    available: items.reduce((s, i) => s + i.available, 0n),
    directPaid: toUnits(direct),
  };
}

async function recordStatus(c: Executor, refundId: string, from: string | null, to: string, ctx: ActorContext, reason: string | null) {
  await c.query('INSERT INTO refund_status_events (refund_id, from_status, to_status, actor_id, actor_kind, reason) VALUES ($1, $2, $3, $4, $5, $6)',
    [refundId, from, to, ctx.actorId, ctx.actorKind, reason]);
}

const METHOD_FOR: Record<string, string> = { card: 'original_gateway', wallet: 'original_gateway', bank_transfer: 'bank_transfer', cash: 'cash' };

/**
 * Requests refunds totalling `amount` for a booking, split over its platform payments (latest first).
 * Requests still need approval and execution by authorised staff. Direct payments went to the provider
 * and cannot be refunded by the platform.
 */
export async function requestRefunds(c: Executor, bookingId: string, amount: string, source: RefundSource, reason: string, ctx: ActorContext) {
  let remaining = toUnits(amount);
  if (remaining <= 0n) return [];
  const r = await refundableFor(c, bookingId);
  if (remaining > r.available) throw badRequest('REFUND_EXCEEDS_REFUNDABLE', { requested: amount, refundable: fromUnits(r.available) });
  const currency = (await c.query<{ c: string }>('SELECT currency_code AS c FROM bookings WHERE id = $1', [bookingId])).rows[0]!.c.trim();
  const created: string[] = [];
  for (const item of r.items) {
    if (remaining === 0n) break;
    const take = min(remaining, item.available);
    if (take <= 0n) continue;
    remaining -= take;
    const id = (await c.query<{ id: string }>(
      `INSERT INTO refunds (booking_id, payment_id, amount, currency_code, source, reason, method, requested_by, requested_by_kind)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [bookingId, item.paymentId, fromUnits(take), currency, source, reason, METHOD_FOR[item.method] ?? 'bank_transfer', ctx.actorId, ctx.actorKind])).rows[0]!.id;
    await recordStatus(c, id, null, 'requested', ctx, reason);
    await audit(c, ctx, { action: 'refund.requested', entityType: 'refund', entityId: id, after: { bookingId, paymentId: item.paymentId, amount: fromUnits(take), source }, reason });
    created.push(id);
  }
  if (created.length) {
    const customerId = (await c.query<{ customer_id: string }>('SELECT customer_id FROM bookings WHERE id = $1', [bookingId])).rows[0]!.customer_id;
    const numbers = (await c.query<{ number: string }>('SELECT number FROM refunds WHERE id = ANY($1) ORDER BY number', [created])).rows.map((x) => x.number);
    await notifyCustomer(c, customerId, 'refund.requested', { bookingId, number: numbers.join(', '), amount: `${amount} ${currency}` });
  }
  return created;
}

interface RefundRow {
  id: string; number: string; booking_id: string; payment_id: string; amount: string; currency_code: string; status: string; method: string;
  requested_by: string | null; requested_by_kind: string; charge_to: 'customer_advances' | 'provider' | 'platform';
}

/** Where an approved refund is taken from: customer advances before revenue is recognised, else the provider's payable or the platform's commission. */
const SOURCE_ACCOUNT = { customer_advances: 'customer_advances', provider: 'provider_payable_due', platform: 'commission_revenue' } as const;

async function lockRefund(c: Executor, id: string) {
  const r = (await c.query<RefundRow & { country_id: string; provider_id: string; customer_id: string }>(
    `SELECT r.*, b.country_id, b.provider_id, b.customer_id FROM refunds r JOIN bookings b ON b.id = r.booking_id WHERE r.id = $1 FOR UPDATE OF r`, [id])).rows[0];
  if (!r) throw notFound();
  return r;
}

async function notifyCustomer(c: Executor, customerId: string, templateKey: string, payload: Record<string, unknown>) {
  await notifyUser(c, customerId, templateKey, payload);
}

/** Approval moves the amount from customer advances to refunds payable (2200 → 2300). Requester and approver must differ. */
export async function approveRefund(c: Executor, id: string, ctx: ActorContext) {
  const r = await lockRefund(c, id);
  if (r.status !== 'requested') throw conflict('INVALID_STATUS_TRANSITION', { from: r.status });
  if (r.requested_by_kind === 'staff' && r.requested_by === ctx.actorId) throw forbidden('FOUR_EYES_REQUIRED');
  const cur = r.currency_code.trim();
  await post(c, {
    countryId: r.country_id, description: `Refund approved ${r.number}`, sourceType: 'refund_approval', sourceId: r.id,
    idempotencyKey: `refund_approval:${r.id}`, createdBy: ctx.actorId,
    lines: [
      { accountId: await systemAccount(c, r.country_id, cur, SOURCE_ACCOUNT[r.charge_to]), debit: r.amount, currency: cur, bookingId: r.booking_id, providerId: r.provider_id, paymentId: r.payment_id },
      { accountId: await systemAccount(c, r.country_id, cur, 'refunds_payable'), credit: r.amount, currency: cur, bookingId: r.booking_id, providerId: r.provider_id, paymentId: r.payment_id },
    ],
  });
  await adjustEarning(c, r, 1n, ctx);
  await c.query(`UPDATE refunds SET status = 'approved', approved_by = $2, approved_at = now(), reviewed_by = coalesce(reviewed_by, $2) WHERE id = $1`, [id, ctx.actorId]);
  await recordStatus(c, id, r.status, 'approved', ctx, null);
  await audit(c, ctx, { action: 'refund.approved', entityType: 'refund', entityId: id, after: { amount: r.amount } });
  await notifyCustomer(c, r.customer_id, 'refund.approved', { refundId: id, number: r.number, amount: r.amount });
}

export async function rejectRefund(c: Executor, id: string, reason: string, ctx: ActorContext) {
  const r = await lockRefund(c, id);
  if (r.status !== 'requested') throw conflict('INVALID_STATUS_TRANSITION', { from: r.status });
  await c.query(`UPDATE refunds SET status = 'rejected', reviewed_by = $2, rejection_reason = $3 WHERE id = $1`, [id, ctx.actorId, reason]);
  await recordStatus(c, id, r.status, 'rejected', ctx, reason);
  await audit(c, ctx, { action: 'refund.rejected', entityType: 'refund', entityId: id, reason });
  await notifyCustomer(c, r.customer_id, 'refund.rejected', { refundId: id, number: r.number, reason });
  await closeBookingFinancials(c, r.booking_id, ctx);
}

/**
 * Executes an approved refund. Card/wallet refunds go back through the original gateway and finish on
 * its signed notification; bank transfers and cash are completed by staff with the transfer reference.
 */
export async function executeRefund(c: Executor, config: Config, id: string, externalRef: string | undefined, ctx: ActorContext) {
  const r = await lockRefund(c, id);
  if (r.status !== 'approved') throw conflict('INVALID_STATUS_TRANSITION', { from: r.status });
  if (r.method === 'original_gateway') {
    const p = (await c.query<{ integration_id: string; external_ref: string }>('SELECT integration_id, external_ref FROM payments WHERE id = $1', [r.payment_id])).rows[0]!;
    const i = (await c.query<IntegrationRow>('SELECT * FROM payment_integrations WHERE id = $1', [p.integration_id])).rows[0]!;
    const { adapter, secret } = adapterFor(i, config.NODE_ENV);
    const res = await adapter.refund(i, secret, { paymentRef: p.external_ref, refundId: r.id, amount: r.amount, currency: r.currency_code.trim() });
    await c.query(`UPDATE refunds SET status = 'processing', external_ref = $2, executed_by = $3 WHERE id = $1`, [id, res.externalRef, ctx.actorId]);
    await recordStatus(c, id, r.status, 'processing', ctx, null);
    await audit(c, ctx, { action: 'refund.sent_to_gateway', entityType: 'refund', entityId: id, after: { externalRef: res.externalRef } });
    return { status: 'processing' };
  }
  if (!externalRef) throw badRequest('VALIDATION_FAILED', [{ path: '/externalRef', message: 'the transfer or receipt reference is required' }]);
  await c.query(`UPDATE refunds SET status = 'processing', external_ref = $2, executed_by = $3 WHERE id = $1`, [id, externalRef, ctx.actorId]);
  await recordStatus(c, id, r.status, 'processing', ctx, null);
  await completeRefund(c, id, ctx);
  return { status: 'completed' };
}

/** Money has left the fund: refunds payable → fund (2300 → fund of the original payment). */
export async function completeRefund(c: Executor, id: string, ctx: ActorContext): Promise<{ changed: boolean }> {
  const r = await lockRefund(c, id);
  if (r.status === 'completed') return { changed: false };
  if (r.status !== 'processing') throw conflict('INVALID_STATUS_TRANSITION', { from: r.status });
  const fund = (await c.query<{ account_id: string }>('SELECT account_id FROM payments WHERE id = $1', [r.payment_id])).rows[0]!.account_id;
  const cur = r.currency_code.trim();
  await post(c, {
    countryId: r.country_id, description: `Refund paid ${r.number}`, sourceType: 'refund_payment', sourceId: r.id,
    idempotencyKey: `refund_payment:${r.id}`, createdBy: ctx.actorId,
    lines: [
      { accountId: await systemAccount(c, r.country_id, cur, 'refunds_payable'), debit: r.amount, currency: cur, bookingId: r.booking_id, providerId: r.provider_id, paymentId: r.payment_id },
      { accountId: fund, credit: r.amount, currency: cur, paymentId: r.payment_id },
    ],
  });
  await c.query(`UPDATE refunds SET status = 'completed', executed_at = now() WHERE id = $1`, [id]);
  await recordStatus(c, id, r.status, 'completed', ctx, null);
  await audit(c, ctx, { action: 'refund.completed', entityType: 'refund', entityId: id });
  await issueRefundNote(c, id);
  await notifyCustomer(c, r.customer_id, 'refund.completed', { refundId: id, number: r.number, amount: r.amount });
  await closeBookingFinancials(c, r.booking_id, ctx);
  return { changed: true };
}

/** The refund did not go through: reverse the approval entry so the money is back in customer advances. */
export async function failRefund(c: Executor, id: string, reason: string, ctx: ActorContext): Promise<{ changed: boolean }> {
  const r = await lockRefund(c, id);
  if (r.status === 'failed') return { changed: false };
  if (!['approved', 'processing'].includes(r.status)) throw conflict('INVALID_STATUS_TRANSITION', { from: r.status });
  const cur = r.currency_code.trim();
  // The approval entry stays as posted; a new reversing entry returns the amount to customer advances.
  await post(c, {
    countryId: r.country_id, description: `Refund failed ${r.number} (reversal)`, sourceType: 'refund_failure', sourceId: r.id,
    idempotencyKey: `refund_failure:${r.id}`, createdBy: ctx.actorId,
    lines: [
      { accountId: await systemAccount(c, r.country_id, cur, 'refunds_payable'), debit: r.amount, currency: cur, bookingId: r.booking_id, providerId: r.provider_id, paymentId: r.payment_id },
      { accountId: await systemAccount(c, r.country_id, cur, SOURCE_ACCOUNT[r.charge_to]), credit: r.amount, currency: cur, bookingId: r.booking_id, providerId: r.provider_id, paymentId: r.payment_id },
    ],
  });
  await adjustEarning(c, r, -1n, ctx);
  await c.query(`UPDATE refunds SET status = 'failed', failure_reason = $2 WHERE id = $1`, [id, reason]);
  await recordStatus(c, id, r.status, 'failed', ctx, reason);
  await audit(c, ctx, { action: 'refund.failed', entityType: 'refund', entityId: id, reason });
  await notifyCustomer(c, r.customer_id, 'refund.failed', { refundId: id, number: r.number, amount: r.amount, reason });
  // A failed refund is retried as a new request, so the booking stays open for that.
  return { changed: true };
}

/**
 * A refund charged to the provider lowers their net (a settled earning is reopened so the amount is
 * offset in the next settlement); charged to the platform it lowers the commission. sign = -1 undoes it.
 */
async function adjustEarning(c: Executor, r: RefundRow, sign: bigint, ctx: ActorContext) {
  if (r.charge_to === 'customer_advances') return;
  const e = (await c.query<{ id: string; status: string; net_amount: string; commission_amount: string }>('SELECT * FROM provider_earnings WHERE booking_id = $1 FOR UPDATE', [r.booking_id])).rows[0];
  if (!e) return;
  const delta = toUnits(r.amount) * sign;
  if (r.charge_to === 'provider') {
    await c.query('UPDATE provider_earnings SET net_amount = $2 WHERE id = $1', [e.id, fromUnits(toUnits(e.net_amount) - delta)]);
    if (sign > 0n && e.status === 'settled') {
      await c.query(`UPDATE provider_earnings SET status = 're_reviewed', status_reason = $2 WHERE id = $1`, [e.id, `refund ${r.number} charged to provider`]);
      await c.query(`INSERT INTO provider_earning_events (earning_id, from_status, to_status, actor_id, reason) VALUES ($1, 'settled', 're_reviewed', $2, $3)`, [e.id, ctx.actorId, r.number]);
    }
  } else {
    await c.query('UPDATE provider_earnings SET commission_amount = $2 WHERE id = $1', [e.id, fromUnits(toUnits(e.commission_amount) - delta)]);
  }
}

export function assertRefundAmount(amount: string) {
  if (toUnits(amount) <= 0n) throw new AppError('VALIDATION_FAILED', 400, [{ path: '/amount', message: 'must be positive' }]);
}
