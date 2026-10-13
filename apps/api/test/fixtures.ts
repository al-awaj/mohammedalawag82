import { createHmac, randomUUID } from 'node:crypto';
import { api, approvedProvider, createStaff, latestCode, PNG, register, setupCountry, uniq, upload, type Ctx } from './helpers.js';

/**
 * A ready marketplace in a fresh country: staff, a full-day hall type, a sandbox card gateway, a bank
 * account with transfers, and a 10% commission. Used by the security, financial and concurrency suites.
 */
export async function marketplace(ctx: Ctx, secretEnv: string) {
  const secret = `sandbox-secret-${secretEnv.toLowerCase()}-0123456789`;
  process.env[secretEnv] = secret;
  const admin = await createStaff(ctx, [{ code: 'system_admin' }]);
  const country = await setupCountry(ctx, admin.token);
  const supervisor = await createStaff(ctx, [{ code: 'services_supervisor', countryId: country.id }]);
  const financeA = await createStaff(ctx, [{ code: 'finance_officer', countryId: country.id }]);
  const financeB = await createStaff(ctx, [{ code: 'finance_officer', countryId: country.id }]);
  const manager = await createStaff(ctx, [{ code: 'manager', countryId: country.id }]);
  const categoryId = (await api(ctx, 'POST', '/v1/admin/categories', { token: admin.token, body: { slug: `c-${uniq()}`, name: { en: 'C' }, countryIds: [country.id] } })).body.id;
  const hallType = (await api(ctx, 'POST', '/v1/admin/service-types', { token: admin.token, body: { categoryId, code: `t_${uniq()}`.slice(0, 40), name: { en: 'Hall' }, bookingMode: 'full_day', pricingUnits: ['fixed'] } })).body.id as string;
  const gw = (await api(ctx, 'POST', '/v1/admin/accounts', { token: admin.token, body: { countryId: country.id, currency: 'SAR', kind: 'gateway', suffix: 'GW', name: { en: 'Gateway' } } })).body.id;
  const bankAccount = (await api(ctx, 'POST', '/v1/admin/accounts', { token: admin.token, body: { countryId: country.id, currency: 'SAR', kind: 'bank', suffix: 'BK', name: { en: 'Bank' } } })).body.id as string;
  const integrationId = (await api(ctx, 'POST', '/v1/admin/payment-integrations', { token: admin.token, body: { providerCode: 'sandbox', name: 'Sandbox', countryId: country.id, kind: 'gateway', environment: 'test', secretRef: secretEnv } })).body.id as string;
  await api(ctx, 'PATCH', `/v1/admin/payment-integrations/${integrationId}`, { token: admin.token, body: { isActive: true, reason: 'Enable for tests' } });
  await api(ctx, 'POST', '/v1/admin/payment-methods', { token: admin.token, body: { countryId: country.id, model: 'platform', method: 'card', integrationId, accountId: gw } });
  await api(ctx, 'POST', '/v1/admin/payment-methods', { token: admin.token, body: { countryId: country.id, model: 'platform', method: 'bank_transfer', accountId: bankAccount, proofRequired: true } });
  await api(ctx, 'POST', '/v1/admin/commission-rules', { token: admin.token, body: { scope: 'country', countryId: country.id, rateType: 'percent', rateValue: '10' } });

  let day = 0;
  const nextDate = () => new Date(Date.UTC(2028, 0, 1 + day++)).toISOString().slice(0, 10);

  /** A published hall (20,000 SAR, 25% deposit, full refund up to 30 days, deposit refundable). */
  async function hall() {
    const p = await approvedProvider(ctx, supervisor.token, country.code);
    await api(ctx, 'PUT', `/v1/admin/providers/${p.providerId}/service-types`, { token: admin.token, body: { serviceTypeIds: [hallType] } });
    const pol = await api(ctx, 'POST', '/v1/provider/cancellation-policies', { token: p.token, body: {
      name: { en: 'Flexible' }, description: { en: 'Full refund up to 30 days' },
      tiers: [{ hoursBefore: 720, refundPercentOfPaid: 100 }, { hoursBefore: 168, refundPercentOfPaid: 50 }, { hoursBefore: 0, refundPercentOfPaid: 0 }], depositRefundable: true } });
    const s = await api(ctx, 'POST', '/v1/provider/services', { token: p.token, body: {
      serviceTypeId: hallType, title: { en: 'Hall' }, description: { en: 'D' }, city: 'Riyadh', currency: 'SAR', basePrice: '20000', pricingUnit: 'fixed',
      requiresProviderApproval: false, depositType: 'percent', depositValue: '25', cancellationPolicyId: pol.body.id } });
    await upload(ctx, `/v1/provider/services/${s.body.id}/media`, p.token, PNG);
    await api(ctx, 'POST', `/v1/provider/services/${s.body.id}/submit`, { token: p.token });
    await api(ctx, 'POST', `/v1/admin/services/${s.body.id}/actions`, { token: supervisor.token, body: { action: 'publish' } });
    return { p, serviceId: s.body.id as string };
  }

  async function customer() {
    const c = await register(ctx, country.code);
    await api(ctx, 'POST', '/v1/auth/verification/confirm', { token: c.token, body: { channel: 'phone', code: await latestCode(ctx, c.userId, 'auth.verify_phone') } });
    return c;
  }

  async function webhook(body: object) {
    const raw = JSON.stringify(body);
    const sig = createHmac('sha256', secret).update(raw).digest('hex');
    const r = await ctx.app.inject({ method: 'POST', url: `/v1/webhooks/payments/${integrationId}`, payload: raw, headers: { 'content-type': 'application/json', 'x-sandbox-signature': sig } });
    return { status: r.statusCode, body: JSON.parse(r.body) };
  }

  async function order(token: string, serviceId: string, date = nextDate()) {
    await api(ctx, 'POST', '/v1/cart/items', { token, body: { serviceId, date } });
    const r = await ctx.app.inject({ method: 'POST', url: '/v1/checkout', headers: { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID() }, payload: { acceptTerms: true } });
    return JSON.parse(r.body) as { id: string; bookings: { id: string }[] };
  }

  /** Starts a card payment; returns it with its gateway reference (not yet confirmed). */
  async function startCard(token: string, orderId: string, purpose: 'upfront' | 'balance') {
    const r = await ctx.app.inject({ method: 'POST', url: `/v1/orders/${orderId}/payments`, headers: { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID() }, payload: { model: 'platform', method: 'card', purpose } });
    const p = JSON.parse(r.body);
    if (r.statusCode !== 201) throw new Error(`payment: ${r.body}`);
    const ref = (await ctx.db.query('SELECT external_ref FROM payments WHERE id = $1', [p.id])).rows[0].external_ref as string;
    return { ...p, ref } as { id: string; amount: string; ref: string };
  }

  async function payCard(token: string, orderId: string, purpose: 'upfront' | 'balance') {
    const p = await startCard(token, orderId, purpose);
    await webhook({ id: `evt_${uniq()}`, type: 'payment.succeeded', data: { reference: p.ref, amount: p.amount, currency: 'SAR' } });
    return p;
  }

  return { admin, country, supervisor, financeA, financeB, manager, hallType, bankAccount, integrationId, hall, customer, webhook, order, startCard, payCard, nextDate };
}
