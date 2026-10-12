import { beforeAll, describe, expect, it } from 'vitest';
import { api, createStaff, freshCountryCode, setupCountry, useApp } from './helpers.js';

const ctx = useApp();
let admin: { token: string };

beforeAll(async () => {
  admin = await createStaff(ctx, [{ code: 'system_admin' }]);
});

describe('countries and currencies', () => {
  it('creates a country with its currencies; inactive countries are hidden publicly', async () => {
    const code = await freshCountryCode(ctx.db);
    const body = { code, name: { ar: 'اليمن', en: 'Yemen' }, baseCurrency: 'YER', timezone: 'Asia/Aden', defaultLanguage: 'ar', phonePrefix: '+967', currencies: ['USD', 'SAR'] };
    const res = await api(ctx, 'POST', '/v1/admin/countries', { token: admin.token, body });
    expect(res.status).toBe(201);
    expect((await api(ctx, 'GET', '/v1/countries')).body.find((c: { code: string }) => c.code === code)).toBeUndefined();

    const upd = await api(ctx, 'PATCH', `/v1/admin/countries/${res.body.id}`, { token: admin.token, body: { isActive: true, reason: 'Launch' } });
    expect(upd.body.currencies).toEqual(['SAR', 'USD', 'YER']);
    const pub = (await api(ctx, 'GET', '/v1/countries')).body.find((c: { code: string }) => c.code === code);
    expect(pub).toMatchObject({ baseCurrency: 'YER', timezone: 'Asia/Aden', isActive: true });

    // A partial update must not reset fields that were not sent (regression).
    const tzOnly = await api(ctx, 'PATCH', `/v1/admin/countries/${res.body.id}`, { token: admin.token, body: { timezone: 'Asia/Riyadh' } });
    expect(tzOnly.body).toMatchObject({ isActive: true, currencies: ['SAR', 'USD', 'YER'], timezone: 'Asia/Riyadh' });

    expect((await api(ctx, 'POST', '/v1/admin/countries', { token: admin.token, body })).body.error.code).toBe('CODE_TAKEN');
    expect((await api(ctx, 'POST', '/v1/admin/countries', { token: admin.token, body: { ...body, code: 'QQ', timezone: 'Mars/Base' } })).status).toBe(400);
    expect((await api(ctx, 'POST', '/v1/admin/countries', { token: admin.token, body: { ...body, code: 'QZ', baseCurrency: 'XXX' } })).body.error.code).toBe('CURRENCY_NOT_FOUND');
  });

  it('adds a currency and refuses to disable the base currency of an active country', async () => {
    expect((await api(ctx, 'POST', '/v1/admin/currencies', { token: admin.token, body: { code: 'MAD', name: { ar: 'درهم مغربي', en: 'Moroccan Dirham' }, symbol: 'د.م' } })).status).toBe(201);
    await setupCountry(ctx, admin.token);
    expect((await api(ctx, 'PATCH', '/v1/admin/currencies/SAR', { token: admin.token, body: { isActive: false } })).body.error.code).toBe('CURRENCY_IN_USE');
  });

  it('country-scoped managers can only edit their own country', async () => {
    const a = await setupCountry(ctx, admin.token);
    const b = await setupCountry(ctx, admin.token);
    const code = `cmgr_${Date.now().toString(36)}`;
    await api(ctx, 'POST', '/v1/admin/roles', { token: admin.token, body: { code, name: { en: 'Country manager' }, permissions: ['countries.manage'] } });
    const mgr = await createStaff(ctx, [{ code, countryId: a.id }]);
    expect((await api(ctx, 'PATCH', `/v1/admin/countries/${a.id}`, { token: mgr.token, body: { timezone: 'Asia/Dubai' } })).status).toBe(200);
    expect((await api(ctx, 'PATCH', `/v1/admin/countries/${b.id}`, { token: mgr.token, body: { timezone: 'Asia/Dubai' } })).status).toBe(403);
    expect((await api(ctx, 'POST', '/v1/admin/countries', { token: mgr.token, body: {} })).status).toBe(400);
  });
});

describe('exchange rates (tests 32, clause 11)', () => {
  it('keeps every rate as an immutable, dated, sourced record', async () => {
    const r1 = await api(ctx, 'POST', '/v1/admin/exchange-rates', { token: admin.token, body: { base: 'USD', quote: 'SAR', rate: '3.7500', effectiveAt: '2026-01-01T00:00:00Z', source: 'Central bank bulletin' } });
    expect(r1.status).toBe(201);
    await api(ctx, 'POST', '/v1/admin/exchange-rates', { token: admin.token, body: { base: 'USD', quote: 'SAR', rate: '3.7600', effectiveAt: '2026-06-01T00:00:00Z', source: 'Central bank bulletin' } });

    const latest = await api(ctx, 'GET', '/v1/exchange-rates/latest?base=USD&quote=SAR');
    expect(latest.body).toMatchObject({ rate: '3.7600000000', inverted: false });

    // Historical lookups keep the rate valid at that time.
    const { findRate } = await import('../src/modules/reference/routes.js');
    expect((await findRate(ctx.db, 'USD', 'SAR', new Date('2026-03-01')))!.rate).toBe('3.7500000000');
    // Inverse pair is derived exactly.
    expect((await findRate(ctx.db, 'SAR', 'USD', new Date('2026-03-01')))!).toMatchObject({ rate: '0.2666666667', inverted: true });

    await expect(ctx.db.query('UPDATE exchange_rates SET rate = 1 WHERE id = $1', [r1.body.id])).rejects.toThrow(/append-only/);
    await expect(ctx.db.query('DELETE FROM exchange_rates WHERE id = $1', [r1.body.id])).rejects.toThrow(/append-only/);
  });

  it('validates rates', async () => {
    expect((await api(ctx, 'POST', '/v1/admin/exchange-rates', { token: admin.token, body: { base: 'USD', quote: 'USD', rate: '1', source: 'x source' } })).status).toBe(400);
    expect((await api(ctx, 'POST', '/v1/admin/exchange-rates', { token: admin.token, body: { base: 'USD', quote: 'EUR', rate: '0', source: 'x source' } })).status).toBe(400);
    expect((await api(ctx, 'POST', '/v1/admin/exchange-rates', { token: admin.token, body: { base: 'USD', quote: 'EUR', rate: '-1', source: 'x source' } })).status).toBe(400);
    expect((await api(ctx, 'POST', '/v1/admin/exchange-rates', { token: admin.token, body: { base: 'USD', quote: 'EUR', rate: 0.9, source: 'x source' } })).status).toBe(400);
  });
});

describe('terms versions (clause 66)', () => {
  it('serves the latest version and never changes a published one', async () => {
    const c = await setupCountry(ctx, admin.token);
    await api(ctx, 'POST', '/v1/admin/terms', { token: admin.token, body: { kind: 'customer_terms', countryId: c.id, version: '2.0', content: { ar: 'نسخة 2', en: 'v2' } } });
    const cur = await api(ctx, 'GET', `/v1/terms/current?kind=customer_terms&country=${c.code}`);
    expect(cur.body).toMatchObject({ version: '2.0', content: { en: 'v2' } });
    expect((await api(ctx, 'POST', '/v1/admin/terms', { token: admin.token, body: { kind: 'customer_terms', countryId: c.id, version: '2.0', content: { en: 'again' } } })).body.error.code).toBe('CODE_TAKEN');
    await expect(ctx.db.query(`UPDATE terms_versions SET content = '{"en":"x"}' WHERE id = $1`, [cur.body.id])).rejects.toThrow(/append-only/);
  });
});
