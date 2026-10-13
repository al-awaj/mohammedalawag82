import { beforeAll, describe, expect, it } from 'vitest';
import { api, approvedProvider, createStaff, MP4, PDF, PNG, setupCountry, uniq, upload, useApp } from './helpers.js';

const ctx = useApp();
let admin: { token: string };
let supervisor: { token: string };
let country: { id: string; code: string };
let categoryId: string;
let hallTypeId: string;
let hallTypeCode: string;

const opt = (...v: string[]) => v.map((value) => ({ value, label: { ar: value, en: value } }));

async function createType(overrides: Record<string, unknown> = {}) {
  const code = `t_${uniq()}`.slice(0, 40);
  const res = await api(ctx, 'POST', '/v1/admin/service-types', {
    token: admin.token,
    body: {
      categoryId, code, name: { ar: 'قاعة', en: 'Hall' }, bookingMode: 'full_day', capacityMode: 'guests', pricingUnits: ['fixed', 'per_person'],
      minImages: 1, maxImages: 3, allowsVideo: false, depositRequired: true, minDepositPercent: 20,
      fields: [
        { key: 'hall_style', label: { ar: 'الطراز', en: 'Style' }, dataType: 'select', isRequired: true, isSearchable: true, options: opt('modern', 'classic') },
        { key: 'seats', label: { ar: 'المقاعد', en: 'Seats' }, dataType: 'integer', isRequired: true, isSearchable: true, validation: { min: 10 } },
        { key: 'amenities', label: { ar: 'المرافق', en: 'Amenities' }, dataType: 'multiselect', isSearchable: true, options: opt('parking', 'valet', 'prayer_room') },
        { key: 'internal_code', label: { en: 'Internal code' }, dataType: 'text', isPublic: false },
      ],
      ...overrides,
    },
  });
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  return { id: res.body.id as string, code };
}

const serviceBody = (typeId: string, extra: Record<string, unknown> = {}) => ({
  serviceTypeId: typeId, title: { ar: 'قاعة الماسة', en: 'Diamond Hall' }, description: { ar: 'قاعة فاخرة', en: 'Luxury hall' },
  city: 'Riyadh', latitude: 24.7136, longitude: 46.6753, basePrice: '20000.00', currency: 'SAR', pricingUnit: 'fixed', capacity: 500,
  depositType: 'percent', depositValue: '25', attributes: { hall_style: 'modern', seats: 450, amenities: ['parking', 'valet'], internal_code: 'H-01' },
  ...extra,
});

async function grant(providerId: string, ...typeIds: string[]) {
  const r = await api(ctx, 'PUT', `/v1/admin/providers/${providerId}/service-types`, { token: admin.token, body: { serviceTypeIds: typeIds } });
  expect(r.status).toBe(200);
}

/** Creates a published hall service for a new approved provider. */
async function publishedHall(extra: Record<string, unknown> = {}) {
  const p = await approvedProvider(ctx, supervisor.token, country.code);
  await grant(p.providerId, hallTypeId);
  const s = await api(ctx, 'POST', '/v1/provider/services', { token: p.token, body: serviceBody(hallTypeId, extra) });
  expect(s.status).toBe(201);
  await upload(ctx, `/v1/provider/services/${s.body.id}/media`, p.token, PNG);
  expect((await api(ctx, 'POST', `/v1/provider/services/${s.body.id}/submit`, { token: p.token })).body.status).toBe('pending_review');
  expect((await api(ctx, 'POST', `/v1/admin/services/${s.body.id}/actions`, { token: supervisor.token, body: { action: 'publish' } })).body.status).toBe('published');
  return { p, serviceId: s.body.id as string };
}

beforeAll(async () => {
  admin = await createStaff(ctx, [{ code: 'system_admin' }]);
  country = await setupCountry(ctx, admin.token);
  supervisor = await createStaff(ctx, [{ code: 'services_supervisor', countryId: country.id }]);
  const cat = await api(ctx, 'POST', '/v1/admin/categories', { token: admin.token, body: { slug: `venues-${uniq()}`, name: { ar: 'القاعات', en: 'Venues' }, countryIds: [country.id] } });
  categoryId = cat.body.id;
  ({ id: hallTypeId, code: hallTypeCode } = await createType());
});

