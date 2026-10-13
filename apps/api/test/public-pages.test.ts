import { beforeAll, describe, expect, it } from 'vitest';
import { api, createStaff, useApp } from './helpers.js';
import { marketplace } from './fixtures.js';

/** Public provider pages that respect identity visibility (clause 68) and the help centre managed by staff (clause 60). */
const ctx = useApp();
let m: Awaited<ReturnType<typeof marketplace>>;

beforeAll(async () => {
  m = await marketplace(ctx, 'PAY_SANDBOX_PAGES_SECRET');
});

describe('public provider page', () => {
  it('shows the business and its published services, and disappears when identity is hidden', async () => {
    const h = await m.hall();
    const page = await api(ctx, 'GET', `/v1/providers/${h.p.providerId}`);
    expect(page.status).toBe(200);
    expect(page.body).toMatchObject({ id: h.p.providerId, serviceCount: 1, rating: { count: 0 } });
    expect(page.body).not.toHaveProperty('payoutDetails');
    const list = await api(ctx, 'GET', `/v1/services?country=${m.country.code}&provider=${h.p.providerId}`);
    expect(list.body.items.map((s: { id: string }) => s.id)).toEqual([h.serviceId]);

    // The provider's own flag hides it.
    await ctx.db.query('UPDATE providers SET show_identity = false WHERE id = $1', [h.p.providerId]);
    expect((await api(ctx, 'GET', `/v1/providers/${h.p.providerId}`)).status).toBe(404);
    expect((await api(ctx, 'GET', `/v1/services?country=${m.country.code}&provider=${h.p.providerId}`)).body.items).toEqual([]);
    await ctx.db.query('UPDATE providers SET show_identity = true WHERE id = $1', [h.p.providerId]);

    // So does the country setting.
    await api(ctx, 'PUT', '/v1/admin/settings/providers.public_identity_visible', { token: m.admin.token, body: { scope: 'country', countryId: m.country.id, value: false, reason: 'Anonymous marketplace' } });
    try {
      expect((await api(ctx, 'GET', `/v1/providers/${h.p.providerId}`)).status).toBe(404);
      expect((await api(ctx, 'GET', `/v1/services?country=${m.country.code}&provider=${h.p.providerId}`)).body.items).toEqual([]);
    } finally {
      await api(ctx, 'PUT', '/v1/admin/settings/providers.public_identity_visible', { token: m.admin.token, body: { scope: 'country', countryId: m.country.id, value: true, reason: 'Restore' } });
    }
  });

  it('has no page for a suspended provider', async () => {
    const h = await m.hall();
    await ctx.db.query(`UPDATE providers SET status = 'suspended' WHERE id = $1`, [h.p.providerId]);
    expect((await api(ctx, 'GET', `/v1/providers/${h.p.providerId}`)).status).toBe(404);
  });
});

describe('help centre', () => {
  it('publishes articles per audience and country, and keeps drafts private', async () => {
    const make = (body: object) => api(ctx, 'POST', '/v1/admin/help-articles', { token: m.admin.token, body });
    const all = await make({ audience: 'all', topic: 'payments', question: { ar: 'كيف أدفع؟', en: 'How do I pay?' }, answer: { en: 'By card or transfer.' }, isPublished: true });
    const cust = await make({ countryId: m.country.id, audience: 'customer', topic: 'booking', question: { en: 'Can I cancel?' }, answer: { en: 'Per the policy.' }, isPublished: true });
    const prov = await make({ countryId: m.country.id, audience: 'provider', topic: 'earnings', question: { en: 'When am I paid?' }, answer: { en: 'After completion.' }, isPublished: true });
    const draft = await make({ countryId: m.country.id, audience: 'customer', topic: 'booking', question: { en: 'Draft' }, answer: { en: 'Draft' } });
    for (const r of [all, cust, prov, draft]) expect(r.status).toBe(201);

    const forCustomers = (await api(ctx, 'GET', `/v1/help?country=${m.country.code}`)).body.map((a: { id: string }) => a.id);
    expect(forCustomers).toEqual(expect.arrayContaining([all.body.id, cust.body.id]));
    expect(forCustomers).not.toContain(prov.body.id);
    expect(forCustomers).not.toContain(draft.body.id);
    const forProviders = (await api(ctx, 'GET', `/v1/help?country=${m.country.code}&audience=provider`)).body.map((a: { id: string }) => a.id);
    expect(forProviders).toEqual(expect.arrayContaining([all.body.id, prov.body.id]));
    expect(forProviders).not.toContain(cust.body.id);

    // Unpublishing hides it again; edits are audited.
    expect((await api(ctx, 'PATCH', `/v1/admin/help-articles/${cust.body.id}`, { token: m.admin.token, body: { isPublished: false } })).status).toBe(200);
    expect((await api(ctx, 'GET', `/v1/help?country=${m.country.code}`)).body.map((a: { id: string }) => a.id)).not.toContain(cust.body.id);
    expect((await ctx.db.query(`SELECT 1 FROM audit_log WHERE action = 'help.updated' AND entity_id = $1`, [cust.body.id])).rowCount).toBe(1);
  });

  it('limits country-scoped staff to their countries', async () => {
    const editor = await createStaff(ctx, [{ code: 'manager', countryId: m.country.id }]);
    const global = await api(ctx, 'POST', '/v1/admin/help-articles', { token: editor.token, body: { audience: 'all', topic: 'x', question: { en: 'Q' }, answer: { en: 'A' } } });
    expect(global.status).toBe(403);
    const local = await api(ctx, 'POST', '/v1/admin/help-articles', { token: editor.token, body: { countryId: m.country.id, audience: 'all', topic: 'x', question: { en: 'Q' }, answer: { en: 'A' } } });
    expect(local.status).toBe(201);
    const customer = await m.customer();
    expect((await api(ctx, 'GET', '/v1/admin/help-articles', { token: customer.token })).status).toBe(403);
  });
});
