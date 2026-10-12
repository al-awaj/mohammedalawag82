import type { Executor } from '../../db/pool.js';
import { audit, type ActorContext } from '../../lib/audit.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { fromUnits, percentOf, toUnits } from '../../lib/money.js';
import { enqueueMessage } from '../../lib/outbox.js';
import { post, systemAccount } from './ledger.js';

interface EligibleRow { earning_id: string; booking_id: string; booking_number: string; net: string; settled: string; status: string }

/**
 * Earnings that can be settled now for a provider in a currency: due (or a failed earlier attempt),
 * not in another open settlement, with what is still owed after earlier payouts. Negative remainders are
 * what the provider owes (e.g. commission on direct payments) and are offset in the same settlement.
 */
export async function eligibleEarnings(c: Executor, providerId: string, currency: string, lock = false) {
  const rows = (await c.query<EligibleRow>(
    `SELECT e.id AS earning_id, e.booking_id, b.number AS booking_number, e.net_amount AS net, e.status,
            coalesce((SELECT sum(i.amount) FROM settlement_items i WHERE i.earning_id = e.id AND i.status = 'paid'), 0)::numeric(20,4)::text AS settled
       FROM provider_earnings e JOIN bookings b ON b.id = e.booking_id
      WHERE e.provider_id = $1 AND e.currency_code = $2 AND e.status IN ('due', 'settlement_failed')
        AND NOT EXISTS (SELECT 1 FROM settlement_items i WHERE i.earning_id = e.id AND i.status = 'pending')
      ORDER BY e.due_at NULLS LAST, e.created_at ${lock ? 'FOR UPDATE OF e' : ''}`, [providerId, currency])).rows;
  const items = rows.map((r) => ({ earningId: r.earning_id, bookingId: r.booking_id, bookingNumber: r.booking_number, amount: toUnits(r.net) - toUnits(r.settled) }))
    .filter((i) => i.amount !== 0n);
  return { items, total: items.reduce((s, i) => s + i.amount, 0n) };
}

async function assertFund(c: Executor, accountId: string, countryId: string, currency: string) {
  const a = (await c.query<{ country_id: string; currency_code: string; kind: string; is_active: boolean }>('SELECT * FROM ledger_accounts WHERE id = $1', [accountId])).rows[0];
  if (!a || a.country_id !== countryId || a.currency_code.trim() !== currency || !['cash', 'bank', 'wallet'].includes(a.kind) || !a.is_active) {
    throw badRequest('INVALID_REFERENCE', { field: 'accountId', reason: 'an active cash, bank or wallet fund of the same country and currency is required' });
  }
}

async function recordStatus(c: Executor, id: string, from: string | null, to: string, ctx: ActorContext, reason: string | null) {
  await c.query('INSERT INTO settlement_status_events (settlement_id, from_status, to_status, actor_id, reason) VALUES ($1, $2, $3, $4, $5)', [id, from, to, ctx.actorId, reason]);
}

async function earningStatus(c: Executor, earningId: string, to: string, ctx: ActorContext, reason: string | null) {
  const from = (await c.query<{ status: string }>('SELECT status FROM provider_earnings WHERE id = $1', [earningId])).rows[0]!.status;
  if (from === to) return;
  await c.query('UPDATE provider_earnings SET status = $2, status_reason = $3 WHERE id = $1', [earningId, to, reason]);
  await c.query('INSERT INTO provider_earning_events (earning_id, from_status, to_status, actor_id, reason) VALUES ($1, $2, $3, $4, $5)', [earningId, from, to, ctx.actorId, reason]);
}

export interface CreateSettlementInput {
  providerId: string; currency: string; accountId: string; method: 'bank_transfer' | 'cash' | 'wallet';
  kind: 'regular' | 'interim'; bookingId?: string | undefined; amount?: string | undefined; notes?: string | undefined;
}

