import { beforeAll, describe, expect, it } from 'vitest';
import { api, createStaff, latestCode, register, setupCountry, useApp, type Ctx } from './helpers.js';

const ctx = useApp();
let country: { id: string; code: string };
let otherCountry: { id: string; code: string };
let supervisor: { token: string };

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
const EXE = Buffer.from('MZ\x90\x00 this is not allowed');

async function upload(c: Ctx, token: string, appId: string, docType: string, file: Buffer, name = 'doc.pdf') {
  const boundary = '----test' + Math.random().toString(16).slice(2);
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="docType"\r\n\r\n${docType}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/pdf\r\n\r\n`),
    file,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await c.app.inject({
    method: 'POST', url: `/v1/provider-applications/${appId}/documents`, payload,
    headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/form-data; boundary=${boundary}` },
  });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

async function verifiedProvider() {
  const p = await register(ctx, country.code, 'provider');
  const code = await latestCode(ctx, p.userId, 'auth.verify_phone');
  await api(ctx, 'POST', '/v1/auth/verification/confirm', { token: p.token, body: { channel: 'phone', code } });
  return p;
}

const fields = (countryCode: string, phone: string) => ({
  businessName: 'Royal Hall', activityType: 'wedding_hall', countryCode, city: 'Riyadh', phone,
  description: 'Hall for 500 guests', latitude: 24.7136, longitude: 46.6753, payoutDetails: { iban: 'SA0000000000000000000000' },
});

async function submittedApplication() {
  const p = await verifiedProvider();
  const created = await api(ctx, 'POST', '/v1/provider-applications', { token: p.token, body: fields(country.code, p.phone) });
  const id = created.body.id as string;
  await upload(ctx, p.token, id, 'identity', PDF);
  await upload(ctx, p.token, id, 'commercial_registration', PDF);
  const s = await api(ctx, 'POST', `/v1/provider-applications/${id}/submit`, { token: p.token, body: { acceptTerms: true } });
  expect(s.status).toBe(204);
  return { p, id };
}

beforeAll(async () => {
  const admin = await createStaff(ctx, [{ code: 'system_admin' }]);
  country = await setupCountry(ctx, admin.token);
  otherCountry = await setupCountry(ctx, admin.token);
  supervisor = await createStaff(ctx, [{ code: 'services_supervisor', countryId: country.id }]);
});

