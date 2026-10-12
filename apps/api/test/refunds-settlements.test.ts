import { createHmac, randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, approvedProvider, createStaff, latestCode, PNG, register, setupCountry, uniq, upload, useApp } from './helpers.js';

const ctx = useApp();
const SECRET = 'sandbox-secret-for-phase7-tests-0123';
process.env.PAY_SANDBOX_P7_SECRET = SECRET;

let admin: { token: string; id: string };
let supervisor: { token: string };
let financeA: { token: string; id: string };
let financeB: { token: string; id: string };
let country: { id: string; code: string };
let hallType: string;
let integrationId: string;
let bankAccount: string;

let dayCounter = 0;
const nextDate = () => new Date(Date.UTC(2027, 9, 1 + dayCounter++)).toISOString().slice(0, 10);

const POLICY = {
  name: { en: 'Standard' }, description: { en: '100% > 30 days, 50% > 7 days, none after' },
  tiers: [{ hoursBefore: 720, refundPercentOfPaid: 100 }, { hoursBefore: 168, refundPercentOfPaid: 50 }, { hoursBefore: 0, refundPercentOfPaid: 0 }],
  depositRefundable: false,
};

/** A published hall (20,000 SAR, 25% deposit) whose provider owns a cancellation policy. */
async function hall(policy: Record<string, unknown> = POLICY) {
  const p = await approvedProvider(ctx, supervisor.token, country.code);
  await api(ctx, 'PUT', `/v1/admin/providers/${p.providerId}/service-types`, { token: admin.token, body: { serviceTypeIds: [hallType] } });
  const pol = await api(ctx, 'POST', '/v1/provider/cancellation-policies', { token: p.token, body: policy });
  const s = await api(ctx, 'POST', '/v1/provider/services', {
    token: p.token,
    body: { serviceTypeId: hallType, title: { en: 'Hall' }, description: { en: 'D' }, city: 'Riyadh', currency: 'SAR', basePrice: '20000', pricingUnit: 'fixed',
      requiresProviderApproval: false, depositType: 'percent', depositValue: '25', cancellationPolicyId: pol.body.id },
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

async function webhook(body: object) {
  const raw = JSON.stringify(body);
  const sig = createHmac('sha256', SECRET).update(raw).digest('hex');
  const r = await ctx.app.inject({ method: 'POST', url: `/v1/webhooks/payments/${integrationId}`, payload: raw, headers: { 'content-type': 'application/json', 'x-sandbox-signature': sig } });
  return JSON.parse(r.body);
}

async function pay(token: string, orderId: string, purpose: 'upfront' | 'balance') {
  const r = await ctx.app.inject({ method: 'POST', url: `/v1/orders/${orderId}/payments`, headers: { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID() }, payload: { model: 'platform', method: 'card', purpose } });
  const p = JSON.parse(r.body);
  const ref = (await ctx.db.query('SELECT external_ref FROM payments WHERE id = $1', [p.id])).rows[0].external_ref;
  await webhook({ id: `evt_${uniq()}`, type: 'payment.succeeded', data: { reference: ref, amount: p.amount, currency: 'SAR' } });
  return p;
}

/** Books a hall and pays it fully (5,000 deposit + 15,000 balance) by card. */
async function paidBooking(serviceId: string) {
  const c = await customer();
  await api(ctx, 'POST', '/v1/cart/items', { token: c.token, body: { serviceId, date: nextDate() } });
  const r = await ctx.app.inject({ method: 'POST', url: '/v1/checkout', headers: { authorization: `Bearer ${c.token}`, 'idempotency-key': randomUUID() }, payload: { acceptTerms: true } });
  const order = JSON.parse(r.body);
  await pay(c.token, order.id, 'upfront');
  await pay(c.token, order.id, 'balance');
  return { c, orderId: order.id as string, bookingId: order.bookings[0].id as string };
}

const refundsOf = async (bookingId: string) => (await api(ctx, 'GET', `/v1/admin/refunds?bookingId=${bookingId}`, { token: financeA.token })).body;
const earningOf = async (bookingId: string) => (await ctx.db.query('SELECT status, commission_amount, net_amount FROM provider_earnings WHERE booking_id = $1', [bookingId])).rows[0];
const startIn = (bookingId: string, hours: number) => ctx.db.query(`UPDATE bookings SET start_at = now() + make_interval(hours => $2), end_at = now() + make_interval(hours => $2 + 24) WHERE id = $1`, [bookingId, hours]);

async function balances() {
  const rows = (await api(ctx, 'GET', `/v1/admin/accounts?countryId=${country.id}&currency=SAR`, { token: financeA.token })).body as { code: string; balance: string }[];
  return Object.fromEntries(rows.map((r) => [r.code, Number(r.balance)]));
}

async function completeRefundsByGateway(bookingId: string) {
  for (const r of await refundsOf(bookingId)) {
    if (r.status !== 'requested') continue;
    expect((await api(ctx, 'POST', `/v1/admin/refunds/${r.id}/approve`, { token: financeB.token })).body.status).toBe('approved');
    expect((await api(ctx, 'POST', `/v1/admin/refunds/${r.id}/execute`, { token: financeB.token })).body.status).toBe('processing');
    const ref = (await ctx.db.query('SELECT external_ref FROM refunds WHERE id = $1', [r.id])).rows[0].external_ref;
    expect((await webhook({ id: `evt_${uniq()}`, type: 'refund.succeeded', data: { reference: ref, amount: r.amount, currency: 'SAR' } })).result).toBe('processed');
  }
}

beforeAll(async () => {
  admin = await createStaff(ctx, [{ code: 'system_admin' }]);
  country = await setupCountry(ctx, admin.token);
  supervisor = await createStaff(ctx, [{ code: 'services_supervisor', countryId: country.id }]);
  financeA = await createStaff(ctx, [{ code: 'finance_officer', countryId: country.id }, { code: 'bookings_agent', countryId: country.id }]);
  financeB = await createStaff(ctx, [{ code: 'finance_officer', countryId: country.id }]);
  const categoryId = (await api(ctx, 'POST', '/v1/admin/categories', { token: admin.token, body: { slug: `c-${uniq()}`, name: { en: 'C' }, countryIds: [country.id] } })).body.id;
  hallType = (await api(ctx, 'POST', '/v1/admin/service-types', { token: admin.token, body: { categoryId, code: `t_${uniq()}`.slice(0, 40), name: { en: 'Hall' }, bookingMode: 'full_day', pricingUnits: ['fixed'] } })).body.id;
  const gw = (await api(ctx, 'POST', '/v1/admin/accounts', { token: admin.token, body: { countryId: country.id, currency: 'SAR', kind: 'gateway', suffix: 'P7', name: { en: 'Gateway' } } })).body.id;
  bankAccount = (await api(ctx, 'POST', '/v1/admin/accounts', { token: admin.token, body: { countryId: country.id, currency: 'SAR', kind: 'bank', suffix: 'P7', name: { en: 'Bank' } } })).body.id;
  integrationId = (await api(ctx, 'POST', '/v1/admin/payment-integrations', { token: admin.token, body: { providerCode: 'sandbox', name: 'Sandbox', countryId: country.id, kind: 'gateway', environment: 'test', secretRef: 'PAY_SANDBOX_P7_SECRET' } })).body.id;
  await api(ctx, 'PATCH', `/v1/admin/payment-integrations/${integrationId}`, { token: admin.token, body: { isActive: true, reason: 'Enable for tests' } });
  await api(ctx, 'POST', '/v1/admin/payment-methods', { token: admin.token, body: { countryId: country.id, model: 'platform', method: 'card', integrationId, accountId: gw } });
  await api(ctx, 'POST', '/v1/admin/commission-rules', { token: admin.token, body: { scope: 'country', countryId: country.id, rateType: 'percent', rateValue: '10' } });
});

describe('customer cancellation under the policy (tests 21, clause 49)', () => {
  it('shows the outcome first, keeps the non-refundable deposit, refunds through the gateway and closes the booking financially', async () => {
    const { serviceId } = await hall();
    const { c, bookingId } = await paidBooking(serviceId);
    const before = await balances();

    const preview = (await api(ctx, 'GET', `/v1/bookings/${bookingId}/cancellation-preview`, { token: c.token })).body;
    expect(preview).toMatchObject({ mode: 'immediate', platformPaid: '20000.0000', refund: '15000.0000', retained: '5000.0000', refundPercent: 100 });

    const res = await api(ctx, 'POST', `/v1/bookings/${bookingId}/cancel`, { token: c.token, body: { reason: 'Wedding postponed' } });
    expect(res.body.status).toBe('cancelled_by_customer');
    const refunds = await refundsOf(bookingId);
    expect(refunds.map((r: { amount: string; status: string }) => [r.amount, r.status])).toEqual([['15000.0000', 'requested']]);
    // Money is only returned after an authorised approval and execution.
    expect((await api(ctx, 'GET', `/v1/bookings/${bookingId}/refunds`, { token: c.token })).body[0].status).toBe('requested');

    await completeRefundsByGateway(bookingId);
    expect((await api(ctx, 'GET', `/v1/bookings/${bookingId}/refunds`, { token: c.token })).body[0].status).toBe('completed');

    const after = await balances();
    expect(after['1400-P7']! - before['1400-P7']!).toBe(-15000);
    expect(after['2300']! - (before['2300'] ?? 0)).toBe(0);         // refunds payable cleared
    expect(after['2200']! - before['2200']!).toBe(-20000);           // 15,000 refunded + 5,000 retained moved out
    expect(after['4100']! - (before['4100'] ?? 0)).toBe(500);        // commission on the retained 5,000
    expect(after['2110']! - (before['2110'] ?? 0)).toBe(4500);       // provider share of the retained amount
    expect(await earningOf(bookingId)).toEqual({ status: 'due', commission_amount: '500.0000', net_amount: '4500.0000' });
    const tb = await api(ctx, 'GET', `/v1/admin/ledger/trial-balance?countryId=${country.id}&currency=SAR`, { token: financeA.token });
    expect(tb.body.totals.balanced).toBe(true);
  });

  it('applies the tier for the hours left before the start', async () => {
    const { serviceId } = await hall();
    const mid = await paidBooking(serviceId);
    await startIn(mid.bookingId, 200); // between 7 and 30 days: 50%
    expect((await api(ctx, 'GET', `/v1/bookings/${mid.bookingId}/cancellation-preview`, { token: mid.c.token })).body).toMatchObject({ refundPercent: 50, refund: '7500.0000' });
    const late = await paidBooking(serviceId);
    await startIn(late.bookingId, 100); // under 7 days: nothing back
    expect((await api(ctx, 'GET', `/v1/bookings/${late.bookingId}/cancellation-preview`, { token: late.c.token })).body).toMatchObject({ refundPercent: 0, refund: '0.0000', retained: '20000.0000' });
  });

  it('respects policies that forbid self-cancellation or require a review', async () => {
    const strict = await hall({ ...POLICY, selfCancelAllowed: false });
    const s = await paidBooking(strict.serviceId);
    expect((await api(ctx, 'POST', `/v1/bookings/${s.bookingId}/cancel`, { token: s.c.token, body: { reason: 'Please cancel' } })).body.error.code).toBe('CANCELLATION_NOT_ALLOWED');

    const reviewed = await hall({ ...POLICY, requiresManualReview: true });
    const r = await paidBooking(reviewed.serviceId);
    const req = await api(ctx, 'POST', `/v1/bookings/${r.bookingId}/cancel`, { token: r.c.token, body: { reason: 'Family emergency' } });
    expect(req.body).toMatchObject({ status: 'confirmed', quote: { mode: 'review', refund: '15000.0000' } });
    expect((await api(ctx, 'POST', `/v1/bookings/${r.bookingId}/cancel`, { token: r.c.token, body: { reason: 'Again' } })).body.error.code).toBe('CANCELLATION_ALREADY_REQUESTED');

    const pending = (await api(ctx, 'GET', '/v1/admin/cancellation-requests', { token: financeA.token })).body.find((x: { bookingId: string }) => x.bookingId === r.bookingId);
    const decided = await api(ctx, 'POST', `/v1/admin/cancellation-requests/${pending.id}/decide`, { token: financeA.token, body: { decision: 'approve', refundAmount: '18000', reason: 'Documented emergency: goodwill' } });
    expect(decided.body).toMatchObject({ status: 'approved', refund: '18000' });
    expect((await api(ctx, 'GET', `/v1/bookings/${r.bookingId}`, { token: r.c.token })).body.status).toBe('cancelled_by_customer');
    expect((await refundsOf(r.bookingId)).reduce((s: number, x: { amount: string }) => s + Number(x.amount), 0)).toBe(18000);
  });
});

describe('provider and admin cancellations', () => {
  it('refunds the customer in full when the provider cancels', async () => {
    const { p, serviceId } = await hall();
    const { bookingId } = await paidBooking(serviceId);
    const r = await api(ctx, 'POST', `/v1/provider/bookings/${bookingId}/cancel`, { token: p.token, body: { reason: 'Hall under maintenance' } });
    expect(r.body).toMatchObject({ status: 'cancelled_by_provider', quote: { refund: '20000.0000' } });
    await completeRefundsByGateway(bookingId);
    // Nothing retained, nothing earned.
    expect((await earningOf(bookingId)).status).toBe('settled');
    expect((await earningOf(bookingId)).net_amount).toBe('0.0000');
  });

  it('lets staff cancel with a chosen refund, but someone else must approve their refund', async () => {
    const { serviceId } = await hall();
    const { bookingId } = await paidBooking(serviceId);
    expect((await api(ctx, 'POST', `/v1/admin/bookings/${bookingId}/cancel`, { token: financeA.token, body: { reason: 'Fraud check', refundAmount: '25000' } })).body.error.code).toBe('REFUND_EXCEEDS_REFUNDABLE');
    await api(ctx, 'POST', `/v1/admin/bookings/${bookingId}/cancel`, { token: financeA.token, body: { reason: 'Venue closed by authorities', refundAmount: '12000' } });
    const [first] = await refundsOf(bookingId);
    expect((await api(ctx, 'POST', `/v1/admin/refunds/${first.id}/approve`, { token: financeA.token })).body.error.code).toBe('FOUR_EYES_REQUIRED');
    expect((await api(ctx, 'POST', `/v1/admin/refunds/${first.id}/approve`, { token: financeB.token })).status).toBe(200);
  });
});

describe('refund safety (tests 21-22, clauses 50, 72)', () => {
  it('never refunds more than was paid, by API or directly in the database, and ignores repeated notices', async () => {
    const { p, serviceId } = await hall();
    const { bookingId } = await paidBooking(serviceId);
    await api(ctx, 'POST', `/v1/provider/bookings/${bookingId}/cancel`, { token: p.token, body: { reason: 'Double booked' } });
    // 20,000 already requested: anything more is refused.
    expect((await api(ctx, 'POST', `/v1/admin/bookings/${bookingId}/refunds`, { token: financeA.token, body: { amount: '1', reason: 'Extra goodwill' } })).body.error.code).toBe('REFUND_EXCEEDS_REFUNDABLE');
    const pay = (await ctx.db.query(`SELECT payment_id FROM payment_allocations WHERE booking_id = $1 LIMIT 1`, [bookingId])).rows[0].payment_id;
    await expect(ctx.db.query(
      `INSERT INTO refunds (booking_id, payment_id, amount, currency_code, source, reason, method, requested_by_kind) VALUES ($1, $2, 1, 'SAR', 'manual', 'x', 'bank_transfer', 'system')`,
      [bookingId, pay])).rejects.toThrow(/exceeds refundable/);

    const [r] = (await refundsOf(bookingId)).filter((x: { status: string }) => x.status === 'requested');
    await api(ctx, 'POST', `/v1/admin/refunds/${r.id}/approve`, { token: financeB.token });
    await api(ctx, 'POST', `/v1/admin/refunds/${r.id}/execute`, { token: financeB.token });
    const ref = (await ctx.db.query('SELECT external_ref FROM refunds WHERE id = $1', [r.id])).rows[0].external_ref;
    const ev = { id: `evt_${uniq()}`, type: 'refund.succeeded', data: { reference: ref, amount: r.amount, currency: 'SAR' } };
    expect((await webhook(ev)).result).toBe('processed');
    expect((await webhook(ev)).result).toBe('duplicate');
    expect((await webhook({ ...ev, id: `evt_${uniq()}` })).result).toBe('duplicate');
    const posted = (await ctx.db.query(`SELECT count(*)::int AS n FROM journal_entries WHERE source_type = 'refund_payment' AND source_id = $1`, [r.id])).rows[0].n;
    expect(posted).toBe(1);
    // The original payment is untouched: a refund is its own record (clause 50).
    expect((await ctx.db.query('SELECT status FROM payments WHERE id = $1', [r.paymentId])).rows[0].status).toBe('succeeded');
    await expect(ctx.db.query('DELETE FROM refunds WHERE id = $1', [r.id])).rejects.toThrow(/append-only/);
  });

  it('reverses a failed refund and allows a new request', async () => {
    const { p, serviceId } = await hall();
    const { bookingId } = await paidBooking(serviceId);
    await api(ctx, 'POST', `/v1/provider/bookings/${bookingId}/cancel`, { token: p.token, body: { reason: 'Closed' } });
    const refunds = await refundsOf(bookingId);
    const r = refunds[0];
    await api(ctx, 'POST', `/v1/admin/refunds/${r.id}/approve`, { token: financeB.token });
    await api(ctx, 'POST', `/v1/admin/refunds/${r.id}/execute`, { token: financeB.token });
    const ref = (await ctx.db.query('SELECT external_ref FROM refunds WHERE id = $1', [r.id])).rows[0].external_ref;
    await webhook({ id: `evt_${uniq()}`, type: 'refund.failed', data: { reference: ref, amount: r.amount, currency: 'SAR', reason: 'card_expired' } });
    expect((await api(ctx, 'GET', `/v1/admin/refunds/${r.id}`, { token: financeA.token })).body).toMatchObject({ status: 'failed', failureReason: 'card_expired' });
    // The booking is not closed while the customer is still owed money.
    expect((await earningOf(bookingId)).status).toBe('not_due');
    const again = await api(ctx, 'POST', `/v1/admin/bookings/${bookingId}/refunds`, { token: financeA.token, body: { amount: r.amount, reason: 'Retry after failed card refund', source: 'booking_cancelled' } });
    expect(again.status).toBe(201);
  });
});

describe('no-show applies the cancellation policy (owner decision)', () => {
  it('treats a no-show as cancelling at the start time', async () => {
    const { p, serviceId } = await hall({ ...POLICY, tiers: [{ hoursBefore: 720, refundPercentOfPaid: 100 }, { hoursBefore: 0, refundPercentOfPaid: 25 }] });
    const { c, bookingId } = await paidBooking(serviceId);
    await ctx.db.query(`UPDATE bookings SET start_at = now() - interval '3 hours', end_at = now() - interval '1 hour' WHERE id = $1`, [bookingId]);
    const r = await api(ctx, 'POST', `/v1/provider/bookings/${bookingId}/no-show`, { token: p.token });
    // 25% of (20,000 paid − 5,000 non-refundable deposit) = 3,750 back to the customer.
    expect(r.body).toMatchObject({ status: 'no_show', quote: { hoursBefore: 0, refundPercent: 25, refund: '3750.0000', retained: '16250.0000' } });
    await completeRefundsByGateway(bookingId);
    expect(await earningOf(bookingId)).toEqual({ status: 'due', commission_amount: '1625.0000', net_amount: '14625.0000' });
    expect((await ctx.db.query(`SELECT 1 FROM message_outbox WHERE recipient_user_id = $1 AND template_key = 'booking.no_show'`, [c.userId])).rowCount).toBe(1);
  });

  it('goes to staff review when the booking has no policy', async () => {
    const p = await approvedProvider(ctx, supervisor.token, country.code);
    await api(ctx, 'PUT', `/v1/admin/providers/${p.providerId}/service-types`, { token: admin.token, body: { serviceTypeIds: [hallType] } });
    const s = await api(ctx, 'POST', '/v1/provider/services', {
      token: p.token, body: { serviceTypeId: hallType, title: { en: 'No policy' }, description: { en: 'D' }, city: 'Riyadh', currency: 'SAR', basePrice: '20000', pricingUnit: 'fixed', requiresProviderApproval: false },
    });
    await upload(ctx, `/v1/provider/services/${s.body.id}/media`, p.token, PNG);
    await api(ctx, 'POST', `/v1/provider/services/${s.body.id}/submit`, { token: p.token });
    await api(ctx, 'POST', `/v1/admin/services/${s.body.id}/actions`, { token: supervisor.token, body: { action: 'publish' } });
    const c = await customer();
    await api(ctx, 'POST', '/v1/cart/items', { token: c.token, body: { serviceId: s.body.id, date: nextDate() } });
    const o = JSON.parse((await ctx.app.inject({ method: 'POST', url: '/v1/checkout', headers: { authorization: `Bearer ${c.token}`, 'idempotency-key': randomUUID() }, payload: { acceptTerms: true } })).body);
    await pay(c.token, o.id, 'upfront');
    const bookingId = o.bookings[0].id;
    await ctx.db.query(`UPDATE bookings SET start_at = now() - interval '3 hours', end_at = now() - interval '1 hour' WHERE id = $1`, [bookingId]);
    expect((await api(ctx, 'POST', `/v1/provider/bookings/${bookingId}/no-show`, { token: p.token })).body.quote.mode).toBe('review');
    const pending = (await api(ctx, 'GET', '/v1/admin/cancellation-requests', { token: financeA.token })).body.find((x: { bookingId: string }) => x.bookingId === bookingId);
    expect(pending).toBeTruthy();
    await api(ctx, 'POST', `/v1/admin/cancellation-requests/${pending.id}/decide`, { token: financeA.token, body: { decision: 'reject', reason: 'No refund for no-show per contract' } });
    expect((await earningOf(bookingId)).status).toBe('due'); // everything retained, commission applied
  });
});

describe('settlements (tests 25-26, clauses 43-44)', () => {
  async function completed(serviceId: string, provToken: string) {
    const b = await paidBooking(serviceId);
    await ctx.db.query(`UPDATE bookings SET start_at = now() - interval '3 hours', end_at = now() - interval '1 hour' WHERE id = $1`, [b.bookingId]);
    expect((await api(ctx, 'POST', `/v1/provider/bookings/${b.bookingId}/complete`, { token: provToken })).body.status).toBe('completed');
    return b;
  }

  it('settles due earnings once, with four-eyes approval, and records the payout', async () => {
    const { p, serviceId } = await hall();
    const b1 = await completed(serviceId, p.token);
    const b2 = await completed(serviceId, p.token);
    const preview = (await api(ctx, 'GET', `/v1/admin/settlements/preview?providerId=${p.providerId}&currency=SAR`, { token: financeA.token })).body;
    expect(preview.total).toBe('36000.0000');

    const before = await balances();
    const s = await api(ctx, 'POST', '/v1/admin/settlements', { token: financeA.token, body: { providerId: p.providerId, currency: 'SAR', accountId: bankAccount, method: 'bank_transfer' } });
    expect(s.body).toMatchObject({ amount: '36000.0000' });
    expect((await earningOf(b1.bookingId)).status).toBe('ready_for_settlement');
    // The same earnings cannot go into a second settlement.
    expect((await api(ctx, 'POST', '/v1/admin/settlements', { token: financeB.token, body: { providerId: p.providerId, currency: 'SAR', accountId: bankAccount, method: 'bank_transfer' } })).body.error.code).toBe('NOTHING_TO_SETTLE');

    expect((await api(ctx, 'POST', `/v1/admin/settlements/${s.body.id}/approve`, { token: financeA.token })).body.error.code).toBe('FOUR_EYES_REQUIRED');
    expect((await api(ctx, 'POST', `/v1/admin/settlements/${s.body.id}/mark-paid`, { token: financeB.token, body: { externalRef: 'TRX-1' } })).status).toBe(409); // not approved yet
    await api(ctx, 'POST', `/v1/admin/settlements/${s.body.id}/approve`, { token: financeB.token });
    expect((await api(ctx, 'POST', `/v1/admin/settlements/${s.body.id}/mark-paid`, { token: financeB.token, body: { externalRef: 'BANK-TRX-7781' } })).body.status).toBe('paid');

    const after = await balances();
    expect(after['1200-P7']! - (before['1200-P7'] ?? 0)).toBe(-36000);
    expect(after['2110']! - before['2110']!).toBe(-36000);
    expect((await earningOf(b2.bookingId)).status).toBe('settled');
    expect((await api(ctx, 'GET', '/v1/provider/settlements', { token: p.token })).body[0]).toMatchObject({ amount: '36000.0000', status: 'paid', externalRef: 'BANK-TRX-7781' });
    expect((await api(ctx, 'POST', '/v1/admin/settlements', { token: financeA.token, body: { providerId: p.providerId, currency: 'SAR', accountId: bankAccount, method: 'bank_transfer' } })).body.error.code).toBe('NOTHING_TO_SETTLE');
  });

  it('makes failed settlements available again and excludes earnings on hold', async () => {
    const { p, serviceId } = await hall();
    const b1 = await completed(serviceId, p.token);
    const b2 = await completed(serviceId, p.token);
    // Phase 8 places disputed earnings on hold; held earnings are never settled automatically.
    await ctx.db.query(`UPDATE provider_earnings SET status = 'on_hold_dispute' WHERE booking_id = $1`, [b2.bookingId]);
    const s = await api(ctx, 'POST', '/v1/admin/settlements', { token: financeA.token, body: { providerId: p.providerId, currency: 'SAR', accountId: bankAccount, method: 'bank_transfer' } });
    expect(s.body.amount).toBe('18000.0000');
    await api(ctx, 'POST', `/v1/admin/settlements/${s.body.id}/approve`, { token: financeB.token });
    await api(ctx, 'POST', `/v1/admin/settlements/${s.body.id}/mark-failed`, { token: financeB.token, body: { reason: 'IBAN rejected by bank' } });
    expect((await earningOf(b1.bookingId)).status).toBe('settlement_failed');
    const retry = await api(ctx, 'POST', '/v1/admin/settlements', { token: financeA.token, body: { providerId: p.providerId, currency: 'SAR', accountId: bankAccount, method: 'bank_transfer' } });
    expect(retry.body.amount).toBe('18000.0000');
  });

  it('allows interim settlement only for eligible providers, within the agreed share, and deducts it at completion', async () => {
    const { p, serviceId } = await hall();
    const b = await paidBooking(serviceId); // 20,000 collected, 2,000 commission → provider share 18,000
    const interim = (amount: string) => api(ctx, 'POST', '/v1/admin/settlements', { token: financeA.token, body: { providerId: p.providerId, currency: 'SAR', accountId: bankAccount, method: 'bank_transfer', kind: 'interim', bookingId: b.bookingId, amount } });
    expect((await interim('1000')).body.error.code).toBe('INTERIM_NOT_ALLOWED');

    expect((await api(ctx, 'PATCH', `/v1/admin/providers/${p.providerId}/interim-settlement`, { token: financeA.token, body: { eligible: true, maxPercent: 50, reason: 'Missing agreement' } })).status).toBe(400);
    await api(ctx, 'PATCH', `/v1/admin/providers/${p.providerId}/interim-settlement`, { token: financeA.token, body: { eligible: true, maxPercent: 50, agreementRef: 'AGR-2027-014', reason: 'Signed agreement' } });
    expect((await interim('9000.01')).body.error.code).toBe('INTERIM_NOT_ALLOWED'); // cap = 50% of 18,000
    const s = await interim('9000');
    expect(s.status).toBe(201);
    await api(ctx, 'POST', `/v1/admin/settlements/${s.body.id}/approve`, { token: financeB.token });
    const before = await balances();
    await api(ctx, 'POST', `/v1/admin/settlements/${s.body.id}/mark-paid`, { token: financeB.token, body: { externalRef: 'INTERIM-1' } });
    const mid = await balances();
    expect(mid['2200']! - before['2200']!).toBe(-9000);
    expect((await interim('1')).body.error.code).toBe('INTERIM_NOT_ALLOWED'); // cap used up

    await ctx.db.query(`UPDATE bookings SET start_at = now() - interval '3 hours', end_at = now() - interval '1 hour' WHERE id = $1`, [b.bookingId]);
    await api(ctx, 'POST', `/v1/provider/bookings/${b.bookingId}/complete`, { token: p.token });
    const after = await balances();
    expect(after['2110']! - mid['2110']!).toBe(9000); // 18,000 earned − 9,000 already paid
    const preview = (await api(ctx, 'GET', `/v1/admin/settlements/preview?providerId=${p.providerId}&currency=SAR`, { token: financeA.token })).body;
    expect(preview.total).toBe('9000.0000');
    expect((await api(ctx, 'GET', `/v1/admin/ledger/trial-balance?countryId=${country.id}&currency=SAR`, { token: financeA.token })).body.totals.balanced).toBe(true);
  });
});
