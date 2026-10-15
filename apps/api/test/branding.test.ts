import { describe, expect, it } from 'vitest';
import { api, createStaff, PNG, setupCountry, upload, useApp } from './helpers.js';

/** Branding and contact details managed from the admin panel and read publicly by the website and app. */
const ctx = useApp();

describe('branding', () => {
  it('serves name, colour, contacts and logo per country with history', async () => {
    const admin = await createStaff(ctx, [{ code: 'system_admin' }]);
    const country = await setupCountry(ctx, admin.token);
    const put = (key: string, value: unknown, countryId?: string) => api(ctx, 'PUT', `/v1/admin/settings/${key}`, { token: admin.token, body: { scope: countryId ? 'country' : 'global', countryId, value, reason: 'Brand update' } });
    expect((await put('branding.primary_color', 'purple')).status).toBe(400);
    expect((await put('branding.logo', 'branding/x.png')).status).toBe(400);
    expect((await put('branding.name', { ar: 'فرحة', en: 'Farha' }, country.id)).status).toBe(200);
    expect((await put('contact.info', { phone: '+966500000000', email: 'help@example.com' }, country.id)).status).toBe(200);
    expect((await put('contact.social', { instagram: 'http://insecure.example' }, country.id)).status).toBe(400);

    const support = await createStaff(ctx, [{ code: 'support_agent', countryId: country.id }]);
    expect((await upload(ctx, '/v1/admin/branding/logo', support.token, PNG, { reason: 'New logo' }, 'logo.png')).status).toBe(403);
    expect((await upload(ctx, '/v1/admin/branding/logo', admin.token, PNG, { countryId: country.id, reason: 'New logo' }, 'logo.png')).status).toBe(200);

    const b = await api(ctx, 'GET', `/v1/branding?country=${country.code}`);
    expect(b.body).toMatchObject({ name: { ar: 'فرحة' }, contact: { phone: '+966500000000' } });
    expect(b.body.logoUrl).toContain('/v1/branding/logo');
    const logo = await ctx.app.inject({ method: 'GET', url: b.body.logoUrl });
    expect(logo.statusCode).toBe(200);
    expect(logo.headers['content-type']).toBe('image/png');
    const history = await api(ctx, 'GET', '/v1/admin/settings/branding.logo/history', { token: admin.token });
    expect(history.body[0]).toMatchObject({ reason: 'New logo' });
  });
});