describe('provider registration (test 2)', () => {
  it('enforces phone verification, required documents and file types before submission', async () => {
    const p = await register(ctx, country.code, 'provider');
    const created = await api(ctx, 'POST', '/v1/provider-applications', { token: p.token, body: fields(country.code, p.phone) });
    expect(created.status).toBe(201);
    const id = created.body.id;

    expect((await api(ctx, 'POST', `/v1/provider-applications/${id}/submit`, { token: p.token, body: { acceptTerms: true } })).body.error.code).toBe('PHONE_NOT_VERIFIED');
    const code = await latestCode(ctx, p.userId, 'auth.verify_phone');
    await api(ctx, 'POST', '/v1/auth/verification/confirm', { token: p.token, body: { channel: 'phone', code } });

    const incomplete = await api(ctx, 'POST', `/v1/provider-applications/${id}/submit`, { token: p.token, body: { acceptTerms: true } });
    expect(incomplete.body.error).toMatchObject({ code: 'APPLICATION_INCOMPLETE', details: { missingDocuments: ['identity', 'commercial_registration'] } });

    const bad = await upload(ctx, p.token, id, 'identity', EXE, 'virus.pdf');
    expect(bad.status).toBe(415);
    const ok = await upload(ctx, p.token, id, 'identity', PDF);
    expect(ok.status).toBe(201);
    expect(ok.body.mimeType).toBe('application/pdf');
    await upload(ctx, p.token, id, 'commercial_registration', PDF);

    expect((await api(ctx, 'POST', `/v1/provider-applications/${id}/submit`, { token: p.token, body: { acceptTerms: true } })).status).toBe(204);
    const mine = await api(ctx, 'GET', '/v1/provider-applications/mine', { token: p.token });
    expect(mine.body[0]).toMatchObject({ status: 'submitted', documents: [{ docType: 'identity' }, { docType: 'commercial_registration' }] });
    // The applicant and reviewing staff of that country can open the documents; others cannot.
    const docId = mine.body[0].documents[0].id;
    const docUrl = `/v1/provider-applications/${id}/documents/${docId}`;
    const own = await ctx.app.inject({ method: 'GET', url: docUrl, headers: { authorization: `Bearer ${p.token}` } });
    expect(own.statusCode).toBe(200);
    expect(own.headers['content-type']).toContain('application/pdf');
    expect((await ctx.app.inject({ method: 'GET', url: docUrl, headers: { authorization: `Bearer ${supervisor.token}` } })).statusCode).toBe(200);
    const audited = await ctx.db.query(`SELECT 1 FROM audit_log WHERE action = 'provider_application.document_viewed' AND entity_id = $1`, [id]);
    expect(audited.rowCount).toBe(1);
    const outsider = await createStaff(ctx, [{ code: 'services_supervisor', countryId: otherCountry.id }]);
    expect((await ctx.app.inject({ method: 'GET', url: docUrl, headers: { authorization: `Bearer ${outsider.token}` } })).statusCode).toBe(404);
    const stranger = await register(ctx, country.code, 'provider');
    expect((await ctx.app.inject({ method: 'GET', url: docUrl, headers: { authorization: `Bearer ${stranger.token}` } })).statusCode).toBe(404);
    // Cannot edit once submitted.
    expect((await api(ctx, 'PATCH', `/v1/provider-applications/${id}`, { token: p.token, body: { city: 'Jeddah' } })).status).toBe(409);
    // Only one open application.
    expect((await api(ctx, 'POST', '/v1/provider-applications', { token: p.token, body: fields(country.code, p.phone) })).body.error.code).toBe('APPLICATION_OPEN_EXISTS');
  });

  it('is not available to customer accounts and hides other applicants\' data', async () => {
    const c = await register(ctx, country.code, 'customer');
    expect((await api(ctx, 'POST', '/v1/provider-applications', { token: c.token, body: fields(country.code, c.phone) })).status).toBe(403);
    const { id } = await submittedApplication();
    const stranger = await verifiedProvider();
    expect((await api(ctx, 'POST', `/v1/provider-applications/${id}/cancel`, { token: stranger.token })).status).toBe(404);
  });
});