describe('dynamic service types (test 4)', () => {
  it('creates a type with fields without code changes and exposes it in the category tree', async () => {
    const t = await api(ctx, 'GET', `/v1/admin/service-types/${hallTypeId}`, { token: admin.token });
    expect(t.body.fields.map((f: { key: string }) => f.key)).toEqual(['amenities', 'hall_style', 'internal_code', 'seats']);
    const tree = await api(ctx, 'GET', `/v1/categories?country=${country.code}`);
    const venue = tree.body.find((c: { id: string }) => c.id === categoryId);
    expect(venue.types.map((x: { code: string }) => x.code)).toContain(hallTypeCode);
  });

  it('rejects inconsistent field definitions and duplicate codes', async () => {
    const bad = await api(ctx, 'POST', '/v1/admin/service-types', {
      token: admin.token, body: { categoryId, code: `x_${uniq()}`.slice(0, 40), name: { en: 'X' }, bookingMode: 'time_slot', pricingUnits: ['fixed'], fields: [{ key: 'color', label: { en: 'Color' }, dataType: 'select' }] },
    });
    expect(bad.body.error.code).toBe('FIELD_DEFINITION_INVALID');
    const dup = await api(ctx, 'POST', '/v1/admin/service-types', { token: admin.token, body: { categoryId, code: hallTypeCode, name: { en: 'X' }, bookingMode: 'time_slot', pricingUnits: ['fixed'] } });
    expect(dup.body.error.code).toBe('CODE_TAKEN');
  });

  it('locks a used field\'s data type, and deactivating it keeps old values but hides them publicly', async () => {
    const { id: typeId } = await createType({ depositRequired: false, minDepositPercent: null });
    const fieldId = (await api(ctx, 'POST', `/v1/admin/service-types/${typeId}/fields`, { token: admin.token, body: { key: 'legacy', label: { en: 'Legacy' }, dataType: 'text' } })).body.id;
    const p = await approvedProvider(ctx, supervisor.token, country.code);
    await grant(p.providerId, typeId);
    const s = await api(ctx, 'POST', '/v1/provider/services', { token: p.token, body: serviceBody(typeId, { attributes: { hall_style: 'classic', seats: 100, legacy: 'kept' } }) });
    const patchField = (body: object) => api(ctx, 'PATCH', `/v1/admin/service-types/${typeId}/fields/${fieldId}`, { token: admin.token, body });
    expect((await patchField({ dataType: 'integer' })).body.error.code).toBe('FIELD_TYPE_LOCKED');
    expect((await patchField({ isActive: false })).status).toBe(200);

    await upload(ctx, `/v1/provider/services/${s.body.id}/media`, p.token, PNG);
    await api(ctx, 'POST', `/v1/provider/services/${s.body.id}/submit`, { token: p.token });
    await api(ctx, 'POST', `/v1/admin/services/${s.body.id}/actions`, { token: supervisor.token, body: { action: 'publish' } });
    const pub = await api(ctx, 'GET', `/v1/services/${s.body.id}`);
    expect(pub.body.attributes).toEqual({ hall_style: 'classic', seats: 100 });
    expect(pub.body.fields.map((f: { key: string }) => f.key)).not.toContain('legacy');
    const own = await api(ctx, 'GET', `/v1/provider/services/${s.body.id}`, { token: p.token });
    expect(own.body.attributes.legacy).toBe('kept');
  });

  it('prevents category cycles', async () => {
    const child = await api(ctx, 'POST', '/v1/admin/categories', { token: admin.token, body: { slug: `sub-${uniq()}`, parentId: categoryId, name: { en: 'Sub' } } });
    expect((await api(ctx, 'PATCH', `/v1/admin/categories/${categoryId}`, { token: admin.token, body: { parentId: child.body.id } })).body.error.code).toBe('CATEGORY_CYCLE');
  });
});