/** Prepares a settlement for approval. Amounts come from the earnings, never from free input (except the interim amount within its cap). */
export async function createSettlement(c: Executor, input: CreateSettlementInput, ctx: ActorContext) {
  const p = (await c.query<{ id: string; country_id: string; status: string; interim_settlement_eligible: boolean; interim_max_percent: string | null }>(
    'SELECT * FROM providers WHERE id = $1 FOR UPDATE', [input.providerId])).rows[0];
  if (!p) throw notFound();
  await assertFund(c, input.accountId, p.country_id, input.currency);

  let items: { earningId: string; bookingId: string; amount: bigint }[];
  if (input.kind === 'regular') {
    const el = await eligibleEarnings(c, p.id, input.currency, true);
    if (el.total <= 0n) throw conflict('NOTHING_TO_SETTLE', { net: fromUnits(el.total) });
    items = el.items;
  } else {
    // Interim (clause 44): only for providers with an agreement, only up to the agreed share of the provider's part already collected.
    if (!p.interim_settlement_eligible || !p.interim_max_percent || !input.bookingId || !input.amount) throw conflict('INTERIM_NOT_ALLOWED', { reason: 'provider not eligible or booking/amount missing' });
    const e = (await c.query<{ id: string; status: string; booking_status: string; collected_by_platform: string; currency_code: string; commission: string }>(
      `SELECT e.id, e.status, b.status AS booking_status, e.collected_by_platform, e.currency_code, bc.commission_amount AS commission
         FROM provider_earnings e JOIN bookings b ON b.id = e.booking_id LEFT JOIN booking_commissions bc ON bc.booking_id = e.booking_id
        WHERE e.booking_id = $1 AND e.provider_id = $2 FOR UPDATE OF e`, [input.bookingId, p.id])).rows[0];
    if (!e || e.status !== 'not_due' || !['confirmed', 'in_progress'].includes(e.booking_status) || e.currency_code.trim() !== input.currency) {
      throw conflict('INTERIM_NOT_ALLOWED', { reason: 'only for confirmed bookings not yet completed' });
    }
    const providerShare = toUnits(e.collected_by_platform) - toUnits(e.commission ?? '0');
    const already = toUnits((await c.query<{ v: string }>(
      `SELECT coalesce(sum(i.amount), 0)::text AS v FROM settlement_items i JOIN settlements s ON s.id = i.settlement_id
        WHERE i.earning_id = $1 AND s.kind = 'interim' AND i.status IN ('pending', 'paid')`, [e.id])).rows[0]!.v);
    const cap = percentOf(providerShare, p.interim_max_percent) - already;
    const amount = toUnits(input.amount);
    if (amount <= 0n || amount > cap) throw conflict('INTERIM_NOT_ALLOWED', { maxAllowed: fromUnits(cap > 0n ? cap : 0n) });
    items = [{ earningId: e.id, bookingId: input.bookingId, amount }];
  }
  const total = items.reduce((s, i) => s + i.amount, 0n);
  const s = (await c.query<{ id: string; number: string }>(
    `INSERT INTO settlements (provider_id, country_id, currency_code, kind, amount, method, account_id, created_by, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id, number`,
    [p.id, p.country_id, input.currency, input.kind, fromUnits(total), input.method, input.accountId, ctx.actorId, input.notes ?? null])).rows[0]!;
  for (const i of items) {
    await c.query('INSERT INTO settlement_items (settlement_id, earning_id, booking_id, amount) VALUES ($1, $2, $3, $4)', [s.id, i.earningId, i.bookingId, fromUnits(i.amount)]);
    if (input.kind === 'regular') await earningStatus(c, i.earningId, 'ready_for_settlement', ctx, `in ${s.number}`);
  }
  await recordStatus(c, s.id, null, 'pending_approval', ctx, null);
  await audit(c, ctx, { action: 'settlement.created', entityType: 'settlement', entityId: s.id, after: { number: s.number, kind: input.kind, amount: fromUnits(total), items: items.length } });
  return { id: s.id, number: s.number, amount: fromUnits(total) };
}

interface SettlementRow { id: string; number: string; provider_id: string; country_id: string; currency_code: string; kind: string; amount: string; account_id: string; status: string; created_by: string }

async function lockSettlement(c: Executor, id: string) {
  const s = (await c.query<SettlementRow>('SELECT * FROM settlements WHERE id = $1 FOR UPDATE', [id])).rows[0];
  if (!s) throw notFound();
  return s;
}

