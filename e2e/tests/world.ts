import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { E2E, apiUrl } from '../env';
import { adminToken, api, uniq } from './helpers';

/**
 * Arranges realistic data through the real API (the same calls the interfaces make), so browser tests
 * start from a known state. One-time codes are read from the outbox, as the messaging driver would.
 */
export const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
export const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);

let pool: pg.Pool | null = null;
export const db = () => (pool ??= new pg.Pool({ connectionString: E2E.databaseUrl, max: 2 }));
export const PASSWORD = 'Passw0rd-123';

export async function latestCode(userId: string, templateKey = 'auth.verify_phone'): Promise<string> {
  const r = await db().query<{ payload: { code: string } }>(
    `SELECT payload FROM message_outbox WHERE channel <> 'web' AND recipient_user_id = $1 AND template_key = $2 ORDER BY created_at DESC LIMIT 1`, [userId, templateKey]);
  return r.rows[0]!.payload.code;
}

export async function uploadFile(path: string, token: string, file: Buffer, fields: Record<string, string> = {}, name = 'file.pdf') {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  form.append('file', new Blob([new Uint8Array(file)]), name);
  const r = await fetch(`${apiUrl}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form });
  if (!r.ok) throw new Error(`upload ${path} → ${r.status} ${await r.text()}`);
  return r.json();
}

let phoneSeq = Math.floor(Math.random() * 1e6);
export const phone = () => `+9665${String(10_000_000 + (phoneSeq++ % 89_999_999)).padStart(8, '0')}`;

export interface Country { id: string; code: string }
export async function country(): Promise<Country> {
  const admin = await adminToken();
  for (;;) {
    const code = String.fromCharCode(65 + Math.floor(Math.random() * 26), 65 + Math.floor(Math.random() * 26));
    try {
      const c = await api<{ id: string }>('POST', '/v1/admin/countries', { token: admin, body: { code, name: { ar: `دولة ${code}`, en: `Country ${code}` }, baseCurrency: 'SAR', timezone: 'Asia/Riyadh', defaultLanguage: 'ar', phonePrefix: '+966', isActive: true, currencies: ['USD'] } });
      for (const kind of ['customer_terms', 'provider_terms', 'privacy_policy']) {
        await api('POST', '/v1/admin/terms', { token: admin, body: { kind, countryId: c.id, version: '1.0', content: { ar: 'نص الشروط', en: 'Terms text' } } });
      }
      return { id: c.id, code };
    } catch (e) { if (!String(e).includes('409')) throw e; }
  }
}

export async function user(countryCode: string, accountType: 'customer' | 'provider', verify = true) {
  const p = phone();
  const email = `u-${uniq()}@test.local`;
  const r = await api<{ userId: string; accessToken: string }>('POST', '/v1/auth/register', {
    body: { accountType, fullName: accountType === 'provider' ? 'مزود اختبار' : 'عميل اختبار', phone: p, email, countryCode, preferredLanguage: 'ar', password: PASSWORD, acceptTerms: true },
  });
  if (verify) await api('POST', '/v1/auth/verification/confirm', { token: r.accessToken, body: { channel: 'phone', code: await latestCode(r.userId) } });
  return { userId: r.userId, token: r.accessToken, phone: p, email };
}

/** Provider who applied with both documents; not yet decided. */
export async function submittedApplication(c: Country) {
  const p = await user(c.code, 'provider');
  const app = await api<{ id: string }>('POST', '/v1/provider-applications', {
    token: p.token, body: { businessName: `قاعات ${uniq()}`, activityType: 'events', countryCode: c.code, city: 'Riyadh', phone: p.phone, payoutDetails: { iban: 'SA0000000000000000000000' } },
  });
  for (const docType of ['identity', 'commercial_registration']) await uploadFile(`/v1/provider-applications/${app.id}/documents`, p.token, PDF, { docType });
  await api('POST', `/v1/provider-applications/${app.id}/submit`, { token: p.token, body: { acceptTerms: true } });
  return { ...p, applicationId: app.id };
}

export async function approvedProvider(c: Country) {
  const p = await submittedApplication(c);
  await api('POST', `/v1/admin/provider-applications/${p.applicationId}/actions`, { token: await adminToken(), body: { action: 'approve' } });
  const providerId = (await db().query<{ id: string }>('SELECT id FROM providers WHERE user_id = $1', [p.userId])).rows[0]!.id;
  return { ...p, providerId };
}

/** Category, a full-day "hall" type, a sandbox card gateway, a bank account with transfers + proof, and 10% commission. */
export async function marketplace(c: Country) {
  const admin = await adminToken();
  const categoryId = (await api<{ id: string }>('POST', '/v1/admin/categories', { token: admin, body: { slug: `halls-${uniq()}`, name: { ar: 'قاعات', en: 'Halls' }, countryIds: [c.id] } })).id;
  const typeId = (await api<{ id: string }>('POST', '/v1/admin/service-types', { token: admin, body: { categoryId, code: `hall_${uniq()}`.slice(0, 40), name: { ar: 'قاعة', en: 'Hall' }, bookingMode: 'full_day', pricingUnits: ['fixed'], defaultRequiresApproval: false } })).id;
  const gw = (await api<{ id: string }>('POST', '/v1/admin/accounts', { token: admin, body: { countryId: c.id, currency: 'SAR', kind: 'gateway', suffix: 'GW', name: { ar: 'البوابة', en: 'Gateway' } } })).id;
  const bank = (await api<{ id: string }>('POST', '/v1/admin/accounts', { token: admin, body: { countryId: c.id, currency: 'SAR', kind: 'bank', suffix: 'BK', name: { ar: 'البنك', en: 'Bank' } } })).id;
  const integrationId = (await api<{ id: string }>('POST', '/v1/admin/payment-integrations', { token: admin, body: { providerCode: 'sandbox', name: 'Sandbox', countryId: c.id, kind: 'gateway', environment: 'test', secretRef: E2E.sandboxSecretRef } })).id;
  await api('PATCH', `/v1/admin/payment-integrations/${integrationId}`, { token: admin, body: { isActive: true, reason: 'Enable for tests' } });
  await api('POST', '/v1/admin/payment-methods', { token: admin, body: { countryId: c.id, model: 'platform', method: 'card', integrationId, accountId: gw } });
  await api('POST', '/v1/admin/payment-methods', { token: admin, body: { countryId: c.id, model: 'platform', method: 'bank_transfer', accountId: bank, proofRequired: true } });
  await api('POST', '/v1/admin/commission-rules', { token: admin, body: { scope: 'country', countryId: c.id, rateType: 'percent', rateValue: '10' } });
  return { categoryId, typeId, gatewayAccount: gw, bankAccount: bank, integrationId };
}

/** Provider service submitted for review (20,000 SAR, 25% deposit, full refund up to 30 days before). */
export async function submittedService(provider: { token: string; providerId: string }, typeId: string) {
  const admin = await adminToken();
  await api('PUT', `/v1/admin/providers/${provider.providerId}/service-types`, { token: admin, body: { serviceTypeIds: [typeId] } });
  const pol = await api<{ id: string }>('POST', '/v1/provider/cancellation-policies', { token: provider.token, body: {
    name: { ar: 'مرنة', en: 'Flexible' }, description: { ar: 'استرداد كامل قبل 30 يومًا', en: 'Full refund up to 30 days before' },
    tiers: [{ hoursBefore: 720, refundPercentOfPaid: 100 }, { hoursBefore: 0, refundPercentOfPaid: 0 }], depositRefundable: true } });
  const s = await api<{ id: string }>('POST', '/v1/provider/services', { token: provider.token, body: {
    serviceTypeId: typeId, title: { ar: `قاعة الماسة ${uniq()}`, en: 'Diamond Hall' }, description: { ar: 'قاعة فاخرة لحفلات الزفاف', en: 'Luxury wedding hall' },
    city: 'Riyadh', currency: 'SAR', basePrice: '20000', pricingUnit: 'fixed', requiresProviderApproval: false,
    depositType: 'percent', depositValue: '25', cancellationPolicyId: pol.id } });
  await uploadFile(`/v1/provider/services/${s.id}/media`, provider.token, PNG, {}, 'hall.png');
  await api('POST', `/v1/provider/services/${s.id}/submit`, { token: provider.token });
  return s.id;
}

export async function publish(serviceId: string) {
  await api('POST', `/v1/admin/services/${serviceId}/actions`, { token: await adminToken(), body: { action: 'publish' } });
}

let day = 0;
export const futureDate = (offsetDays = 120) => new Date(Date.UTC(2027, 0, 1) + (offsetDays + day++) * 86400000).toISOString().slice(0, 10);

export async function order(customerToken: string, serviceId: string, date = futureDate()) {
  await api('POST', '/v1/cart/items', { token: customerToken, body: { serviceId, date } });
  return api<{ id: string; bookings: { id: string }[] }>('POST', '/v1/checkout', { token: customerToken, body: { acceptTerms: true }, headers: { 'idempotency-key': randomUUID() } });
}

export async function payByCard(customerToken: string, orderId: string, purpose: 'upfront' | 'balance' = 'upfront') {
  const { createHmac } = await import('node:crypto');
  const p = await api<{ id: string; amount: string; integrationId?: string }>('POST', `/v1/orders/${orderId}/payments`, { token: customerToken, body: { model: 'platform', method: 'card', purpose }, headers: { 'idempotency-key': randomUUID() } });
  const row = (await db().query<{ external_ref: string; integration_id: string }>('SELECT external_ref, integration_id FROM payments WHERE id = $1', [p.id])).rows[0]!;
  const raw = JSON.stringify({ id: `evt_${uniq()}`, type: 'payment.succeeded', data: { reference: row.external_ref, amount: p.amount, currency: 'SAR' } });
  const sig = createHmac('sha256', E2E.sandboxSecret).update(raw).digest('hex');
  const r = await fetch(`${apiUrl}/v1/webhooks/payments/${row.integration_id}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-sandbox-signature': sig }, body: raw });
  if (!r.ok) throw new Error(`webhook ${r.status} ${await r.text()}`);
  return p;
}