describe('provider services', () => {
  it('only allows granted types and validates type-specific data', async () => {
    const p = await approvedProvider(ctx, supervisor.token, country.code);
    expect((await api(ctx, 'POST', '/v1/provider/services', { token: p.token, body: serviceBody(hallTypeId) })).body.error.code).toBe('SERVICE_TYPE_NOT_ALLOWED');
    await grant(p.providerId, hallTypeId);
    expect((await api(ctx, 'GET', '/v1/provider/service-types', { token: p.token })).body.map((t: { id: string }) => t.id)).toEqual([hallTypeId]);

    const bad = await api(ctx, 'POST', '/v1/provider/services', { token: p.token, body: serviceBody(hallTypeId, { attributes: { hall_style: 'gothic', seats: 3, colour: 'red' } }) });
    expect(bad.body.error.code).toBe('ATTRIBUTES_INVALID');
    expect(bad.body.error.details.map((i: { field: string }) => i.field).sort()).toEqual(['colour', 'hall_style', 'seats']);

    expect((await api(ctx, 'POST', '/v1/provider/services', { token: p.token, body: serviceBody(hallTypeId, { capacity: null }) })).body.error.code).toBe('CAPACITY_REQUIRED');
    expect((await api(ctx, 'POST', '/v1/provider/services', { token: p.token, body: serviceBody(hallTypeId, { currency: 'EUR' }) })).body.error.code).toBe('CURRENCY_NOT_ALLOWED');
    expect((await api(ctx, 'POST', '/v1/provider/services', { token: p.token, body: serviceBody(hallTypeId, { pricingUnit: 'per_hour' }) })).body.error.code).toBe('PRICING_UNIT_NOT_ALLOWED');
    expect((await api(ctx, 'POST', '/v1/provider/services', { token: p.token, body: serviceBody(hallTypeId, { depositType: 'percent', depositValue: '10' }) })).body.error.code).toBe('DEPOSIT_REQUIRED');
    expect((await api(ctx, 'POST', '/v1/provider/services', { token: p.token, body: serviceBody(hallTypeId, { depositType: 'fixed', depositValue: '30000' }) })).status).toBe(400);
  });

  it('sets the approval requirement per service, defaulting from the type (decision D5)', async () => {
    const p = await approvedProvider(ctx, supervisor.token, country.code);
    await grant(p.providerId, hallTypeId);
    const a = await api(ctx, 'POST', '/v1/provider/services', { token: p.token, body: serviceBody(hallTypeId) });
    const b = await api(ctx, 'POST', '/v1/provider/services', { token: p.token, body: serviceBody(hallTypeId, { requiresProviderApproval: false }) });
    const list = await api(ctx, 'GET', '/v1/provider/services', { token: p.token });
    const byId = Object.fromEntries(list.body.map((s: { id: string; requiresProviderApproval: boolean }) => [s.id, s.requiresProviderApproval]));
    expect(byId[a.body.id]).toBe(true);
    expect(byId[b.body.id]).toBe(false);
    await api(ctx, 'PATCH', `/v1/provider/services/${a.body.id}`, { token: p.token, body: { requiresProviderApproval: false } });
    expect((await api(ctx, 'GET', `/v1/provider/services/${a.body.id}`, { token: p.token })).body.requiresProviderApproval).toBe(false);
  });

  it('requires images and complete data before review, then publishes after staff approval', async () => {
    const p = await approvedProvider(ctx, supervisor.token, country.code);
    await grant(p.providerId, hallTypeId);
    const s = await api(ctx, 'POST', '/v1/provider/services', { token: p.token, body: serviceBody(hallTypeId, { attributes: { hall_style: 'modern' } }) });
    const id = s.body.id;
    expect((await api(ctx, 'POST', `/v1/provider/services/${id}/submit`, { token: p.token })).body.error.code).toBe('ATTRIBUTES_INVALID');
    await api(ctx, 'PATCH', `/v1/provider/services/${id}`, { token: p.token, body: { attributes: { hall_style: 'modern', seats: 200 } } });
    expect((await api(ctx, 'POST', `/v1/provider/services/${id}/submit`, { token: p.token })).body.error.code).toBe('MIN_IMAGES_REQUIRED');

    expect((await upload(ctx, `/v1/provider/services/${id}/media`, p.token, PDF)).status).toBe(415);
    expect((await upload(ctx, `/v1/provider/services/${id}/media`, p.token, MP4)).body.error.code).toBe('VIDEO_NOT_ALLOWED');
    const img = await upload(ctx, `/v1/provider/services/${id}/media`, p.token, PNG, { isPastWork: 'true' });
    expect(img.status).toBe(201);
    // Not published yet: media is private to the owner.
    expect((await api(ctx, 'GET', img.body.url)).status).toBe(404);
    expect((await ctx.app.inject({ method: 'GET', url: img.body.url, headers: { authorization: `Bearer ${p.token}` } })).statusCode).toBe(200);

    expect((await api(ctx, 'POST', `/v1/provider/services/${id}/submit`, { token: p.token })).body.status).toBe('pending_review');
    expect((await api(ctx, 'GET', `/v1/services/${id}`)).status).toBe(404);
    expect((await api(ctx, 'POST', `/v1/admin/services/${id}/actions`, { token: supervisor.token, body: { action: 'reject' } })).body.error.code).toBe('REASON_REQUIRED');
    expect((await api(ctx, 'POST', `/v1/admin/services/${id}/actions`, { token: supervisor.token, body: { action: 'reject', reason: 'Photos are blurry' } })).body.status).toBe('draft');
    await api(ctx, 'POST', `/v1/provider/services/${id}/submit`, { token: p.token });
    expect((await api(ctx, 'POST', `/v1/admin/services/${id}/actions`, { token: supervisor.token, body: { action: 'publish' } })).body.status).toBe('published');

    const pub = await api(ctx, 'GET', `/v1/services/${id}`);
    expect(pub.status).toBe(200);
    // PATCH replaced the attribute set; internal_code (not public) would be hidden anyway.
    expect(pub.body.attributes).toEqual({ hall_style: 'modern', seats: 200 });
    expect(pub.body.media[0]).toMatchObject({ kind: 'image', isPastWork: true });
    expect((await api(ctx, 'GET', img.body.url)).status).toBe(200);
    // Cannot drop below the minimum images while live.
    expect((await api(ctx, 'DELETE', `/v1/provider/media/${img.body.id}`, { token: p.token })).body.error.code).toBe('MIN_IMAGES_REQUIRED');
  });

  it('publishes directly when review is disabled for the country', async () => {
    await api(ctx, 'PUT', '/v1/admin/settings/services.require_review', { token: admin.token, body: { scope: 'country', countryId: country.id, value: false, reason: 'Pilot without review' } });
    try {
      const p = await approvedProvider(ctx, supervisor.token, country.code);
      await grant(p.providerId, hallTypeId);
      const s = await api(ctx, 'POST', '/v1/provider/services', { token: p.token, body: serviceBody(hallTypeId) });
      await upload(ctx, `/v1/provider/services/${s.body.id}/media`, p.token, PNG);
      expect((await api(ctx, 'POST', `/v1/provider/services/${s.body.id}/submit`, { token: p.token })).body.status).toBe('published');
    } finally {
      await api(ctx, 'PUT', '/v1/admin/settings/services.require_review', { token: admin.token, body: { scope: 'country', countryId: country.id, value: true, reason: 'Pilot ended' } });
    }
  });

  it('isolates providers from each other (clause 8)', async () => {
    const { serviceId } = await publishedHall();
    const other = await approvedProvider(ctx, supervisor.token, country.code);
    expect((await api(ctx, 'PATCH', `/v1/provider/services/${serviceId}`, { token: other.token, body: { basePrice: '1.00' } })).status).toBe(404);
    expect((await api(ctx, 'GET', `/v1/provider/services/${serviceId}`, { token: other.token })).status).toBe(404);
    expect((await api(ctx, 'POST', `/v1/provider/services/${serviceId}/packages`, { token: other.token, body: { name: { en: 'X' }, price: '1', currency: 'SAR', pricingUnit: 'fixed' } })).status).toBe(404);
  });
});

