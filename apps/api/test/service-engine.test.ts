import { beforeAll, describe, expect, it } from 'vitest';
import { checkFieldDefinition, validateAttributes } from '../src/modules/catalog/fields.js';
import { STARTER_CATALOG } from '../src/modules/catalog/starter.js';
import { api, approvedProvider, createStaff, PDF, PNG, setupCountry, uniq, upload, useApp } from './helpers.js';

/** Service engine: starter catalog, type documents, type default policy, time/location fields (clauses 16-19). */
const ctx = useApp();
let admin: { token: string };
let supervisor: { token: string };
let country: { id: string; code: string };
beforeAll(async () => {
  admin = await createStaff(ctx, [{ code: 'system_admin' }]);
  country = await setupCountry(ctx, admin.token);
  supervisor = await createStaff(ctx, [{ code: 'services_supervisor', countryId: country.id }]);
});

describe('starter catalog', () => {
  it('has valid field definitions and compatible pricing', () => {
    for (const c of STARTER_CATALOG) for (const t of c.types) {
      if (t.bookingMode === 'quantity_rental') expect(t.pricingUnits).toEqual(['per_day']);
      for (const f of t.fields) {
        expect(checkFieldDefinition({ data_type: f.dataType, options: (f.options ?? []).map(([value]) => ({ value })), validation: f.validation ?? {} }), `${t.code}.${f.key}`).toBeNull();
      }
    }
  });

  it('imports once, skips what exists, and needs both catalog permissions', async () => {
    expect((await api(ctx, 'POST', '/v1/admin/catalog/starter', { token: supervisor.token, body: { countryIds: [country.id], reason: 'Seed' } })).status).toBe(403);
    const r = await api(ctx, 'POST', '/v1/admin/catalog/starter', { token: admin.token, body: { countryIds: [country.id], reason: 'Initial catalog' } });
    expect(r.status).toBe(200);
    const again = await api(ctx, 'POST', '/v1/admin/catalog/starter', { token: admin.token, body: { countryIds: [country.id], reason: 'Again' } });
    expect(again.body.created.types).toEqual([]);
    const all = [...r.body.created.types, ...r.body.skipped.types];
    expect(all).toContain('wedding_hall');
    const preview = await api(ctx, 'GET', '/v1/admin/catalog/starter', { token: admin.token });
    expect(preview.body.every((c: { exists: boolean; types: { exists: boolean }[] }) => c.exists && c.types.every((t) => t.exists))).toBe(true);
    const hall = (await ctx.db.query(`SELECT required_documents, (SELECT count(*)::int FROM service_type_fields f WHERE f.service_type_id = t.id) AS n FROM service_types t WHERE code = 'wedding_hall'`)).rows[0];
    expect(hall.required_documents).toContain('commercial_license');
    expect(hall.n).toBeGreaterThan(2);
    expect((await ctx.db.query(`SELECT 1 FROM audit_log WHERE action = 'catalog.starter_imported'`)).rowCount).toBeGreaterThan(0);
  });
});

describe('time and location fields', () => {
  const f = (data_type: 'time' | 'location') => [{ key: 'x', data_type, is_required: true, validation: {}, options: [] }];
  it('validates values', () => {
    expect(validateAttributes(f('time'), { x: '18:30' }).ok).toBe(true);
    expect(validateAttributes(f('time'), { x: '25:00' }).ok).toBe(false);
    expect(validateAttributes(f('location'), { x: { lat: 24.7, lng: 46.6 } }).ok).toBe(true);
    expect(validateAttributes(f('location'), { x: { lat: 124.7, lng: 46.6 } }).ok).toBe(false);
  });
});

