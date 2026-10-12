import { createHmac, randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, approvedProvider, createStaff, latestCode, PNG, register, setupCountry, uniq, upload, useApp } from './helpers.js';

const ctx = useApp();
const SECRET = 'sandbox-secret-for-phase9-tests-0123';
process.env.PAY_SANDBOX_P9_SECRET = SECRET;

let admin: { token: string; id: string };
let supervisor: { token: string };
let financeA: { token: string; id: string };
let financeB: { token: string; id: string };
let otherFinance: { token: string };
let support: { token: string };
let country: { id: string; code: string };
let hallType: string;
let integrationId: string;
let bankAccount: string;

let dayCounter = 0;
const nextDate = () => new Date(Date.UTC(2027, 10, 1 + dayCounter++)).toISOString().slice(0, 10);
const today = () => new Date().toISOString().slice(0, 10);
const shift = (days: number) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

const POLICY = {
  name: { en: 'Standard' }, description: { en: 'Full refund > 30 days' },
  tiers: [{ hoursBefore: 720, refundPercentOfPaid: 100 }, { hoursBefore: 0, refundPercentOfPaid: 0 }],
  depositRefundable: true,
};

/** A published hall (20,000 SAR, 25% deposit). */
async function hall() {
  const p = await approvedProvider(ctx, supervisor.token, country.code);
  await api(ctx, 'PUT', `/v1/admin/providers/${p.providerId}/service-types`, { token: admin.token, body: { serviceTypeIds: [hallType] } });
  const pol = await api(ctx, 'POST', '/v1/provider/cancellation-policies', { token: p.token, body: POLICY });
  const s = await api(ctx, 'POST', '/v1/provider/services', {
    token: p.token,
    body: { serviceTypeId: hallType, title: { ar: 'قاعة', en: 'Hall' }, description: { en: 'D' }, city: 'Riyadh', currency: 'SAR', basePrice: '20000', pricingUnit: 'fixed',
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
  return { ...p, externalRef: ref as string };
}

async function booking(serviceId: string, opts: { balance: boolean } = { balance: true }) {
  const c = await customer();
  await api(ctx, 'POST', '/v1/cart/items', { token: c.token, body: { serviceId, date: nextDate() } });
  const r = await ctx.app.inject({ method: 'POST', url: '/v1/checkout', headers: { authorization: `Bearer ${c.token}`, 'idempotency-key': randomUUID() }, payload: { acceptTerms: true } });
  const order = JSON.parse(r.body);
  const deposit = await pay(c.token, order.id, 'upfront');
  const balance = opts.balance ? await pay(c.token, order.id, 'balance') : null;
  return { c, orderId: order.id as string, bookingId: order.bookings[0].id as string, deposit, balance };
}

const docsOf = async (bookingId: string) => (await ctx.db.query(
  `SELECT d.* FROM documents d WHERE d.booking_id = $1 OR d.source_id IN (SELECT payment_id FROM payment_allocations WHERE booking_id = $1) ORDER BY d.issued_at, d.number`, [bookingId])).rows;

beforeAll(async () => {
  admin = await createStaff(ctx, [{ code: 'system_admin' }]);
  country = await setupCountry(ctx, admin.token);
  const other = await setupCountry(ctx, admin.token);
  supervisor = await createStaff(ctx, [{ code: 'services_supervisor', countryId: country.id }]);
  financeA = await createStaff(ctx, [{ code: 'finance_officer', countryId: country.id }]);
  financeB = await createStaff(ctx, [{ code: 'finance_officer', countryId: country.id }]);
  otherFinance = await createStaff(ctx, [{ code: 'finance_officer', countryId: other.id }]);
  support = await createStaff(ctx, [{ code: 'support_agent', countryId: country.id }]);
  // Prices include VAT in this country: invoices show the included tax.
  await api(ctx, 'PATCH', `/v1/admin/countries/${country.id}`, {
    token: admin.token,
    body: { taxSettings: { rate: '15', label: { ar: 'ضريبة القيمة المضافة', en: 'VAT' }, pricesIncludeTax: true }, invoiceSettings: { legalName: 'Platform Co.' }, reason: 'Tax setup' },
  });
  await api(ctx, 'PUT', '/v1/admin/settings/documents.platform_name', { token: admin.token, body: { scope: 'country', countryId: country.id, value: { ar: 'منصة الأفراح', en: 'Celebrations' }, reason: 'Brand' } });
  const categoryId = (await api(ctx, 'POST', '/v1/admin/categories', { token: admin.token, body: { slug: `c-${uniq()}`, name: { en: 'C' }, countryIds: [country.id] } })).body.id;
  hallType = (await api(ctx, 'POST', '/v1/admin/service-types', { token: admin.token, body: { categoryId, code: `t_${uniq()}`.slice(0, 40), name: { en: 'Hall' }, bookingMode: 'full_day', pricingUnits: ['fixed'] } })).body.id;
  const gw = (await api(ctx, 'POST', '/v1/admin/accounts', { token: admin.token, body: { countryId: country.id, currency: 'SAR', kind: 'gateway', suffix: 'P9', name: { en: 'Gateway' } } })).body.id;
  bankAccount = (await api(ctx, 'POST', '/v1/admin/accounts', { token: admin.token, body: { countryId: country.id, currency: 'SAR', kind: 'bank', suffix: 'P9', name: { en: 'Bank' } } })).body.id;
  integrationId = (await api(ctx, 'POST', '/v1/admin/payment-integrations', { token: admin.token, body: { providerCode: 'sandbox', name: 'Sandbox', countryId: country.id, kind: 'gateway', environment: 'test', secretRef: 'PAY_SANDBOX_P9_SECRET' } })).body.id;
  await api(ctx, 'PATCH', `/v1/admin/payment-integrations/${integrationId}`, { token: admin.token, body: { isActive: true, reason: 'Enable for tests' } });
  await api(ctx, 'POST', '/v1/admin/payment-methods', { token: admin.token, body: { countryId: country.id, model: 'platform', method: 'card', integrationId, accountId: gw } });
  await api(ctx, 'POST', '/v1/admin/commission-rules', { token: admin.token, body: { scope: 'country', countryId: country.id, rateType: 'percent', rateValue: '10' } });
});

describe('issued documents (clause 65)', () => {
  it('issues one numbered invoice at confirmation and a receipt per payment, frozen and immutable', async () => {
    const { serviceId } = await hall();
    const b = await booking(serviceId);
    const docs = await docsOf(b.bookingId);
    expect(docs.map((d) => d.kind).sort()).toEqual(['deposit_receipt', 'invoice', 'payment_receipt']);
    const year = new Date().getUTCFullYear();
    for (const d of docs) expect(d.number).toMatch(new RegExp(`^(INV|DEP|RCT)-${country.code}-${year}-\\d{6}$`));

    const invoice = docs.find((d) => d.kind === 'invoice')!;
    expect(invoice.total).toBe('20000.0000');
    expect(invoice.data).toMatchObject({
      platformName: { ar: 'منصة الأفراح', en: 'Celebrations' }, issuer: { legalName: 'Platform Co.' },
      total: '20000.0000', upfrontRequired: '5000.0000', paidAtIssue: '5000.0000', remainingAtIssue: '15000.0000',
      tax: { rate: '15', includedAmount: '2608.7000' },
    });
    // The customer never sees the platform commission on the invoice.
    expect(JSON.stringify(invoice.data)).not.toContain('commission');
    expect(docs.find((d) => d.kind === 'deposit_receipt')!.total).toBe('5000.0000');
    expect(docs.find((d) => d.kind === 'payment_receipt')!.total).toBe('15000.0000');

    // Issued content cannot be edited or deleted, and settings changes do not alter it.
    await expect(ctx.db.query('UPDATE documents SET total = 1 WHERE id = $1', [invoice.id])).rejects.toThrow();
    await expect(ctx.db.query('DELETE FROM documents WHERE id = $1', [invoice.id])).rejects.toThrow();
    await api(ctx, 'PUT', '/v1/admin/settings/documents.platform_name', { token: admin.token, body: { scope: 'country', countryId: country.id, value: { ar: 'اسم جديد', en: 'New name' }, reason: 'Rebrand' } });
    expect((await api(ctx, 'GET', `/v1/documents/${invoice.id}`, { token: b.c.token })).body.data.platformName.en).toBe('Celebrations');
    await api(ctx, 'PUT', '/v1/admin/settings/documents.platform_name', { token: admin.token, body: { scope: 'country', countryId: country.id, value: { ar: 'منصة الأفراح', en: 'Celebrations' }, reason: 'Revert' } });

    // Re-issuing for the same event returns the same document (no duplicate number).
    const { issueInvoice } = await import('../src/modules/documents/service.js');
    expect((await issueInvoice(ctx.db, b.bookingId)).number).toBe(invoice.number);
  });

  it('prints bilingual HTML and limits access to the parties and authorised staff', async () => {
    const { p, serviceId } = await hall();
    const b = await booking(serviceId, { balance: false });
    const invoice = (await docsOf(b.bookingId)).find((d) => d.kind === 'invoice')!;

    const list = (await api(ctx, 'GET', '/v1/documents', { token: b.c.token })).body;
    expect(list.map((d: { number: string }) => d.number)).toContain(invoice.number);
    expect((await api(ctx, 'GET', '/v1/documents', { token: p.token })).body.map((d: { number: string }) => d.number)).toContain(invoice.number);

    const ar = await ctx.app.inject({ method: 'GET', url: `/v1/documents/${invoice.id}?format=html&lang=ar`, headers: { authorization: `Bearer ${b.c.token}` } });
    expect(ar.headers['content-type']).toContain('text/html');
    expect(ar.body).toContain('dir="rtl"');
    expect(ar.body).toContain(invoice.number);
    expect(ar.body).toContain('فاتورة حجز');
    expect(ar.body).toContain('ضريبة القيمة المضافة');
    const en = await ctx.app.inject({ method: 'GET', url: `/v1/documents/${invoice.id}?format=html&lang=en`, headers: { authorization: `Bearer ${p.token}` } });
    expect(en.body).toContain('dir="ltr"');
    expect(en.body).toContain('Booking invoice');

    const stranger = await customer();
    expect((await api(ctx, 'GET', `/v1/documents/${invoice.id}`, { token: stranger.token })).status).toBe(404);
    expect((await api(ctx, 'GET', `/v1/documents/${invoice.id}`, { token: financeA.token })).status).toBe(200);
    expect((await api(ctx, 'GET', `/v1/documents/${invoice.id}`, { token: otherFinance.token })).status).toBe(404);
    expect((await api(ctx, 'GET', `/v1/documents/${invoice.id}`, { token: support.token })).status).toBe(404);
    expect((await api(ctx, 'GET', `/v1/admin/documents?bookingId=${b.bookingId}`, { token: financeA.token })).body).toHaveLength(1);
    expect((await api(ctx, 'GET', `/v1/admin/documents?country=${country.id}`, { token: otherFinance.token })).status).toBe(403);

    // Statements are generated on demand and not numbered.
    const st = (await api(ctx, 'GET', `/v1/bookings/${b.bookingId}/statement`, { token: b.c.token })).body;
    expect(st).toMatchObject({ kind: 'booking_statement', total: '20000.0000', paid: '5000.0000', remaining: '15000.0000', refunded: '0.0000' });
    expect(st.documents).toHaveLength(2);
    const notice = (await api(ctx, 'GET', `/v1/bookings/${b.bookingId}/balance-notice`, { token: p.token })).body;
    expect(notice).toMatchObject({ remaining: '15000.0000' });
    const html = await ctx.app.inject({ method: 'GET', url: `/v1/bookings/${b.bookingId}/statement?format=html&lang=en`, headers: { authorization: `Bearer ${b.c.token}` } });
    expect(html.body).toContain('not a numbered document');
    expect((await api(ctx, 'GET', `/v1/bookings/${b.bookingId}/statement`, { token: stranger.token })).status).toBe(404);
    const history = (await api(ctx, 'GET', '/v1/me/payment-history', { token: b.c.token })).body;
    expect(history.payments).toHaveLength(1);

    // Dispute record: the parties and staff with dispute access; internal notes stay with staff.
    const d = await api(ctx, 'POST', '/v1/disputes', { token: b.c.token, body: { bookingId: b.bookingId, type: 'billing', subject: 'Charged twice', description: 'I think I was charged twice for the deposit.' } });
    expect(d.status).toBe(201);
    const rec = (await api(ctx, 'GET', `/v1/disputes/${d.body.id}/record`, { token: p.token })).body;
    expect(rec).toMatchObject({ kind: 'dispute_record', dispute: { subject: 'Charged twice' } });
    expect((await api(ctx, 'GET', `/v1/disputes/${d.body.id}/record`, { token: stranger.token })).status).toBe(404);
    expect((await api(ctx, 'GET', `/v1/disputes/${d.body.id}/record`, { token: support.token })).status).toBe(200);
    expect((await api(ctx, 'GET', `/v1/disputes/${d.body.id}/record`, { token: otherFinance.token })).status).toBe(404);
  });

  it('issues a refund note when money goes back and a settlement note when a provider is paid', async () => {
    const { p, serviceId } = await hall();
    // Refund: cancel more than 30 days ahead, full refund through the gateway.
    const b = await booking(serviceId);
    await api(ctx, 'POST', `/v1/bookings/${b.bookingId}/cancel`, { token: b.c.token, body: { reason: 'Plans changed' } });
    const refunds = (await api(ctx, 'GET', `/v1/admin/refunds?bookingId=${b.bookingId}`, { token: financeA.token })).body;
    for (const r of refunds) {
      await api(ctx, 'POST', `/v1/admin/refunds/${r.id}/approve`, { token: financeB.token });
      await api(ctx, 'POST', `/v1/admin/refunds/${r.id}/execute`, { token: financeB.token });
      const ref = (await ctx.db.query('SELECT external_ref FROM refunds WHERE id = $1', [r.id])).rows[0].external_ref;
      await webhook({ id: `evt_${uniq()}`, type: 'refund.succeeded', data: { reference: ref, amount: r.amount, currency: 'SAR' } });
    }
    const notes = (await docsOf(b.bookingId)).filter((d) => d.kind === 'refund_note');
    expect(notes.reduce((s, n) => s + Number(n.total), 0)).toBe(20000);
    expect(notes[0].number).toMatch(new RegExp(`^RFN-${country.code}-`));

    // Settlement: complete another booking and pay the provider.
    const done = await booking(serviceId);
    await ctx.db.query(`UPDATE bookings SET start_at = now() - interval '3 hours', end_at = now() - interval '1 hour' WHERE id = $1`, [done.bookingId]);
    await api(ctx, 'POST', `/v1/provider/bookings/${done.bookingId}/complete`, { token: p.token });
    const s = await api(ctx, 'POST', '/v1/admin/settlements', { token: financeA.token, body: { providerId: p.providerId, currency: 'SAR', accountId: bankAccount, method: 'bank_transfer' } });
    await api(ctx, 'POST', `/v1/admin/settlements/${s.body.id}/approve`, { token: financeB.token });
    await api(ctx, 'POST', `/v1/admin/settlements/${s.body.id}/mark-paid`, { token: financeB.token, body: { externalRef: 'BANK-P9-1' } });
    const note = (await ctx.db.query(`SELECT * FROM documents WHERE kind = 'settlement_note' AND source_id = $1`, [s.body.id])).rows[0];
    expect(note).toMatchObject({ total: '18000.0000', provider_id: p.providerId, customer_id: null });
    expect(note.data.items).toEqual([expect.objectContaining({ amount: '18000.0000', commission: '2000.0000' })]);
    // The provider sees its settlement note; the customer does not.
    expect((await api(ctx, 'GET', `/v1/documents/${note.id}`, { token: p.token })).status).toBe(200);
    expect((await api(ctx, 'GET', `/v1/documents/${note.id}`, { token: done.c.token })).status).toBe(404);

    // Provider report (clause 62).
    const rep = (await api(ctx, 'GET', '/v1/provider/reports/summary', { token: p.token })).body;
    expect(rep.rows).toEqual([expect.objectContaining({ bookings: 2, completed: 1, cancelledOrNoShow: 1, commission: '2000.0000', net: '18000.0000', settled: '18000.0000', outstanding: '0.0000', refunded: '20000.0000' })]);
  });
});

describe('reports (clauses 61-63)', () => {
  it('reports per country and currency, with revenue limited to recognised commission', async () => {
    const overview = await api(ctx, 'GET', `/v1/admin/reports/overview?country=${country.id}`, { token: financeA.token });
    expect(overview.status).toBe(200);
    const row = overview.body.rows.find((r: { currency: string }) => r.currency === 'SAR');
    expect(row.bookingsCreated).toBeGreaterThanOrEqual(4);
    expect(Number(row.commissionRevenue)).toBeGreaterThanOrEqual(2000);
    expect(overview.body.counts[0]).toMatchObject({ countryId: country.id });
    expect(overview.body.notes[0]).toContain('not platform revenue');

    const revenue = (await api(ctx, 'GET', `/v1/admin/reports/revenue?country=${country.id}`, { token: financeA.token })).body.rows[0];
    expect(revenue).toMatchObject({ currency: 'SAR' });
    expect(revenue.commissionRevenue).toBe(row.commissionRevenue);

    const tb = (await api(ctx, 'GET', `/v1/admin/reports/trial-balance?country=${country.id}`, { token: financeA.token })).body;
    expect(tb.notes).toEqual(['Balanced for every country and currency.']);

    // Every report runs within the user's country scope.
    for (const name of (await api(ctx, 'GET', '/v1/admin/reports', { token: financeA.token })).body.reports as string[]) {
      const r = await api(ctx, 'GET', `/v1/admin/reports/${name}?country=${country.id}&from=${shift(-400)}&to=${shift(400)}`, { token: financeA.token });
      expect(r.status, name).toBe(200);
      expect(Array.isArray(r.body.rows), name).toBe(true);
    }
    const scoped = (await api(ctx, 'GET', '/v1/admin/reports/payments-by-currency', { token: otherFinance.token })).body.rows;
    expect(scoped.some((r: { countryId: string }) => r.countryId === country.id)).toBe(false);
    expect((await api(ctx, 'GET', `/v1/admin/reports/revenue?country=${country.id}`, { token: otherFinance.token })).status).toBe(403);
    expect((await api(ctx, 'GET', '/v1/admin/reports/revenue', { token: support.token })).status).toBe(403);
  });

  it('converts only with a documented rate and keeps the original amounts', async () => {
    const missing = await api(ctx, 'GET', `/v1/admin/reports/revenue?country=${country.id}&displayCurrency=KWD&rateDate=2000-01-01`, { token: financeA.token });
    expect(missing.status).toBe(409);
    expect(missing.body.error.code).toBe('FX_RATE_MISSING');

    await api(ctx, 'POST', '/v1/admin/exchange-rates', { token: admin.token, body: { base: 'SAR', quote: 'EUR', rate: '0.2450', effectiveAt: '2030-06-01T00:00:00Z', source: 'Test bulletin' } });
    const r = (await api(ctx, 'GET', `/v1/admin/reports/revenue?country=${country.id}&displayCurrency=EUR&rateDate=2030-06-02`, { token: financeA.token })).body;
    const row = r.rows[0];
    expect(row.currency).toBe('SAR');
    expect(row.commissionRevenueConverted).toBe((Math.round(Number(row.commissionRevenue) * 0.245 * 100) / 100).toFixed(4));
    expect(r.fxRates).toEqual([expect.objectContaining({ from: 'SAR', to: 'EUR', rate: '0.2450000000', source: 'Test bulletin' })]);
    const run = (await ctx.db.query(`SELECT * FROM report_runs WHERE generated_by = $1 AND report = 'revenue' ORDER BY generated_at DESC LIMIT 1`, [financeA.id])).rows[0];
    expect(run.fx_rates[0]).toMatchObject({ from: 'SAR', to: 'EUR' });
  });

  it('exports CSV with permission, logging who exported what', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: `/v1/admin/reports/provider-earnings?country=${country.id}&format=csv`, headers: { authorization: `Bearer ${financeA.token}` } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.body.startsWith('﻿countryId,currency,providerId')).toBe(true);
    const audit = (await ctx.db.query(`SELECT * FROM audit_log WHERE actor_id = $1 AND action = 'report.exported' ORDER BY created_at DESC LIMIT 1`, [financeA.id])).rows[0];
    expect(audit.after).toMatchObject({ report: 'provider-earnings' });
    expect((await ctx.db.query(`SELECT count(*)::int AS n FROM report_runs WHERE generated_by = $1 AND format = 'csv'`, [financeA.id])).rows[0].n).toBe(1);
    await expect(ctx.db.query(`DELETE FROM report_runs WHERE generated_by = $1`, [financeA.id])).rejects.toThrow();

    const { toCsv } = await import('../src/modules/reports/csv.js');
    expect(toCsv([{ a: '=SUM(A1)', b: '-12.5', c: 'x,"y"' }])).toBe('﻿a,b,c\r\n\'=SUM(A1),-12.5,"x,""y"""\r\n');
  });
});

describe('reconciliation (clause 39)', () => {
  it('matches a provider statement and lists every difference for follow-up', async () => {
    const { serviceId } = await hall();
    const b1 = await booking(serviceId);
    const b2 = await booking(serviceId, { balance: false });
    const lines = [
      { externalRef: b1.deposit.externalRef, kind: 'payment', amount: '5000', currency: 'SAR' },
      { externalRef: b1.balance!.externalRef, kind: 'payment', amount: '14900.00', currency: 'SAR' },
      { externalRef: 'UNKNOWN-REF-1', kind: 'payment', amount: '100', currency: 'SAR' },
    ];
    const body = { countryId: country.id, integrationId, periodFrom: shift(-1), periodTo: shift(1), sourceName: 'Sandbox settlement report', lines };
    expect((await api(ctx, 'POST', '/v1/admin/reconciliation/runs', { token: otherFinance.token, body })).status).toBe(403);
    expect((await api(ctx, 'POST', '/v1/admin/reconciliation/runs', { token: financeA.token, body: { ...body, lines: [...lines, lines[0]] } })).status).toBe(400);
    const run = await api(ctx, 'POST', '/v1/admin/reconciliation/runs', { token: financeA.token, body });
    expect(run.status).toBe(201);

    const detail = (await api(ctx, 'GET', `/v1/admin/reconciliation/runs/${run.body.id}`, { token: financeA.token })).body;
    const byRef = (ref: string) => detail.items.find((i: { externalRef: string }) => i.externalRef === ref);
    expect(byRef(b1.deposit.externalRef).status).toBe('matched');
    expect(byRef(b1.balance!.externalRef)).toMatchObject({ status: 'amount_mismatch', statementAmount: '14900.0000', platformAmount: '15000.0000' });
    expect(byRef('UNKNOWN-REF-1').status).toBe('missing_in_platform');
    expect(byRef(b2.deposit.externalRef).status).toBe('missing_in_statement');

    const item = byRef(b1.balance!.externalRef);
    expect((await api(ctx, 'POST', `/v1/admin/reconciliation/items/${item.id}/resolve`, { token: financeB.token, body: { resolution: 'Provider fee withheld; confirmed with provider' } })).status).toBe(200);
    expect((await api(ctx, 'POST', `/v1/admin/reconciliation/items/${item.id}/resolve`, { token: financeB.token, body: { resolution: 'again' } })).body.error.code).toBe('RECONCILIATION_ITEM_RESOLVED');
    await expect(ctx.db.query(`UPDATE reconciliation_items SET status = 'matched' WHERE id = $1`, [item.id])).rejects.toThrow();
    const unresolved = (await api(ctx, 'GET', `/v1/admin/reconciliation/runs/${run.body.id}?unresolved=true`, { token: financeA.token })).body.items;
    expect(unresolved.some((i: { id: string }) => i.id === item.id)).toBe(false);
  });

  it('cross-checks operations against the ledger', async () => {
    const r = (await api(ctx, 'GET', `/v1/admin/reconciliation/checks?country=${country.id}`, { token: financeA.token })).body;
    expect(r.checks).toEqual({
      unbalancedEntries: [], paymentsWithoutEntry: [], paymentAllocationMismatch: [], completedWithoutEntry: [],
      refundsWithoutEntry: [], settlementsWithoutEntry: [], advancesMismatch: [],
    });
    expect(r.ok).toBe(true);
    expect((await api(ctx, 'GET', '/v1/admin/reconciliation/checks', { token: support.token })).status).toBe(403);
  });
});
