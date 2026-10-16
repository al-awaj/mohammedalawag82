import { beforeAll, describe, expect, it } from 'vitest';
import { api, PNG, upload, useApp } from './helpers.js';
import { marketplace } from './fixtures.js';

/** Package details and images (clause 17), rental items (clause 19) and provider profile changes after approval (clause 7). */
const ctx = useApp();
let m: Awaited<ReturnType<typeof marketplace>>;

beforeAll(async () => {
  m = await marketplace(ctx, 'PAY_SANDBOX_PROFILE_SECRET');
});

describe('packages', () => {
  it('stores every package field and shows images of a package on the public page', async () => {
    const h = await m.hall();
    const pkg = await api(ctx, 'POST', `/v1/provider/services/${h.serviceId}/packages`, { token: h.p.token, body: {
      name: { en: 'Gold' }, price: '25000', currency: 'SAR', pricingUnit: 'fixed', durationMinutes: 300, terms: { en: 'No confetti' },
      availableWeekdays: [4, 5], maxBookingsPerSlot: 2, depositType: 'percent', depositValue: '30', balanceDueDaysBefore: 7,
      validFrom: '2026-01-01', validTo: '2030-12-31', sortOrder: 3, inclusions: [{ en: 'Lighting' }], addOns: [{ code: 'dj', name: { en: 'DJ' }, price: '1500' }] } });
    expect(pkg.status).toBe(201);
    const up = await upload(ctx, `/v1/provider/services/${h.serviceId}/media`, h.p.token, PNG, { packageId: pkg.body.id });
    expect(up.status).toBe(201);
    const pub = (await api(ctx, 'GET', `/v1/services/${h.serviceId}`)).body;
    const p = pub.packages.find((x: { id: string }) => x.id === pkg.body.id);
    expect(p).toMatchObject({ durationMinutes: 300, availableWeekdays: [4, 5], maxBookingsPerSlot: 2, depositType: 'percent', balanceDueDaysBefore: 7, sortOrder: 3 });
    expect(pub.media.find((x: { id: string }) => x.id === up.body.id).packageId).toBe(pkg.body.id);
    // Detach it again.
    expect((await api(ctx, 'PATCH', `/v1/provider/media/${up.body.id}`, { token: h.p.token, body: { packageId: null } })).status).toBe(200);
    expect((await api(ctx, 'GET', `/v1/services/${h.serviceId}`)).body.media.find((x: { id: string }) => x.id === up.body.id).packageId).toBeNull();
  });

  it('refuses to attach an image to a package of another service', async () => {
    const a = await m.hall();
    const b = await m.hall();
    const other = await api(ctx, 'POST', `/v1/provider/services/${b.serviceId}/packages`, { token: b.p.token, body: { name: { en: 'X' }, price: '1', currency: 'SAR', pricingUnit: 'fixed' } });
    const up = await upload(ctx, `/v1/provider/services/${a.serviceId}/media`, a.p.token, PNG, { packageId: other.body.id });
    expect(up.status).toBe(400);
    const own = (await api(ctx, 'GET', `/v1/provider/services/${a.serviceId}`, { token: a.p.token })).body.media[0].id;
    expect((await api(ctx, 'PATCH', `/v1/provider/media/${own}`, { token: a.p.token, body: { packageId: other.body.id } })).status).toBe(400);
  });
});