export async function approveSettlement(c: Executor, id: string, ctx: ActorContext) {
  const s = await lockSettlement(c, id);
  if (s.status !== 'pending_approval') throw conflict('INVALID_STATUS_TRANSITION', { from: s.status });
  if (s.created_by === ctx.actorId) throw forbidden('FOUR_EYES_REQUIRED');
  await c.query(`UPDATE settlements SET status = 'approved', approved_by = $2, approved_at = now() WHERE id = $1`, [id, ctx.actorId]);
  await recordStatus(c, id, s.status, 'approved', ctx, null);
  await audit(c, ctx, { action: 'settlement.approved', entityType: 'settlement', entityId: id, after: { amount: s.amount } });
}

/**
 * The transfer was made. Regular: provider payables are paid from the fund (2110 → fund), per booking.
 * Interim: part of the customer advance is paid out early (2200 → fund) and deducted at completion.
 */
export async function markSettlementPaid(c: Executor, id: string, externalRef: string, ctx: ActorContext) {
  const s = await lockSettlement(c, id);
  if (s.status === 'paid') return;
  if (s.status !== 'approved') throw conflict('INVALID_STATUS_TRANSITION', { from: s.status });
  const items = (await c.query<{ earning_id: string; booking_id: string; amount: string }>('SELECT earning_id, booking_id, amount FROM settlement_items WHERE settlement_id = $1', [id])).rows;
  const cur = s.currency_code.trim();
  const debitAccount = await systemAccount(c, s.country_id, cur, s.kind === 'interim' ? 'customer_advances' : 'provider_payable_due');
  await post(c, {
    countryId: s.country_id, description: `${s.kind === 'interim' ? 'Interim settlement' : 'Settlement'} paid ${s.number}`, sourceType: 'settlement', sourceId: s.id,
    idempotencyKey: `settlement:${s.id}`, createdBy: ctx.actorId,
    lines: [
      ...items.map((i) => ({ accountId: debitAccount, debit: i.amount, currency: cur, bookingId: i.booking_id, providerId: s.provider_id })),
      { accountId: s.account_id, credit: s.amount, currency: cur, providerId: s.provider_id },
    ],
  });
  await c.query(`UPDATE settlements SET status = 'paid', paid_by = $2, paid_at = now(), external_ref = $3 WHERE id = $1`, [id, ctx.actorId, externalRef]);
  await c.query(`UPDATE settlement_items SET status = 'paid' WHERE settlement_id = $1`, [id]);
  if (s.kind === 'regular') for (const i of items) await earningStatus(c, i.earning_id, 'settled', ctx, `paid in ${s.number}`);
  await recordStatus(c, id, s.status, 'paid', ctx, null);
  await audit(c, ctx, { action: 'settlement.paid', entityType: 'settlement', entityId: id, after: { externalRef, amount: s.amount } });
  const u = (await c.query<{ id: string; phone: string | null; preferred_language: string }>(
    'SELECT u.id, u.phone, u.preferred_language FROM providers p JOIN users u ON u.id = p.user_id WHERE p.id = $1', [s.provider_id])).rows[0]!;
  if (u.phone) await enqueueMessage(c, { channel: 'sms', recipientUserId: u.id, target: u.phone, templateKey: 'settlement.paid', language: u.preferred_language, payload: { settlementId: id, number: s.number, amount: s.amount } });
}

/** Failure or cancellation releases the earnings so they can be settled again (clause 43: failed / re-reviewed). */
export async function closeSettlementUnpaid(c: Executor, id: string, to: 'failed' | 'cancelled', reason: string, ctx: ActorContext) {
  const s = await lockSettlement(c, id);
  const allowed = to === 'failed' ? ['approved'] : ['pending_approval', 'approved'];
  if (!allowed.includes(s.status)) throw conflict('INVALID_STATUS_TRANSITION', { from: s.status });
  const items = (await c.query<{ earning_id: string }>('SELECT earning_id FROM settlement_items WHERE settlement_id = $1', [id])).rows;
  await c.query(`UPDATE settlements SET status = $2, failure_reason = $3 WHERE id = $1`, [id, to, reason]);
  await c.query(`UPDATE settlement_items SET status = 'void' WHERE settlement_id = $1`, [id]);
  if (s.kind === 'regular') for (const i of items) await earningStatus(c, i.earning_id, to === 'failed' ? 'settlement_failed' : 'due', ctx, reason);
  await recordStatus(c, id, s.status, to, ctx, reason);
  await audit(c, ctx, { action: `settlement.${to}`, entityType: 'settlement', entityId: id, reason });
}
