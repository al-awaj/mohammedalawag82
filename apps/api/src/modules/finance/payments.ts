import type pg from 'pg';
import type { Config } from '../../config.js';
import { withTx, type Db, type Executor } from '../../db/pool.js';
import { audit, systemActor, type ActorContext } from '../../lib/audit.js';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors.js';
import { fromUnits, min, toUnits } from '../../lib/money.js';
import { enqueueMessage } from '../../lib/outbox.js';
import { confirmAfterPayment } from '../booking/service.js';
import { getSetting } from '../settings/registry.js';
import { syncEarning } from './earnings.js';
import { adapterFor, type IntegrationRow } from './gateways.js';
import { post, systemAccount } from './ledger.js';

export type Model = 'platform' | 'direct';
export type Method = 'card' | 'wallet' | 'bank_transfer' | 'cash';
export type Purpose = 'upfront' | 'balance';

interface PayableBooking {
  id: string; number: string; status: string; provider_id: string; service_type_id: string; total: string; upfront_amount: string;
  currency_code: string; paid: string; pending: string;
}

/** Bookings of an order with what is paid (verified) and what is tied up in payments still in progress. */
async function orderBookings(c: Executor, orderId: string, bookingIds?: string[]) {
  return (await c.query<PayableBooking>(
    `SELECT b.id, b.number, b.status, b.provider_id, s.service_type_id, b.total, b.upfront_amount, b.currency_code,
            coalesce((SELECT sum(a.verified_amount) FROM payment_allocations a JOIN payments p ON p.id = a.payment_id
                       WHERE a.booking_id = b.id AND p.status = 'succeeded'), 0)::numeric(20,4)::text AS paid,
            coalesce((SELECT sum(a.amount) FROM payment_allocations a JOIN payments p ON p.id = a.payment_id
                       WHERE a.booking_id = b.id AND p.status IN ('pending', 'awaiting_verification')), 0)::numeric(20,4)::text AS pending
       FROM bookings b JOIN services s ON s.id = b.service_id
      WHERE b.order_id = $1 AND ($2::uuid[] IS NULL OR b.id = ANY($2)) ORDER BY b.start_at, b.id`,
    [orderId, bookingIds ?? null])).rows;
}

/** What still has to be paid for a booking for the given purpose (0 if nothing is due now). */
function dueFor(b: PayableBooking, purpose: Purpose): bigint {
  const paid = toUnits(b.paid);
  if (purpose === 'upfront') {
    if (b.status !== 'awaiting_payment') return 0n;
    const d = toUnits(b.upfront_amount) - paid;
    return d > 0n ? d : 0n;
  }
  if (!['confirmed', 'in_progress'].includes(b.status)) return 0n;
  const d = toUnits(b.total) - paid;
  return d > 0n ? d : 0n;
}

interface RuleRow { id: string; service_type_id: string | null; model: Model; method: Method; integration_id: string | null; account_id: string | null; proof_required: boolean }

/**
 * The single rule that covers every booking for a model and method. A type-specific rule beats the
 * country-wide one. All bookings must resolve to the same rule so one payment lands in one fund (clause 38).
 */
async function resolveRule(c: Executor, countryId: string, bookings: PayableBooking[], model: Model, method: Method): Promise<RuleRow | null> {
  const enabled = await getSetting(c, model === 'platform' ? 'payments.platform_enabled' : 'payments.direct_enabled', countryId);
  if (!enabled) return null;
  const rules = (await c.query<RuleRow>(
    `SELECT r.id, r.service_type_id, r.model, r.method, r.integration_id, r.account_id, r.proof_required
       FROM payment_method_rules r
       LEFT JOIN payment_integrations i ON i.id = r.integration_id
       LEFT JOIN ledger_accounts a ON a.id = r.account_id
      WHERE r.country_id = $1 AND r.model = $2 AND r.method = $3 AND r.is_active
        AND (r.integration_id IS NULL OR i.is_active) AND (r.account_id IS NULL OR a.is_active)`, [countryId, model, method])).rows;
  let chosen: RuleRow | null = null;
  for (const b of bookings) {
    const r = rules.find((x) => x.service_type_id === b.service_type_id) ?? rules.find((x) => x.service_type_id === null);
    if (!r || (chosen && chosen.id !== r.id)) return null;
    chosen = r;
  }
  if (model === 'direct' && new Set(bookings.map((b) => b.provider_id)).size > 1) return null; // paid to one provider at a time
  return chosen;
}