describe('provider profile', () => {
  it('lets the provider edit day-to-day details directly, with an audit entry', async () => {
    const h = await m.hall();
    const r = await api(ctx, 'PATCH', '/v1/provider/me', { token: h.p.token, body: { city: 'Jeddah', description: 'Seaside venue', latitude: 21.5, longitude: 39.17 } });
    expect(r.status).toBe(200);
    expect((await api(ctx, 'GET', '/v1/provider/me', { token: h.p.token })).body).toMatchObject({ city: 'Jeddah', description: 'Seaside venue' });
    expect((await api(ctx, 'PATCH', '/v1/provider/me', { token: h.p.token, body: { latitude: null } })).status).toBe(400);
    const a = await ctx.db.query(`SELECT 1 FROM audit_log WHERE action = 'provider.profile_updated' AND entity_id = $1`, [h.p.providerId]);
    expect(a.rowCount).toBe(1);
    // The business name is not a direct edit.
    expect((await api(ctx, 'PATCH', '/v1/provider/me', { token: h.p.token, body: { businessName: 'New name' } })).status).toBe(400);
  });

  it('changes the business name only after staff approval, one open request at a time', async () => {
    const h = await m.hall();
    const req1 = await api(ctx, 'POST', '/v1/provider/me/change-requests', { token: h.p.token, body: { changes: { businessName: 'Royal Halls' }, note: 'Rebranded' } });
    expect(req1.status).toBe(201);
    expect((await api(ctx, 'POST', '/v1/provider/me/change-requests', { token: h.p.token, body: { changes: { activityType: 'Venues' } } })).status).toBe(409);
    const before = (await api(ctx, 'GET', '/v1/provider/me', { token: h.p.token })).body.businessName;
    expect(before).not.toBe('Royal Halls');

    const list = (await api(ctx, 'GET', '/v1/admin/provider-change-requests?status=pending', { token: m.supervisor.token })).body.items;
    expect(list.map((x: { id: string }) => x.id)).toContain(req1.body.id);
    expect((await api(ctx, 'POST', `/v1/admin/provider-change-requests/${req1.body.id}/reject`, { token: m.supervisor.token, body: {} })).status).toBe(400);
    expect((await api(ctx, 'POST', `/v1/admin/provider-change-requests/${req1.body.id}/approve`, { token: m.supervisor.token })).status).toBe(200);
    expect((await api(ctx, 'GET', '/v1/provider/me', { token: h.p.token })).body.businessName).toBe('Royal Halls');
    expect((await api(ctx, 'POST', `/v1/admin/provider-change-requests/${req1.body.id}/approve`, { token: m.supervisor.token })).status).toBe(409);
    const mine = (await api(ctx, 'GET', '/v1/provider/me/change-requests', { token: h.p.token })).body;
    expect(mine[0]).toMatchObject({ id: req1.body.id, status: 'approved' });
    const notice = await ctx.db.query(`SELECT 1 FROM message_outbox WHERE template_key = 'provider.profile_change_decided' AND payload->>'status' = 'approved'
      AND recipient_user_id = (SELECT user_id FROM providers WHERE id = $1)`, [h.p.providerId]);
    expect(notice.rowCount).toBeGreaterThan(0);
  });

  it('keeps payout details hidden from staff without the sensitive permission and lets them decide only with it', async () => {
    const h = await m.hall();
    const r = await api(ctx, 'POST', '/v1/provider/me/change-requests', { token: h.p.token, body: { changes: { payoutDetails: { iban: 'SA0380000000608010167519' } } } });
    expect(r.status).toBe(201);
    const seen = (await api(ctx, 'GET', '/v1/admin/provider-change-requests?status=pending', { token: m.supervisor.token })).body.items.find((x: { id: string }) => x.id === r.body.id);
    expect(seen.changes.payoutDetails).toBe('***');
    expect((await api(ctx, 'POST', `/v1/admin/provider-change-requests/${r.body.id}/approve`, { token: m.supervisor.token })).status).toBe(403);
    expect((await api(ctx, 'POST', `/v1/admin/provider-change-requests/${r.body.id}/approve`, { token: m.admin.token })).status).toBe(200);
    expect((await ctx.db.query('SELECT payout_details FROM providers WHERE id = $1', [h.p.providerId])).rows[0].payout_details).toEqual({ iban: 'SA0380000000608010167519' });
    // The audit trail records that payout details changed, never their content.
    const a = (await ctx.db.query(`SELECT after FROM audit_log WHERE action = 'provider.change_approved' AND entity_id = $1`, [h.p.providerId])).rows[0].after;
    expect(JSON.stringify(a)).not.toContain('SA038');
  });

  it('lets the provider withdraw a pending request and file a new one', async () => {
    const h = await m.hall();
    const r = await api(ctx, 'POST', '/v1/provider/me/change-requests', { token: h.p.token, body: { changes: { activityType: 'Venues' } } });
    const other = await m.hall();
    expect((await api(ctx, 'POST', `/v1/provider/me/change-requests/${r.body.id}/withdraw`, { token: other.p.token })).status).toBe(404);
    expect((await api(ctx, 'POST', `/v1/provider/me/change-requests/${r.body.id}/withdraw`, { token: h.p.token })).status).toBe(200);
    expect((await api(ctx, 'POST', '/v1/provider/me/change-requests', { token: h.p.token, body: { changes: { activityType: 'Events' } } })).status).toBe(201);
  });
});