describe('type documents and default policy', () => {
  it('requires the type documents before submission and keeps them private', async () => {
    const pol = await api(ctx, 'POST', '/v1/admin/cancellation-policies', { token: admin.token, body: {
      name: { en: 'Standard' }, description: { en: 'Half refund up to 7 days' }, tiers: [{ hoursBefore: 168, refundPercentOfPaid: 50 }, { hoursBefore: 0, refundPercentOfPaid: 0 }] } });
    expect(pol.status).toBe(201);
    const categoryId = (await api(ctx, 'POST', '/v1/admin/categories', { token: admin.token, body: { slug: `c-${uniq()}`, name: { en: 'C' }, countryIds: [country.id] } })).body.id;
    const type = await api(ctx, 'POST', '/v1/admin/service-types', { token: admin.token, body: {
      categoryId, code: `t_${uniq()}`.slice(0, 40), name: { en: 'Licensed' }, bookingMode: 'full_day', pricingUnits: ['fixed'],
      requiredDocuments: ['commercial_license'], defaultCancellationPolicyId: pol.body.id,
      fields: [{ key: 'opens_at', label: { en: 'Opens at' }, dataType: 'time' }, { key: 'pin', label: { en: 'Pin' }, dataType: 'location' }] } });
    expect(type.status).toBe(201);
    // A provider's own policy cannot be a type default.
    const p = await approvedProvider(ctx, supervisor.token, country.code);
    const own = await api(ctx, 'POST', '/v1/provider/cancellation-policies', { token: p.token, body: { name: { en: 'Mine' }, description: { en: 'D' }, tiers: [{ hoursBefore: 0, refundPercentOfPaid: 0 }] } });
    expect((await api(ctx, 'PATCH', `/v1/admin/service-types/${type.body.id}`, { token: admin.token, body: { defaultCancellationPolicyId: own.body.id } })).status).toBe(400);

    await api(ctx, 'PUT', `/v1/admin/providers/${p.providerId}/service-types`, { token: admin.token, body: { serviceTypeIds: [type.body.id] } });
    const s = await api(ctx, 'POST', '/v1/provider/services', { token: p.token, body: {
      serviceTypeId: type.body.id, title: { en: 'Hall' }, description: { en: 'D' }, city: 'Riyadh', currency: 'SAR', basePrice: '1000', pricingUnit: 'fixed',
      attributes: { opens_at: '16:00', pin: { lat: 24.7, lng: 46.6 } } } });
    expect(s.status).toBe(201);
    expect((await ctx.db.query('SELECT cancellation_policy_id FROM services WHERE id = $1', [s.body.id])).rows[0].cancellation_policy_id).toBe(pol.body.id);
    await upload(ctx, `/v1/provider/services/${s.body.id}/media`, p.token, PNG);

    const blocked = await api(ctx, 'POST', `/v1/provider/services/${s.body.id}/submit`, { token: p.token });
    expect(blocked.body.error.code).toBe('SERVICE_DOCUMENTS_REQUIRED');
    expect((await upload(ctx, `/v1/provider/services/${s.body.id}/documents`, p.token, PDF, { docType: 'something_else' })).status).toBe(400);
    const other = await approvedProvider(ctx, supervisor.token, country.code);
    expect((await upload(ctx, `/v1/provider/services/${s.body.id}/documents`, other.token, PDF, { docType: 'commercial_license' })).status).toBe(404);
    const first = await upload(ctx, `/v1/provider/services/${s.body.id}/documents`, p.token, PDF, { docType: 'commercial_license' });
    expect(first.status).toBe(201);
    const second = await upload(ctx, `/v1/provider/services/${s.body.id}/documents`, p.token, PDF, { docType: 'commercial_license' });
    const list = await api(ctx, 'GET', `/v1/provider/services/${s.body.id}/documents`, { token: p.token });
    expect(list.body.documents.map((d: { id: string }) => d.id)).toEqual([second.body.id]);
    expect((await ctx.db.query('SELECT count(*)::int AS n FROM service_documents WHERE service_id = $1', [s.body.id])).rows[0].n).toBe(2);
    expect((await api(ctx, 'POST', `/v1/provider/services/${s.body.id}/submit`, { token: p.token })).status).toBe(200);

    // Staff in the country read it (audited); other providers and anonymous visitors cannot.
    const staffList = await api(ctx, 'GET', `/v1/admin/services/${s.body.id}/documents`, { token: supervisor.token });
    expect(staffList.body.required).toEqual(['commercial_license']);
    const file = await ctx.app.inject({ method: 'GET', url: `/v1/service-documents/${second.body.id}/file`, headers: { authorization: `Bearer ${supervisor.token}` } });
    expect(file.statusCode).toBe(200);
    expect((await ctx.app.inject({ method: 'GET', url: `/v1/service-documents/${second.body.id}/file`, headers: { authorization: `Bearer ${other.token}` } })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: 'GET', url: `/v1/service-documents/${second.body.id}/file` })).statusCode).toBe(401);
    expect((await ctx.db.query(`SELECT 1 FROM audit_log WHERE action = 'service.document_viewed' AND entity_id = $1`, [s.body.id])).rowCount).toBe(1);
  });
});