describe('packages and prices (tests 5-6)', () => {
  it('creates packages with deposits and audits price changes', async () => {
    const { p, serviceId } = await publishedHall();
    const pkg = { name: { ar: 'الباقة الذهبية', en: 'Gold' }, price: '30000', currency: 'SAR', pricingUnit: 'fixed', depositType: 'fixed', depositValue: '6000',
      inclusions: [{ ar: 'بوفيه', en: 'Buffet' }], addOns: [{ code: 'flowers', name: { en: 'Flowers' }, price: '1500' }], availableWeekdays: [4, 5], balanceDueDaysBefore: 7 };
    expect((await api(ctx, 'POST', `/v1/provider/services/${serviceId}/packages`, { token: p.token, body: { ...pkg, depositValue: '3000' } })).body.error.code).toBe('DEPOSIT_REQUIRED');
    expect((await api(ctx, 'POST', `/v1/provider/services/${serviceId}/packages`, { token: p.token, body: { ...pkg, currency: 'EUR' } })).body.error.code).toBe('CURRENCY_NOT_ALLOWED');
    const created = await api(ctx, 'POST', `/v1/provider/services/${serviceId}/packages`, { token: p.token, body: pkg });
    expect(created.status).toBe(201);

    // 6000 / 32000 = 18.75% would fall under the type's 20% minimum deposit.
    expect((await api(ctx, 'PATCH', `/v1/provider/packages/${created.body.id}`, { token: p.token, body: { price: '32000' } })).body.error.code).toBe('DEPOSIT_REQUIRED');
    const upd = await api(ctx, 'PATCH', `/v1/provider/packages/${created.body.id}`, { token: p.token, body: { price: '28000' } });
    expect(upd.status).toBe(200);
    const a = await ctx.db.query(`SELECT before->>'price' AS old, after->>'price' AS new FROM audit_log WHERE entity_id = $1 AND action = 'package.updated'`, [created.body.id]);
    expect(a.rows[0]).toEqual({ old: '30000.0000', new: '28000' });

    await api(ctx, 'POST', `/v1/provider/services/${serviceId}/packages`, { token: p.token, body: { ...pkg, name: { en: 'Old' }, validFrom: '2020-01-01', validTo: '2020-12-31' } });
    await api(ctx, 'POST', `/v1/provider/services/${serviceId}/packages`, { token: p.token, body: { ...pkg, name: { en: 'Hidden' }, status: 'inactive' } });
    const pub = await api(ctx, 'GET', `/v1/services/${serviceId}`);
    expect(pub.body.packages.map((x: { name: { en: string } }) => x.name.en)).toEqual(['Gold']);
    expect(pub.body.packages[0]).toMatchObject({ price: '28000.0000', depositType: 'fixed', depositValue: '6000.0000', availableWeekdays: [4, 5], balanceDueDaysBefore: 7 });
  });
});