async function loadOrder(c: Executor, orderId: string, customerId: string) {
  const o = (await c.query<{ id: string; country_id: string; currency_code: string; customer_id: string }>('SELECT id, country_id, currency_code, customer_id FROM orders WHERE id = $1', [orderId])).rows[0];
  if (!o || o.customer_id !== customerId) throw notFound();
  return o;
}

export async function paymentOptions(db: Db, orderId: string, customerId: string) {
  const o = await loadOrder(db, orderId, customerId);
  const all = await orderBookings(db, orderId);
  const rules = (await db.query<{ model: Model; method: Method }>(
    'SELECT DISTINCT model, method FROM payment_method_rules WHERE country_id = $1 AND is_active ORDER BY model, method', [o.country_id])).rows;
  const options = [];
  for (const purpose of ['upfront', 'balance'] as const) {
    const due = all.filter((b) => dueFor(b, purpose) > 0n);
    if (!due.length) continue;
    for (const { model, method } of rules) {
      // Direct payments go to one provider: offer them per provider group.
      const groups = model === 'direct' ? [...new Set(due.map((b) => b.provider_id))].map((p) => due.filter((b) => b.provider_id === p)) : [due];
      for (const g of groups) {
        const rule = await resolveRule(db, o.country_id, g, model, method);
        if (!rule) continue;
        options.push({
          purpose, model, method, proofRequired: rule.proof_required, currency: o.currency_code.trim(),
          bookingIds: g.map((b) => b.id), amount: fromUnits(g.reduce((s, b) => s + dueFor(b, purpose), 0n)),
        });
      }
    }
  }
  return options;
}

async function recordStatus(c: Executor, paymentId: string, from: string | null, to: string, ctx: ActorContext, reason: string | null) {
  await c.query('INSERT INTO payment_status_events (payment_id, from_status, to_status, actor_id, actor_kind, reason) VALUES ($1, $2, $3, $4, $5, $6)',
    [paymentId, from, to, ctx.actorId, ctx.actorKind, reason]);
}

export interface CreatePaymentInput {
  orderId: string; customerId: string; model: Model; method: Method; purpose: Purpose; bookingIds?: string[] | undefined;
  reportedAmount?: string | undefined; idempotencyKey: string;
}

/**
 * Starts a payment. Amounts are computed by the server from what is due — never taken from the client.
 * A booking cannot have two payments in progress, and the idempotency key makes retries return the same payment.
 */
