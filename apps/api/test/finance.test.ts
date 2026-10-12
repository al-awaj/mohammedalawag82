import { createHmac, randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { expireBookings } from '../src/modules/booking/service.js';
import { api, approvedProvider, createStaff, latestCode, PDF, PNG, register, setupCountry, uniq, upload, useApp } from './helpers.js';

const ctx = useApp();
const SECRET = 'sandbox-secret-for-tests-0123456789';
process.env.PAY_SANDBOX_TEST_SECRET = SECRET;

let admin: { token: string };
let supervisor: { token: string };
let finance: { token: string };
let reviewer: { token: string };
let country: { id: string; code: string };
let hallType: string;
let integrationId: string;
let gatewayAccount: string;
let bankAccount: string;

let dayCounter = 0;
const nextDate = () => new Date(Date.UTC(2027, 7, 1 + dayCounter++)).toISOString().slice(0, 10);

async function hall(body: Record<string, unknown> = {}) {
  const p = await approvedProvider(ctx, supervisor.token, country.code);
  await api(ctx, 'PUT', `/v1/admin/providers/${p.providerId}/service-types`, { token: admin.token, body: { serviceTypeIds: [hallType] } });
  const s = await api(ctx, 'POST', '/v1/provider/services', {
    token: p.token,
    body: { serviceTypeId: hallType, title: { en: 'Hall' }, description: { en: 'D' }, city: 'Riyadh', currency: 'SAR', basePrice: '20000', pricingUnit: 'fixed',
      requiresProviderApproval: false, depositType: 'percent', depositValue: '25', ...body },
  });
  await upload(ctx, `/v1/provider/services/${s.body.id}/media`, p.token, PNG);
  await api(ctx, 'POST', `/v1/provider/services/${s.body.id}/submit`, { token: p.token });
  await api(ctx, 'POST', `/v1/admin/services/${s.body.id}/actions`, { token: supervisor.token, body: { action: 'publish' } });
  return { p, serviceId: s.body.id as string };
}

async function customer() {
  const c = await register(ctx, country.code);
  const code = await latestCode(ctx, c.userId, 'auth.verify_phone');
  await api(ctx, 'POST', '/v1/auth/verification/confirm', { token: c.token, body: { channel: 'phone', code } });
  return c;
}

async function order(c: { token: string }, serviceId: string, date = nextDate()) {
  await api(ctx, 'POST', '/v1/cart/items', { token: c.token, body: { serviceId, date } });
  const r = await ctx.app.inject({ method: 'POST', url: '/v1/checkout', headers: { authorization: `Bearer ${c.token}`, 'idempotency-key': randomUUID() }, payload: { acceptTerms: true } });
  if (r.statusCode !== 201) throw new Error(r.body);
  return JSON.parse(r.body) as { id: string; bookings: { id: string; number: string }[] };
}

async function startPayment(token: string, orderId: string, body: Record<string, unknown>, key = randomUUID()) {
  const r = await ctx.app.inject({ method: 'POST', url: `/v1/orders/${orderId}/payments`, headers: { authorization: `Bearer ${token}`, 'idempotency-key': key }, payload: body });
  return { status: r.statusCode, body: JSON.parse(r.body) };
}

async function webhook(body: object, secret = SECRET) {
  const raw = JSON.stringify(body);
  const sig = createHmac('sha256', secret).update(raw).digest('hex');
  const r = await ctx.app.inject({ method: 'POST', url: `/v1/webhooks/payments/${integrationId}`, payload: raw, headers: { 'content-type': 'application/json', 'x-sandbox-signature': sig } });
  return { status: r.statusCode, body: JSON.parse(r.body) };
}

const succeeded = (ref: string, amount: string, fee = '0', id = `evt_${uniq()}`) => ({ id, type: 'payment.succeeded', data: { reference: ref, amount, currency: 'SAR', fee } });
const externalRef = async (paymentId: string) => (await ctx.db.query('SELECT external_ref FROM payments WHERE id = $1', [paymentId])).rows[0].external_ref as string;
const bookingOf = async (token: string, id: string) => (await api(ctx, 'GET', `/v1/bookings/${id}`, { token })).body;
const entriesFor = async (paymentId: string) => (await ctx.db.query(`SELECT count(*)::int AS n FROM journal_entries WHERE source_type = 'payment' AND source_id = $1`, [paymentId])).rows[0].n;

async function balances() {
  const rows = (await api(ctx, 'GET', `/v1/admin/accounts?countryId=${country.id}&currency=SAR`, { token: finance.token })).body as { code: string; balance: string }[];
  return Object.fromEntries(rows.map((r) => [r.code, r.balance]));
}

/** Pays the upfront amount of an order by card through a signed sandbox notification. */
async function payByCard(c: { token: string }, orderId: string, fee = '0') {
  const p = await startPayment(c.token, orderId, { model: 'platform', method: 'card', purpose: 'upfront' });
  expect(p.status).toBe(201);
  await webhook(succeeded(await externalRef(p.body.id), p.body.amount, fee));
  return p.body;
}

beforeAll(async () => {
  admin = await createStaff(ctx, [{ code: 'system_admin' }]);
  country = await setupCountry(ctx, admin.token);
  supervisor = await createStaff(ctx, [{ code: 'services_supervisor', countryId: country.id }]);
  finance = await createStaff(ctx, [{ code: 'finance_officer', countryId: country.id }]);
  reviewer = await createStaff(ctx, [{ code: 'payment_reviewer', countryId: country.id }]);
  const categoryId = (await api(ctx, 'POST', '/v1/admin/categories', { token: admin.token, body: { slug: `c-${uniq()}`, name: { en: 'C' }, countryIds: [country.id] } })).body.id;
  hallType = (await api(ctx, 'POST', '/v1/admin/service-types', { token: admin.token, body: { categoryId, code: `t_${uniq()}`.slice(0, 40), name: { en: 'Hall' }, bookingMode: 'full_day', pricingUnits: ['fixed'] } })).body.id;

  gatewayAccount = (await api(ctx, 'POST', '/v1/admin/accounts', { token: admin.token, body: { countryId: country.id, currency: 'SAR', kind: 'gateway', suffix: 'SBX', name: { en: 'Sandbox gateway' } } })).body.id;
  bankAccount = (await api(ctx, 'POST', '/v1/admin/accounts', { token: admin.token, body: { countryId: country.id, currency: 'SAR', kind: 'bank', suffix: '01', name: { en: 'Main bank' }, details: { iban: 'SA00 0000' } } })).body.id;
  const integ = await api(ctx, 'POST', '/v1/admin/payment-integrations', {
    token: admin.token, body: { providerCode: 'sandbox', name: 'Sandbox', countryId: country.id, kind: 'gateway', environment: 'test', secretRef: 'PAY_SANDBOX_TEST_SECRET' },
  });
  integrationId = integ.body.id;
  expect((await api(ctx, 'POST', `/v1/admin/payment-integrations/${integrationId}/test`, { token: admin.token })).body.ok).toBe(true);
  await api(ctx, 'PATCH', `/v1/admin/payment-integrations/${integrationId}`, { token: admin.token, body: { isActive: true, reason: 'Go live in test' } });
  const rule = (body: object) => api(ctx, 'POST', '/v1/admin/payment-methods', { token: admin.token, body: { countryId: country.id, ...body } });
  expect((await rule({ model: 'platform', method: 'card', integrationId, accountId: gatewayAccount })).status).toBe(201);
  expect((await rule({ model: 'platform', method: 'bank_transfer', accountId: bankAccount, proofRequired: true })).status).toBe(201);
  expect((await rule({ model: 'direct', method: 'cash' })).status).toBe(201);
  // 10% commission for the country.
  expect((await api(ctx, 'POST', '/v1/admin/commission-rules', { token: admin.token, body: { scope: 'country', countryId: country.id, rateType: 'percent', rateValue: '10' } })).status).toBe(201);
});

describe('payment through the platform (tests 14, 19-20)', () => {
  it('confirms the booking on a verified card payment and posts a balanced entry', async () => {
    const { serviceId } = await hall();
    const c = await customer();
    const o = await order(c, serviceId);
    const before = await balances();

    const options = (await api(ctx, 'GET', `/v1/orders/${o.id}/payment-options`, { token: c.token })).body;
    expect(options).toEqual(expect.arrayContaining([expect.objectContaining({ purpose: 'upfront', model: 'platform', method: 'card', amount: '5000.0000' })]));
    expect(options.some((x: { model: string }) => x.model === 'direct')).toBe(false); // direct payments are disabled by default

    const p = await startPayment(c.token, o.id, { model: 'platform', method: 'card', purpose: 'upfront' });
    expect(p.body).toMatchObject({ status: 'pending', amount: '5000.0000' });
    expect(p.body.checkoutUrl).toContain('sbx_');
    expect((await bookingOf(c.token, o.bookings[0]!.id)).status).toBe('awaiting_payment');

    const wh = await webhook(succeeded(await externalRef(p.body.id), '5000.0000', '75.00'));
    expect(wh).toMatchObject({ status: 200, body: { result: 'processed' } });
    const b = await bookingOf(c.token, o.bookings[0]!.id);
    expect(b).toMatchObject({ status: 'confirmed', paidAmount: '5000.0000', remainingAmount: '15000.0000' });

    const after = await balances();
    const delta = (code: string) => (Number(after[code] ?? 0) - Number(before[code] ?? 0)).toFixed(4);
    expect(delta('1400-SBX')).toBe('4925.0000'); // net of the provider fee
    expect(delta('5100')).toBe('75.0000');       // fee is an expense, not commission
    expect(delta('2200')).toBe('5000.0000');     // held for the customer until the service is delivered
    expect(delta('4100')).toBe('0.0000');        // no revenue before completion
    const tb = await api(ctx, 'GET', `/v1/admin/ledger/trial-balance?countryId=${country.id}&currency=SAR`, { token: finance.token });
    expect(tb.body.totals.balanced).toBe(true);

    const commission = (await ctx.db.query('SELECT commission_amount FROM booking_commissions WHERE booking_id = $1', [b.id])).rows[0];
    expect(commission.commission_amount).toBe('2000.0000');
    const earning = (await ctx.db.query('SELECT status, collected_by_platform, net_amount FROM provider_earnings WHERE booking_id = $1', [b.id])).rows[0];
    expect(earning).toEqual({ status: 'not_due', collected_by_platform: '5000.0000', net_amount: '3000.0000' });
    expect((await ctx.db.query(`SELECT 1 FROM message_outbox WHERE channel <> 'web' AND recipient_user_id = $1 AND template_key = 'payment.succeeded'`, [c.userId])).rowCount).toBe(1);
  });

  it('takes the remaining balance after confirmation', async () => {
    const { serviceId } = await hall();
    const c = await customer();
    const o = await order(c, serviceId);
    expect((await startPayment(c.token, o.id, { model: 'platform', method: 'card', purpose: 'balance' })).body.error.code).toBe('NOTHING_TO_PAY');
    await payByCard(c, o.id);
    const bal = await startPayment(c.token, o.id, { model: 'platform', method: 'card', purpose: 'balance' });
    expect(bal.body.amount).toBe('15000.0000');
    await webhook(succeeded(await externalRef(bal.body.id), '15000.0000'));
    expect(await bookingOf(c.token, o.bookings[0]!.id)).toMatchObject({ paidAmount: '20000.0000', remainingAmount: '0.0000' });
  });
});

describe('duplicate, failed, forged and late notifications (tests 16-18)', () => {
  it('processes a redelivered or repeated success once (no double entry)', async () => {
    const { serviceId } = await hall();
    const c = await customer();
    const o = await order(c, serviceId);
    const p = await startPayment(c.token, o.id, { model: 'platform', method: 'card', purpose: 'upfront' });
    const ev = succeeded(await externalRef(p.body.id), '5000.0000');
    expect((await webhook(ev)).body.result).toBe('processed');
    expect((await webhook(ev)).body.result).toBe('duplicate');                                          // same event id
    expect((await webhook({ ...ev, id: `evt_${uniq()}` })).body.result).toBe('duplicate');              // new id, same payment
    expect(await entriesFor(p.body.id)).toBe(1);
    expect((await ctx.db.query(`SELECT count(*)::int AS n FROM provider_webhook_events WHERE external_ref = $1`, [ev.data.reference])).rows[0].n).toBe(3);
  });

  it('records declines and lets the customer try again', async () => {
    const { serviceId } = await hall();
    const c = await customer();
    const o = await order(c, serviceId);
    const p = await startPayment(c.token, o.id, { model: 'platform', method: 'card', purpose: 'upfront' });
    // While a payment is in progress, a second one is refused (no double charge).
    expect((await startPayment(c.token, o.id, { model: 'platform', method: 'card', purpose: 'upfront' })).body.error.code).toBe('PAYMENT_IN_PROGRESS');
    const r = await webhook({ id: `evt_${uniq()}`, type: 'payment.failed', data: { reference: await externalRef(p.body.id), amount: '5000.0000', currency: 'SAR', reason: 'insufficient_funds' } });
    expect(r.body.result).toBe('processed');
    expect((await api(ctx, 'GET', `/v1/payments/${p.body.id}`, { token: c.token })).body).toMatchObject({ status: 'failed', failureReason: 'insufficient_funds' });
    expect((await bookingOf(c.token, o.bookings[0]!.id)).status).toBe('awaiting_payment');
    expect(await entriesFor(p.body.id)).toBe(0);
    await payByCard(c, o.id);
    expect((await bookingOf(c.token, o.bookings[0]!.id)).status).toBe('confirmed');
  });

  it('rejects notifications with a bad signature and never trusts the client', async () => {
    const { serviceId } = await hall();
    const c = await customer();
    const o = await order(c, serviceId);
    const p = await startPayment(c.token, o.id, { model: 'platform', method: 'card', purpose: 'upfront' });
    const forged = await webhook(succeeded(await externalRef(p.body.id), '5000.0000'), 'attacker-secret');
    expect(forged.status).toBe(401);
    expect((await bookingOf(c.token, o.bookings[0]!.id)).status).toBe('awaiting_payment');
    expect((await ctx.db.query(`SELECT count(*)::int AS n FROM provider_webhook_events WHERE integration_id = $1 AND result = 'rejected'`, [integrationId])).rows[0].n).toBeGreaterThan(0);
    // The customer cannot choose the amount or mark anything paid.
    const replay = await startPayment(c.token, o.id, { model: 'platform', method: 'card', purpose: 'upfront', amount: '1' } as Record<string, unknown>);
    expect(replay.status).toBe(409); // still the in-progress payment; amount is server-computed
  });

  it('sends amount mismatches to review instead of confirming', async () => {
    const { serviceId } = await hall();
    const c = await customer();
    const o = await order(c, serviceId);
    const p = await startPayment(c.token, o.id, { model: 'platform', method: 'card', purpose: 'upfront' });
    await webhook(succeeded(await externalRef(p.body.id), '500.0000'));
    const pay = (await api(ctx, 'GET', `/v1/admin/payments/${p.body.id}`, { token: finance.token })).body;
    expect(pay).toMatchObject({ status: 'awaiting_verification', needsAttention: 'amount_mismatch', reportedAmount: '500.0000' });
    expect((await bookingOf(c.token, o.bookings[0]!.id)).status).toBe('awaiting_payment');
    expect((await api(ctx, 'GET', '/v1/admin/payments?needsAttention=true', { token: finance.token })).body.map((x: { id: string }) => x.id)).toContain(p.body.id);
  });

  it('confirms a late payment if the slot is still free, and flags it otherwise', async () => {
    const { serviceId } = await hall();
    const date = nextDate();
    const c = await customer();
    const o = await order(c, serviceId, date);
    const p = await startPayment(c.token, o.id, { model: 'platform', method: 'card', purpose: 'upfront' });
    await ctx.db.query(`UPDATE bookings SET hold_expires_at = now() - interval '1 second' WHERE id = $1`, [o.bookings[0]!.id]);
    await ctx.db.query(`UPDATE calendar_blocks SET expires_at = now() - interval '1 second' WHERE booking_ref = $1`, [o.bookings[0]!.id]);
    await expireBookings(ctx.db);
    // Someone else books the same day meanwhile.
    await order(await customer(), serviceId, date);
    await webhook(succeeded(await externalRef(p.body.id), '5000.0000'));
    expect((await bookingOf(c.token, o.bookings[0]!.id)).status).toBe('expired');
    expect((await api(ctx, 'GET', `/v1/admin/payments/${p.body.id}`, { token: finance.token })).body).toMatchObject({ status: 'succeeded', needsAttention: 'slot_unavailable_after_payment' });
    // The money is recorded (held for the customer) and will go through the refund process.
    expect(await entriesFor(p.body.id)).toBe(1);
  });
});

describe('payment for a booking cancelled meanwhile', () => {
  it('records the money and flags it for refund instead of losing track of it', async () => {
    const { serviceId } = await hall();
    const c = await customer();
    const o = await order(c, serviceId);
    const p = await startPayment(c.token, o.id, { model: 'platform', method: 'card', purpose: 'upfront' });
    await api(ctx, 'POST', `/v1/bookings/${o.bookings[0]!.id}/cancel`, { token: c.token, body: { reason: 'Changed my mind' } });
    await webhook(succeeded(await externalRef(p.body.id), '5000.0000'));
    expect((await bookingOf(c.token, o.bookings[0]!.id)).status).toBe('cancelled_by_customer');
    expect((await api(ctx, 'GET', `/v1/admin/payments/${p.body.id}`, { token: finance.token })).body).toMatchObject({ status: 'succeeded', needsAttention: 'booking_cancelled_after_payment' });
    expect(await entriesFor(p.body.id)).toBe(1);
  });
});

describe('bank transfer with proof (clauses 33, 46)', () => {
  it('separates reported and verified amounts and separates reviewing from approving', async () => {
    const { serviceId } = await hall();
    const c = await customer();
    const o = await order(c, serviceId);
    const p = await startPayment(c.token, o.id, { model: 'platform', method: 'bank_transfer', purpose: 'upfront', reportedAmount: '5000' });
    expect(p.body).toMatchObject({ status: 'awaiting_verification', reportedAmount: '5000.0000', verifiedAmount: null });

    const approve = (token: string, verifiedAmount?: string) => api(ctx, 'POST', `/v1/admin/payments/${p.body.id}/review`, { token, body: { decision: 'approve', note: 'Matched bank statement', ...(verifiedAmount ? { verifiedAmount } : {}) } });
    expect((await approve(finance.token)).body.error.code).toBe('PROOF_REQUIRED');
    expect((await upload(ctx, `/v1/payments/${p.body.id}/proofs`, c.token, PDF)).status).toBe(201);
    expect((await approve(reviewer.token)).status).toBe(403); // reviewers cannot approve money

    // Only 3000 actually arrived: recorded as such, booking not yet secured.
    expect((await approve(finance.token, '3000')).body.status).toBe('succeeded');
    const pay = (await api(ctx, 'GET', `/v1/admin/payments/${p.body.id}`, { token: finance.token })).body;
    expect(pay).toMatchObject({ reportedAmount: '5000.0000', verifiedAmount: '3000.0000', reviewNote: 'Matched bank statement' });
    expect(await bookingOf(c.token, o.bookings[0]!.id)).toMatchObject({ status: 'awaiting_payment', paidAmount: '3000.0000' });

    const rest = await startPayment(c.token, o.id, { model: 'platform', method: 'bank_transfer', purpose: 'upfront' });
    expect(rest.body.amount).toBe('2000.0000');
    await upload(ctx, `/v1/payments/${rest.body.id}/proofs`, c.token, PNG);
    await api(ctx, 'POST', `/v1/admin/payments/${rest.body.id}/review`, { token: finance.token, body: { decision: 'approve', note: 'Second transfer' } });
    expect((await bookingOf(c.token, o.bookings[0]!.id)).status).toBe('confirmed');
  });

  it('lets a reviewer reject a proof', async () => {
    const { serviceId } = await hall();
    const c = await customer();
    const o = await order(c, serviceId);
    const p = await startPayment(c.token, o.id, { model: 'platform', method: 'bank_transfer', purpose: 'upfront' });
    await upload(ctx, `/v1/payments/${p.body.id}/proofs`, c.token, PDF);
    const r = await api(ctx, 'POST', `/v1/admin/payments/${p.body.id}/review`, { token: reviewer.token, body: { decision: 'reject', note: 'Transfer not found on statement' } });
    expect(r.body.status).toBe('failed');
    expect(await entriesFor(p.body.id)).toBe(0);
  });
});

describe('direct payment to the provider (test 15)', () => {
  it('is available only when enabled, verified by staff, and tracked off-balance', async () => {
    const { p: prov, serviceId } = await hall();
    const c = await customer();
    const o = await order(c, serviceId);
    expect((await startPayment(c.token, o.id, { model: 'direct', method: 'cash', purpose: 'upfront' })).body.error.code).toBe('PAYMENT_METHOD_NOT_AVAILABLE');
    await api(ctx, 'PUT', '/v1/admin/settings/payments.direct_enabled', { token: admin.token, body: { scope: 'country', countryId: country.id, value: true, reason: 'Pilot direct payments' } });
    try {
      const p = await startPayment(c.token, o.id, { model: 'direct', method: 'cash', purpose: 'upfront', reportedAmount: '5000' });
      expect(p.body).toMatchObject({ status: 'awaiting_verification', model: 'direct' });
      // Entering an amount is not proof of receipt: nothing is confirmed until verified.
      expect((await bookingOf(c.token, o.bookings[0]!.id)).status).toBe('awaiting_payment');
      await api(ctx, 'POST', `/v1/admin/payments/${p.body.id}/review`, { token: finance.token, body: { decision: 'approve', note: 'Provider confirmed receipt' } });
      expect((await bookingOf(c.token, o.bookings[0]!.id)).status).toBe('confirmed');

      const before = await balances();
      expect(Number(before['9100'])).toBeGreaterThanOrEqual(5000);
      const earning = (await ctx.db.query('SELECT collected_directly, collected_by_platform, net_amount FROM provider_earnings WHERE booking_id = $1', [o.bookings[0]!.id])).rows[0];
      expect(earning).toEqual({ collected_directly: '5000.0000', collected_by_platform: '0.0000', net_amount: '-2000.0000' });

      // On completion the commission is revenue and the provider owes it (payable goes debit).
      await ctx.db.query(`UPDATE bookings SET start_at = now() - interval '2 hours', end_at = now() - interval '1 hour' WHERE id = $1`, [o.bookings[0]!.id]);
      await api(ctx, 'POST', `/v1/provider/bookings/${o.bookings[0]!.id}/complete`, { token: prov.token });
      const after = await balances();
      expect((Number(after['4100']) - Number(before['4100'] ?? 0)).toFixed(4)).toBe('2000.0000');
      expect((Number(after['2110'] ?? 0) - Number(before['2110'] ?? 0)).toFixed(4)).toBe('-2000.0000');
    } finally {
      await api(ctx, 'PUT', '/v1/admin/settings/payments.direct_enabled', { token: admin.token, body: { scope: 'country', countryId: country.id, value: false, reason: 'End pilot' } });
    }
  });
});

describe('commissions (test 23, clauses 40-41)', () => {
  it('applies the most specific rule, snapshots it, and never rewrites past bookings', async () => {
    const { serviceId } = await hall();
    await api(ctx, 'POST', '/v1/admin/commission-rules', { token: admin.token, body: { scope: 'service', serviceId, rateType: 'fixed', rateValue: '750', currency: 'SAR', agreementRef: 'Contract #42' } });
    const o1 = await order(await customer(), serviceId);
    const c1 = (await ctx.db.query('SELECT commission_amount, rate_type FROM booking_commissions WHERE booking_id = $1', [o1.bookings[0]!.id])).rows[0];
    expect(c1).toEqual({ commission_amount: '750.0000', rate_type: 'fixed' });

    // New, more prioritised rule: only new bookings use it.
    const r2 = await api(ctx, 'POST', '/v1/admin/commission-rules', { token: admin.token, body: { scope: 'service', serviceId, rateType: 'percent', rateValue: '5', priority: 10 } });
    const o2 = await order(await customer(), serviceId);
    expect((await ctx.db.query('SELECT commission_amount FROM booking_commissions WHERE booking_id = $1', [o2.bookings[0]!.id])).rows[0].commission_amount).toBe('1000.0000');
    expect((await ctx.db.query('SELECT commission_amount FROM booking_commissions WHERE booking_id = $1', [o1.bookings[0]!.id])).rows[0].commission_amount).toBe('750.0000');

    await expect(ctx.db.query(`UPDATE commission_rules SET rate_value = 1 WHERE id = $1`, [r2.body.id])).rejects.toThrow(/immutable/);
    await expect(ctx.db.query(`UPDATE booking_commissions SET commission_amount = 0 WHERE booking_id = $1`, [o1.bookings[0]!.id])).rejects.toThrow(/append-only/);
    expect((await api(ctx, 'PATCH', `/v1/admin/commission-rules/${r2.body.id}`, { token: admin.token, body: { isActive: false, reason: 'Promotion ended' } })).status).toBe(200);
  });

  it('records no extra platform fee on top of the agreed price (rejected decision 4)', async () => {
    const { serviceId } = await hall();
    const c = await customer();
    const o = await order(c, serviceId);
    const b = await bookingOf(c.token, o.bookings[0]!.id);
    expect(b.total).toBe('20000.0000'); // what the customer pays is the service price, nothing added
    const kinds = (await ctx.db.query(`SELECT DISTINCT kind FROM ledger_accounts`)).rows.map((r) => r.kind);
    expect(kinds.some((k: string) => /platform_fee|service_fee/.test(k))).toBe(false);
  });
});

describe('provider earnings (tests 24, clauses 42-43)', () => {
  it('becomes due on completion with commission recognised, traceable to the booking', async () => {
    const { p, serviceId } = await hall();
    const c = await customer();
    const o = await order(c, serviceId);
    const bookingId = o.bookings[0]!.id;
    await payByCard(c, o.id);
    const bal = await startPayment(c.token, o.id, { model: 'platform', method: 'card', purpose: 'balance' });
    await webhook(succeeded(await externalRef(bal.body.id), bal.body.amount));
    await ctx.db.query(`UPDATE bookings SET start_at = now() - interval '2 hours', end_at = now() - interval '1 hour' WHERE id = $1`, [bookingId]);
    await api(ctx, 'POST', `/v1/provider/bookings/${bookingId}/complete`, { token: p.token });

    const earnings = (await api(ctx, 'GET', '/v1/provider/earnings', { token: p.token })).body;
    expect(earnings.items[0]).toMatchObject({ bookingId, collectedByPlatform: '20000.0000', commission: '2000.0000', net: '18000.0000', status: 'due' });
    expect(earnings.totals).toEqual([{ currency: 'SAR', status: 'due', net: '18000.0000', commission: '2000.0000', count: 1 }]);

    const lines = (await ctx.db.query(
      `SELECT a.code, l.debit, l.credit FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN ledger_accounts a ON a.id = l.account_id
        WHERE e.idempotency_key = $1 ORDER BY a.code`, [`booking_completion:${bookingId}`])).rows;
    expect(lines).toEqual([
      { code: '2110', debit: '0.0000', credit: '18000.0000' },
      { code: '2200', debit: '20000.0000', credit: '0.0000' },
      { code: '4100', debit: '0.0000', credit: '2000.0000' },
    ]);
    // Another provider sees none of it.
    expect((await api(ctx, 'GET', '/v1/provider/earnings', { token: (await approvedProvider(ctx, supervisor.token, country.code)).token })).body.items).toEqual([]);
  });

  it('waits for staff review when the country requires it', async () => {
    await api(ctx, 'PUT', '/v1/admin/settings/earnings.require_review', { token: admin.token, body: { scope: 'country', countryId: country.id, value: true, reason: 'Quality checks' } });
    try {
      const { p, serviceId } = await hall({ depositType: 'none', depositValue: '0' });
      const c = await customer();
      const o = await order(c, serviceId);
      await payByCard(c, o.id);
      const bookingId = o.bookings[0]!.id;
      await ctx.db.query(`UPDATE bookings SET start_at = now() - interval '2 hours', end_at = now() - interval '1 hour' WHERE id = $1`, [bookingId]);
      await api(ctx, 'POST', `/v1/provider/bookings/${bookingId}/complete`, { token: p.token });
      const e = (await api(ctx, 'GET', `/v1/admin/earnings?providerId=${p.providerId}`, { token: finance.token })).body[0];
      expect(e.status).toBe('under_review');
      expect((await api(ctx, 'POST', `/v1/admin/earnings/${e.id}/approve-review`, { token: reviewer.token, body: { note: 'Photos verified' } })).status).toBe(403);
      expect((await api(ctx, 'POST', `/v1/admin/earnings/${e.id}/approve-review`, { token: finance.token, body: { note: 'Photos verified' } })).body.status).toBe('due');
    } finally {
      await api(ctx, 'PUT', '/v1/admin/settings/earnings.require_review', { token: admin.token, body: { scope: 'country', countryId: country.id, value: false, reason: 'Restore' } });
    }
  });
});

describe('ledger and fund integrity (clauses 37-39, 64)', () => {
  it('refuses unbalanced, edited or misdirected postings at the database level', async () => {
    const client = await ctx.db.connect();
    try {
      await client.query('BEGIN');
      const e = (await client.query(`INSERT INTO journal_entries (country_id, description, source_type, idempotency_key) VALUES ($1, 'bad', 'test', $2) RETURNING id`, [country.id, `t:${uniq()}`])).rows[0].id;
      await client.query(`INSERT INTO journal_lines (entry_id, account_id, debit, currency_code) VALUES ($1, $2, 100, 'SAR')`, [e, bankAccount]);
      await expect(client.query('COMMIT')).rejects.toThrow(/fewer than two lines|unbalanced/);
    } finally {
      client.release();
    }
    const any = (await ctx.db.query('SELECT id FROM journal_lines LIMIT 1')).rows[0];
    await expect(ctx.db.query('UPDATE journal_lines SET debit = debit + 1 WHERE id = $1', [any.id])).rejects.toThrow(/append-only/);
    await expect(ctx.db.query(`INSERT INTO journal_lines (entry_id, account_id, debit, currency_code) SELECT id, $1, 1, 'USD' FROM journal_entries LIMIT 1`, [bankAccount])).rejects.toThrow(/currency/);
  });

  it('protects funds: no disabling with balance or active methods; new funds start at zero', async () => {
    expect((await api(ctx, 'PATCH', `/v1/admin/accounts/${gatewayAccount}`, { token: admin.token, body: { isActive: false, reason: 'Close' } })).body.error.code).toBe('ACCOUNT_HAS_BALANCE');
    const cash = await api(ctx, 'POST', '/v1/admin/accounts', { token: admin.token, body: { countryId: country.id, currency: 'SAR', kind: 'cash', suffix: 'HQ', name: { en: 'HQ cash box' } } });
    expect((await balances())['1100-HQ']).toBe('0.0000');
    expect((await api(ctx, 'POST', '/v1/admin/accounts', { token: admin.token, body: { countryId: country.id, currency: 'SAR', kind: 'commission_revenue', suffix: 'X', name: { en: 'X' } } })).status).toBe(400);
    expect((await api(ctx, 'PATCH', `/v1/admin/accounts/${cash.body.id}`, { token: admin.token, body: { isActive: false, reason: 'Unused' } })).status).toBe(200);
  });

  it('never exposes integration secrets and limits finance data by permission and country', async () => {
    const list = (await api(ctx, 'GET', '/v1/admin/payment-integrations', { token: admin.token })).body;
    expect(JSON.stringify(list)).not.toContain(SECRET);
    expect(list.find((i: { id: string }) => i.id === integrationId).secretRef).toBe('PAY_SANDBOX_TEST_SECRET');
    expect((await api(ctx, 'GET', '/v1/admin/payments', { token: supervisor.token })).status).toBe(403);
    const foreign = await createStaff(ctx, [{ code: 'finance_officer', countryId: (await setupCountry(ctx, admin.token, '+971')).id }]);
    expect((await api(ctx, 'GET', `/v1/admin/ledger/trial-balance?countryId=${country.id}&currency=SAR`, { token: foreign.token })).status).toBe(404);
    expect((await api(ctx, 'GET', '/v1/admin/payments', { token: foreign.token })).body).toEqual([]);
  });

  it('replays a payment request with the same key instead of creating another', async () => {
    const { serviceId } = await hall();
    const c = await customer();
    const o = await order(c, serviceId);
    const key = randomUUID();
    const a = await startPayment(c.token, o.id, { model: 'platform', method: 'card', purpose: 'upfront' }, key);
    const b = await startPayment(c.token, o.id, { model: 'platform', method: 'card', purpose: 'upfront' }, key);
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.body.id).toBe(a.body.id);
  });
});