describe('rentable items (clause 23)', () => {
  it('supports stock-based rentals and requires stock before review', async () => {
    const { id: typeId } = await createType({ bookingMode: 'quantity_rental', capacityMode: 'none', pricingUnits: ['per_day'], depositRequired: false, minDepositPercent: null, fields: [], minImages: 0 });
    const p = await approvedProvider(ctx, supervisor.token, country.code);
    await grant(p.providerId, typeId, hallTypeId);
    const s = await api(ctx, 'POST', '/v1/provider/services', { token: p.token, body: serviceBody(typeId, { pricingUnit: 'per_day', capacity: null, depositType: 'none', depositValue: '0', attributes: {}, title: { en: 'Wedding dresses' } }) });
    expect(s.status).toBe(201);
    expect((await api(ctx, 'POST', `/v1/provider/services/${s.body.id}/submit`, { token: p.token })).status).toBe(400);
    const item = { sku: 'DRESS-38-W', name: { ar: 'فستان أبيض', en: 'White dress' }, attributes: { size: '38', color: 'white' }, quantityTotal: 2, pricePerDay: '800', currency: 'SAR', securityDeposit: '2000', lateFeePerDay: '300' };
    expect((await api(ctx, 'POST', `/v1/provider/services/${s.body.id}/rental-items`, { token: p.token, body: item })).status).toBe(201);
    expect((await api(ctx, 'POST', `/v1/provider/services/${s.body.id}/rental-items`, { token: p.token, body: item })).body.error.code).toBe('CODE_TAKEN');
    expect((await api(ctx, 'POST', `/v1/provider/services/${s.body.id}/submit`, { token: p.token })).body.status).toBe('pending_review');

    const hall = await api(ctx, 'POST', '/v1/provider/services', { token: p.token, body: serviceBody(hallTypeId) });
    expect((await api(ctx, 'POST', `/v1/provider/services/${hall.body.id}/rental-items`, { token: p.token, body: item })).body.error.code).toBe('RENTAL_ITEMS_NOT_ALLOWED');
  });
});