describe('provider approval and rejection (test 3)', () => {
  it('runs review → needs_info → resubmit → approve, creating the provider with full history', async () => {
    const { p, id } = await submittedApplication();
    const act = (action: string, reason?: string) =>
      api(ctx, 'POST', `/v1/admin/provider-applications/${id}/actions`, { token: supervisor.token, body: { action, ...(reason ? { reason } : {}) } });

    expect((await act('start_review')).body.status).toBe('under_review');
    expect((await act('request_info')).body.error.code).toBe('REASON_REQUIRED');
    expect((await act('request_info', 'Commercial registration is expired')).body.status).toBe('needs_info');

    // Applicant fixes data and resubmits.
    expect((await api(ctx, 'PATCH', `/v1/provider-applications/${id}`, { token: p.token, body: { city: 'Jeddah' } })).status).toBe(204);
    expect((await api(ctx, 'POST', `/v1/provider-applications/${id}/submit`, { token: p.token, body: { acceptTerms: true } })).status).toBe(204);

    // The provider panel is unavailable before approval.
    expect((await api(ctx, 'GET', '/v1/provider/me', { token: p.token })).status).toBe(404);
    expect((await act('approve')).body.status).toBe('approved');
    const me = await api(ctx, 'GET', '/v1/provider/me', { token: p.token });
    expect(me.body).toMatchObject({ businessName: 'Royal Hall', city: 'Jeddah', status: 'active', countryCode: country.code });

    const detail = await api(ctx, 'GET', `/v1/admin/provider-applications/${id}`, { token: supervisor.token });
    expect(detail.body.history.map((h: { to: string }) => h.to)).toEqual(['draft', 'submitted', 'under_review', 'needs_info', 'submitted', 'approved']);
    expect(detail.body.decidedBy).toBe('Staff Member');
    // Supervisor lacks providers.view_sensitive: payout details are hidden.
    expect(detail.body.payoutDetails).toBeNull();

    // Applicant is notified of each decision.
    const msgs = await ctx.db.query(`SELECT template_key FROM message_outbox WHERE channel <> 'web' AND recipient_user_id = $1 AND template_key LIKE 'provider_application.%' ORDER BY created_at`, [p.userId]);
    expect(msgs.rows.map((r) => r.template_key)).toEqual(['provider_application.needs_info', 'provider_application.approved']);

    // Audit records the decision maker and reason.
    const audit = await ctx.db.query(`SELECT action, reason, actor_id FROM audit_log WHERE entity_id = $1 AND action = 'provider_application.request_info'`, [id]);
    expect(audit.rows[0].reason).toBe('Commercial registration is expired');
  });

  it('rejects with a mandatory reason; the applicant may apply again', async () => {
    const { p, id } = await submittedApplication();
    const r = await api(ctx, 'POST', `/v1/admin/provider-applications/${id}/actions`, { token: supervisor.token, body: { action: 'reject', reason: 'Documents are not legible' } });
    expect(r.body.status).toBe('rejected');
    const row = await ctx.db.query('SELECT decision_reason, decided_by FROM provider_applications WHERE id = $1', [id]);
    expect(row.rows[0].decision_reason).toBe('Documents are not legible');
    expect((await api(ctx, 'POST', `/v1/admin/provider-applications/${id}/actions`, { token: supervisor.token, body: { action: 'approve' } })).status).toBe(409);
    expect((await api(ctx, 'POST', '/v1/provider-applications', { token: p.token, body: fields(country.code, p.phone) })).status).toBe(201);
  });

  it('suspends and reactivates an approved provider', async () => {
    const { p, id } = await submittedApplication();
    const act = (action: string, reason?: string) =>
      api(ctx, 'POST', `/v1/admin/provider-applications/${id}/actions`, { token: supervisor.token, body: { action, reason } });
    await act('approve');
    await act('suspend', 'Repeated customer complaints');
    expect((await api(ctx, 'GET', '/v1/provider/me', { token: p.token })).body).toMatchObject({ status: 'suspended', statusReason: 'Repeated customer complaints' });
    await act('reactivate', 'Issue resolved');
    expect((await api(ctx, 'GET', '/v1/provider/me', { token: p.token })).body.status).toBe('active');
  });

  it('enforces country scope and permissions on staff actions (tests 33-34)', async () => {
    const { id } = await submittedApplication();
    const foreign = await createStaff(ctx, [{ code: 'services_supervisor', countryId: otherCountry.id }]);
    expect((await api(ctx, 'POST', `/v1/admin/provider-applications/${id}/actions`, { token: foreign.token, body: { action: 'approve' } })).status).toBe(403);
    expect((await api(ctx, 'GET', `/v1/admin/provider-applications/${id}`, { token: foreign.token })).status).toBe(404);
    const list = await api(ctx, 'GET', '/v1/admin/provider-applications', { token: foreign.token });
    expect(list.body.items.every((a: { countryCode: string }) => a.countryCode === otherCountry.code)).toBe(true);

    const support = await createStaff(ctx, [{ code: 'support_agent' }]);
    expect((await api(ctx, 'POST', `/v1/admin/provider-applications/${id}/actions`, { token: support.token, body: { action: 'approve' } })).status).toBe(403);
    expect((await api(ctx, 'GET', '/v1/admin/provider-applications', { token: support.token })).status).toBe(403);

    const finance = await createStaff(ctx, [{ code: 'finance_officer' }, { code: 'services_supervisor' }]);
    expect((await api(ctx, 'GET', `/v1/admin/provider-applications/${id}`, { token: finance.token })).body.payoutDetails).toEqual({ iban: 'SA0000000000000000000000' });
  });
});