export async function createPayment(db: Db, config: Config, input: CreatePaymentInput, ctx: ActorContext) {
  const prior = (await db.query<{ id: string }>('SELECT id FROM payments WHERE customer_id = $1 AND idempotency_key = $2', [input.customerId, input.idempotencyKey])).rows[0];
  if (prior) return { paymentId: prior.id, replayed: true };

  return withTx(db, async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`pay:${input.orderId}`]);
    const again = (await c.query<{ id: string }>('SELECT id FROM payments WHERE customer_id = $1 AND idempotency_key = $2', [input.customerId, input.idempotencyKey])).rows[0];
    if (again) return { paymentId: again.id, replayed: true };

    const o = await loadOrder(c, input.orderId, input.customerId);
    const candidates = await orderBookings(c, input.orderId, input.bookingIds);
    if (input.bookingIds && candidates.length !== new Set(input.bookingIds).size) throw notFound();
    const busy = candidates.filter((b) => toUnits(b.pending) > 0n);
    if (busy.length) throw conflict('PAYMENT_IN_PROGRESS', { bookings: busy.map((b) => b.number) });
    const due = candidates.filter((b) => dueFor(b, input.purpose) > 0n);
    if (!due.length) throw conflict('NOTHING_TO_PAY');

    const rule = await resolveRule(c, o.country_id, due, input.model, input.method);
    if (!rule) throw badRequest('PAYMENT_METHOD_NOT_AVAILABLE');
    const amount = due.reduce((s, b) => s + dueFor(b, input.purpose), 0n);
    const gateway = input.model === 'platform' && (input.method === 'card' || input.method === 'wallet');
    const status = gateway ? 'pending' : 'awaiting_verification';
    const reported = input.reportedAmount ? toUnits(input.reportedAmount) : amount;
    if (reported <= 0n) throw badRequest('VALIDATION_FAILED', [{ path: '/reportedAmount', message: 'must be positive' }]);

    const p = (await c.query<{ id: string; number: string }>(
      `INSERT INTO payments (order_id, customer_id, country_id, provider_id, rule_id, model, method, integration_id, account_id, purpose, amount, currency_code,
                             reported_amount, status, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING id, number`,
      [o.id, input.customerId, o.country_id, input.model === 'direct' ? due[0]!.provider_id : null, rule.id, input.model, input.method,
        rule.integration_id, rule.account_id, input.purpose, fromUnits(amount), o.currency_code.trim(), gateway ? null : fromUnits(reported), status,
        input.idempotencyKey])).rows[0]!;
    for (const b of due) {
      await c.query('INSERT INTO payment_allocations (payment_id, booking_id, amount) VALUES ($1, $2, $3)', [p.id, b.id, fromUnits(dueFor(b, input.purpose))]);
    }
    await recordStatus(c, p.id, null, status, ctx, null);

    if (gateway) {
      const i = (await c.query<IntegrationRow>('SELECT * FROM payment_integrations WHERE id = $1', [rule.integration_id])).rows[0]!;
      const { adapter, secret } = adapterFor(i, config.NODE_ENV);
      const session = await adapter.createCheckout(i, secret, { paymentId: p.id, number: p.number, amount: fromUnits(amount), currency: o.currency_code.trim() });
      await c.query('UPDATE payments SET external_ref = $2, checkout_url = $3 WHERE id = $1', [p.id, session.externalRef, session.checkoutUrl]);
    }
    await audit(c, ctx, { action: 'payment.created', entityType: 'payment', entityId: p.id, after: { number: p.number, model: input.model, method: input.method, purpose: input.purpose, amount: fromUnits(amount) } });
    return { paymentId: p.id, replayed: false };
  });
}

interface PaymentRow {
  id: string; number: string; order_id: string; customer_id: string; country_id: string; provider_id: string | null; model: Model; method: Method;
  account_id: string | null; amount: string; currency_code: string; status: string; purpose: Purpose; gateway_fee: string; rule_id: string;
}

async function lockPayment(c: Executor, id: string): Promise<PaymentRow> {
  const p = (await c.query<PaymentRow>('SELECT * FROM payments WHERE id = $1 FOR UPDATE', [id])).rows[0];
  if (!p) throw notFound();
  return p;
}

/**
 * Records a verified payment. Verified money is allocated to bookings in order, posted to the ledger
 * once, and bookings whose upfront amount is covered are confirmed. Safe to call twice: a payment that
 * already succeeded is left untouched (duplicate notices, clause 36).
 */