describe('search (clause 57)', () => {
  it('filters by type attributes, price (per currency), capacity and distance', async () => {
    const city = `City${uniq()}`;
    const { serviceId: near } = await publishedHall({ city, basePrice: '15000', capacity: 300, attributes: { hall_style: 'classic', seats: 280, amenities: ['parking', 'prayer_room'] } });
    const { serviceId: far } = await publishedHall({ city, basePrice: '40000', capacity: 1000, latitude: 21.4858, longitude: 39.1925, attributes: { hall_style: 'modern', seats: 900 } });
    const search = async (qs: string) => (await api(ctx, 'GET', `/v1/services?country=${country.code}&city=${city}&${qs}`)).body;

    expect((await search('')).items.map((s: { id: string }) => s.id).sort()).toEqual([near, far].sort());
    expect((await search(`type=${hallTypeCode}&attrs=${encodeURIComponent('{"hall_style":"classic"}')}`)).items.map((s: { id: string }) => s.id)).toEqual([near]);
    expect((await search(`type=${hallTypeCode}&attrs=${encodeURIComponent('{"seats":{"min":500}}')}`)).items.map((s: { id: string }) => s.id)).toEqual([far]);
    expect((await search(`type=${hallTypeCode}&attrs=${encodeURIComponent('{"amenities":["prayer_room"]}')}`)).items.map((s: { id: string }) => s.id)).toEqual([near]);
    expect((await api(ctx, 'GET', `/v1/services?country=${country.code}&type=${hallTypeCode}&attrs=${encodeURIComponent('{"internal_code":"H-01"}')}`)).status).toBe(400);

    expect((await api(ctx, 'GET', `/v1/services?country=${country.code}&maxPrice=20000`)).body.error.code).toBe('CURRENCY_REQUIRED_FOR_PRICE_FILTER');
    expect((await search('currency=SAR&maxPrice=20000')).items.map((s: { id: string }) => s.id)).toEqual([near]);
    expect((await search('minCapacity=500')).items.map((s: { id: string }) => s.id)).toEqual([far]);
    expect((await search('currency=USD')).total).toBe(0);

    const byDistance = await search('lat=24.7&lng=46.7&sort=distance');
    expect(byDistance.items.map((s: { id: string }) => s.id)).toEqual([near, far]);
    expect(byDistance.items[0].distanceKm).toBeLessThan(5);
    expect(byDistance.items[1].distanceKm).toBeGreaterThan(800);
    expect((await search('lat=24.7&lng=46.7&radiusKm=50')).items.map((s: { id: string }) => s.id)).toEqual([near]);
  });

  it('hides services of suspended providers and respects identity visibility (clause 68)', async () => {
    const { p, serviceId } = await publishedHall();
    expect((await api(ctx, 'GET', `/v1/services/${serviceId}`)).body.providerName).toMatch(/^Biz /);

    await api(ctx, 'PUT', '/v1/admin/settings/providers.public_identity_visible', { token: admin.token, body: { scope: 'country', countryId: country.id, value: false, reason: 'Anonymous marketplace' } });
    try {
      const hidden = await api(ctx, 'GET', `/v1/services/${serviceId}`);
      expect(hidden.body).toMatchObject({ providerName: null, providerId: null });
      // Staff still see who provides it.
      expect((await api(ctx, 'GET', `/v1/admin/services/${serviceId}`, { token: supervisor.token })).body.providerName).toMatch(/^Biz /);
    } finally {
      await api(ctx, 'PUT', '/v1/admin/settings/providers.public_identity_visible', { token: admin.token, body: { scope: 'country', countryId: country.id, value: true, reason: 'Restore' } });
    }

    await api(ctx, 'POST', `/v1/admin/provider-applications/${p.applicationId}/actions`, { token: supervisor.token, body: { action: 'suspend', reason: 'Complaints under review' } });
    expect((await api(ctx, 'GET', `/v1/services/${serviceId}`)).status).toBe(404);
    expect((await api(ctx, 'PATCH', `/v1/provider/services/${serviceId}`, { token: p.token, body: { basePrice: '1' } })).body.error.code).toBe('PROVIDER_NOT_ACTIVE');
    // Read access remains while suspended.
    expect((await api(ctx, 'GET', `/v1/provider/services/${serviceId}`, { token: p.token })).status).toBe(200);
  });
});

describe('moderation scope', () => {
  it('country-scoped moderators cannot act on other countries', async () => {
    const { serviceId } = await publishedHall();
    const other = await setupCountry(ctx, admin.token, '+971');
    const foreign = await createStaff(ctx, [{ code: 'services_supervisor', countryId: other.id }]);
    expect((await api(ctx, 'POST', `/v1/admin/services/${serviceId}/actions`, { token: foreign.token, body: { action: 'unpublish', reason: 'Not mine' } })).status).toBe(403);
    expect((await api(ctx, 'GET', `/v1/admin/services/${serviceId}`, { token: foreign.token })).status).toBe(404);
    const r = await api(ctx, 'POST', `/v1/admin/services/${serviceId}/actions`, { token: supervisor.token, body: { action: 'suspend', reason: 'Fake photos' } });
    expect(r.body.status).toBe('suspended');
    const history = await ctx.db.query('SELECT to_status FROM service_status_events WHERE service_id = $1 ORDER BY created_at', [serviceId]);
    expect(history.rows.map((h) => h.to_status)).toEqual(['draft', 'pending_review', 'published', 'suspended']);
  });
});