export async function markSucceeded(c: pg.PoolClient, paymentId: string, verified: string, fee: string, ctx: ActorContext): Promise<{ changed: boolean }> {
  const p = await lockPayment(c, paymentId);
  if (p.status === 'succeeded') return { changed: false };
  if (!['pending', 'awaiting_verification'].includes(p.status)) throw conflict('INVALID_STATUS_TRANSITION', { from: p.status });
  let remaining = toUnits(verified);
  if (remaining <= 0n || remaining > toUnits(p.amount)) throw badRequest('VALIDATION_FAILED', [{ path: '/verifiedAmount', message: 'must be > 0 and <= the payment amount' }]);

  const allocs = (await c.query<{ booking_id: string; amount: string; provider_id: string }>(
    `SELECT a.booking_id, a.amount, b.provider_id FROM payment_allocations a JOIN bookings b ON b.id = a.booking_id
      WHERE a.payment_id = $1 ORDER BY b.start_at, b.id`, [p.id])).rows;
  const applied: { bookingId: string; providerId: string; amount: bigint }[] = [];
  for (const a of allocs) {
    const take = min(remaining, toUnits(a.amount));
    remaining -= take;
    await c.query('UPDATE payment_allocations SET verified_amount = $3 WHERE payment_id = $1 AND booking_id = $2', [p.id, a.booking_id, fromUnits(take)]);
    if (take > 0n) applied.push({ bookingId: a.booking_id, providerId: a.provider_id, amount: take });
  }
  await c.query(`UPDATE payments SET status = 'succeeded', verified_amount = $2, gateway_fee = $3, succeeded_at = now() WHERE id = $1`, [p.id, verified, fee]);
  await recordStatus(c, p.id, p.status, 'succeeded', ctx, null);

  // ---- Ledger (docs/05-financial-design.md §3-4)
  const cur = p.currency_code.trim();
  const lines = p.model === 'platform'
    ? [
        { accountId: p.account_id!, debit: fromUnits(toUnits(verified) - toUnits(fee)), currency: cur, paymentId: p.id },
        // Provider fees are an expense of the platform, never booked as commission (clause 41.6).
        { accountId: await systemAccount(c, p.country_id, cur, 'gateway_fees'), debit: fee, currency: cur, paymentId: p.id },
        ...await Promise.all(applied.map(async (x) => ({ accountId: await systemAccount(c, p.country_id, cur, 'customer_advances'), credit: fromUnits(x.amount), currency: cur, paymentId: p.id, bookingId: x.bookingId, providerId: x.providerId }))),
      ]
    : (await Promise.all(applied.map(async (x) => [
        { accountId: await systemAccount(c, p.country_id, cur, 'direct_payments_memo'), debit: fromUnits(x.amount), currency: cur, paymentId: p.id, bookingId: x.bookingId, providerId: x.providerId },
        { accountId: await systemAccount(c, p.country_id, cur, 'direct_payments_memo_contra'), credit: fromUnits(x.amount), currency: cur, paymentId: p.id, bookingId: x.bookingId, providerId: x.providerId },
      ]))).flat();
  await post(c, {
    countryId: p.country_id, description: `${p.model === 'platform' ? 'Payment received' : 'Direct payment to provider verified'} ${p.number}`,
    sourceType: 'payment', sourceId: p.id, idempotencyKey: `payment:${p.id}`, createdBy: ctx.actorId, lines,
  });

  // ---- Bookings: confirm those whose upfront amount is now covered.
  for (const x of applied) {
    const b = (await c.query<{ status: string; upfront_amount: string; number: string }>('SELECT status, upfront_amount, number FROM bookings WHERE id = $1', [x.bookingId])).rows[0]!;
    const paid = (await c.query<{ v: string }>(
      `SELECT coalesce(sum(a.verified_amount), 0)::text AS v FROM payment_allocations a JOIN payments p ON p.id = a.payment_id
        WHERE a.booking_id = $1 AND p.status = 'succeeded'`, [x.bookingId])).rows[0]!.v;
    if ((b.status === 'awaiting_payment' || b.status === 'expired') && toUnits(paid) >= toUnits(b.upfront_amount)) {
      await c.query('SAVEPOINT confirm');
      try {
        await confirmAfterPayment(c, x.bookingId, ctx);
        await c.query('RELEASE SAVEPOINT confirm');
      } catch (err) {
        await c.query('ROLLBACK TO SAVEPOINT confirm');
        if (!(err instanceof AppError) || err.code !== 'SLOT_UNAVAILABLE') throw err;
        // Money arrived after the slot was lost: flag for the refund process (phase 7); never confirm an unavailable slot.
        await c.query(`UPDATE payments SET needs_attention = 'slot_unavailable_after_payment' WHERE id = $1`, [p.id]);
      }
    }
    const confirmed = (await c.query<{ status: string }>('SELECT status FROM bookings WHERE id = $1', [x.bookingId])).rows[0]!.status;
    if (['confirmed', 'in_progress', 'completed'].includes(confirmed)) await syncEarning(c, x.bookingId);
    // Paid for a booking that was cancelled or rejected meanwhile: flag it for the refund process (phase 7).
    if (['rejected', 'cancelled_by_customer', 'cancelled_by_provider', 'cancelled_by_admin'].includes(confirmed)) {
      await c.query(`UPDATE payments SET needs_attention = coalesce(needs_attention, 'booking_cancelled_after_payment') WHERE id = $1`, [p.id]);
    }
  }
  await audit(c, ctx, { action: 'payment.succeeded', entityType: 'payment', entityId: p.id, after: { verified, fee } });
  await notifyCustomer(c, p, 'payment.succeeded', { amount: verified });
  return { changed: true };
}

export async function markFailed(c: Executor, paymentId: string, reason: string, ctx: ActorContext): Promise<{ changed: boolean }> {
  const p = await lockPayment(c, paymentId);
  if (p.status === 'failed' || p.status === 'cancelled' || p.status === 'succeeded') return { changed: false };
  await c.query(`UPDATE payments SET status = 'failed', failure_reason = $2 WHERE id = $1`, [p.id, reason]);
  await recordStatus(c, p.id, p.status, 'failed', ctx, reason);
  await audit(c, ctx, { action: 'payment.failed', entityType: 'payment', entityId: p.id, reason });
  await notifyCustomer(c, p, 'payment.failed', { reason });
  return { changed: true };
}

async function notifyCustomer(c: Executor, p: PaymentRow, templateKey: string, payload: Record<string, unknown>) {
  const u = (await c.query<{ phone: string | null; preferred_language: string }>('SELECT phone, preferred_language FROM users WHERE id = $1', [p.customer_id])).rows[0];
  if (u?.phone) await enqueueMessage(c, { channel: 'sms', recipientUserId: p.customer_id, target: u.phone, templateKey, language: u.preferred_language, payload: { paymentId: p.id, number: p.number, ...payload } });
}

/**
 * Provider notification (webhook). The signature is verified first; every delivery is stored; a
 * redelivered event id is answered without reprocessing; amounts that do not match go to staff review.
 */
export async function handleWebhook(db: Db, config: Config, integrationId: string, raw: Buffer, headers: Record<string, string | string[] | undefined>) {
  const i = (await db.query<IntegrationRow>('SELECT * FROM payment_integrations WHERE id = $1', [integrationId])).rows[0];
  if (!i) throw notFound();
  const { adapter, secret } = adapterFor(i, config.NODE_ENV);
  let parsed: ReturnType<typeof adapter.parseWebhook>;
  try {
    parsed = adapter.parseWebhook(i, secret, raw, headers);
  } catch {
    parsed = { valid: false, event: null };
  }
  let payload: unknown;
  try { payload = JSON.parse(raw.toString('utf8')); } catch { payload = { raw: raw.toString('base64').slice(0, 10_000) }; }

  if (!parsed.valid || !parsed.event) {
    await db.query(
      `INSERT INTO provider_webhook_events (integration_id, external_event_id, signature_valid, payload, result, error)
       VALUES ($1, $2, false, $3, 'rejected', 'invalid signature')`, [i.id, `invalid:${crypto.randomUUID()}`, JSON.stringify(payload)]);
    throw new AppError('WEBHOOK_SIGNATURE_INVALID', 401);
  }
  const ev = parsed.event;
  return withTx(db, async (c) => {
    const ins = await c.query(
      `INSERT INTO provider_webhook_events (integration_id, external_event_id, event_type, external_ref, signature_valid, payload, result)
       VALUES ($1, $2, $3, $4, true, $5, 'processed') ON CONFLICT (integration_id, external_event_id) DO NOTHING RETURNING id`,
      [i.id, ev.id, ev.type, ev.externalRef, JSON.stringify(payload)]);
    if (!ins.rowCount) {
      await c.query(
        `INSERT INTO provider_webhook_events (integration_id, external_event_id, event_type, external_ref, signature_valid, payload, result)
         VALUES ($1, $2, $3, $4, true, $5, 'duplicate')`, [i.id, `${ev.id}#dup:${crypto.randomUUID()}`, ev.type, ev.externalRef, JSON.stringify(payload)]);
      return { result: 'duplicate' };
    }
    const eventRowId = (ins.rows[0] as { id: string }).id;
    const setResult = (result: string, error: string | null = null) =>
      c.query('UPDATE provider_webhook_events SET result = $2, error = $3 WHERE id = $1', [eventRowId, result, error]);

    const p = (await c.query<{ id: string; amount: string; currency_code: string; status: string }>(
      'SELECT id, amount, currency_code, status FROM payments WHERE integration_id = $1 AND external_ref = $2', [i.id, ev.externalRef])).rows[0];
    if (!p) { await setResult('ignored', 'unknown payment reference'); return { result: 'ignored' }; }
    const ctx: ActorContext = { ...systemActor, requestId: `webhook:${ev.id}` };

    if (ev.type === 'payment.succeeded') {
      if (toUnits(ev.amount) !== toUnits(p.amount) || ev.currency !== p.currency_code.trim()) {
        // Never auto-confirm a mismatch: hand it to a payment reviewer (clause 36: unmatched operations).
        const moved = await c.query(`UPDATE payments SET status = 'awaiting_verification', reported_amount = $2, needs_attention = 'amount_mismatch' WHERE id = $1 AND status = 'pending'`, [p.id, ev.amount]);
        if (moved.rowCount) await recordStatus(c, p.id, p.status, 'awaiting_verification', ctx, `provider reported ${ev.amount} ${ev.currency}`);
        await setResult('processed', 'amount or currency mismatch: sent to review');
        return { result: 'review' };
      }
      const r = await markSucceeded(c, p.id, ev.amount, ev.fee, ctx);
      if (!r.changed) await setResult('duplicate', 'payment already succeeded');
      return { result: r.changed ? 'processed' : 'duplicate' };
    }
    if (ev.type === 'payment.failed') {
      const r = await markFailed(c, p.id, ev.failureReason ?? 'declined by provider', ctx);
      if (!r.changed) await setResult('ignored', `payment is ${p.status}`);
      return { result: r.changed ? 'processed' : 'ignored' };
    }
    await setResult('ignored', `unhandled event type ${ev.type}`);
    return { result: 'ignored' };
  });
}

/** Staff decision on a proof / manual payment (clause 33: reviewer and verified amount recorded). */
export async function reviewPayment(db: Db, paymentId: string, decision: 'approve' | 'reject', verifiedAmount: string | undefined, note: string, ctx: ActorContext) {
  return withTx(db, async (c) => {
    const p = await lockPayment(c, paymentId);
    if (p.status !== 'awaiting_verification') throw conflict('INVALID_STATUS_TRANSITION', { from: p.status });
    if (decision === 'reject') {
      await markFailed(c, p.id, note, ctx);
      await c.query('UPDATE payments SET verified_by = $2, verified_at = now(), review_note = $3 WHERE id = $1', [p.id, ctx.actorId, note]);
      return { status: 'failed' };
    }
    const rule = (await c.query<{ proof_required: boolean }>('SELECT proof_required FROM payment_method_rules WHERE id = $1', [p.rule_id])).rows[0]!;
    if (rule.proof_required) {
      const proofs = await c.query('SELECT 1 FROM payment_proofs WHERE payment_id = $1', [p.id]);
      if (!proofs.rowCount) throw conflict('PROOF_REQUIRED');
    }
    await c.query('UPDATE payments SET verified_by = $2, verified_at = now(), review_note = $3 WHERE id = $1', [p.id, ctx.actorId, note]);
    await markSucceeded(c, p.id, verifiedAmount ?? p.amount, '0', ctx);
    return { status: 'succeeded' };
  });
}

export async function cancelPayment(db: Db, paymentId: string, customerId: string, ctx: ActorContext) {
  return withTx(db, async (c) => {
    const p = await lockPayment(c, paymentId);
    if (p.customer_id !== customerId) throw notFound();
    if (!['pending', 'awaiting_verification'].includes(p.status)) throw conflict('INVALID_STATUS_TRANSITION', { from: p.status });
    await c.query(`UPDATE payments SET status = 'cancelled' WHERE id = $1`, [p.id]);
    await recordStatus(c, p.id, p.status, 'cancelled', ctx, 'cancelled by customer');
    await audit(c, ctx, { action: 'payment.cancelled', entityType: 'payment', entityId: p.id });
    return { status: 'cancelled' };
  });
}
