import { beforeAll, describe, expect, it } from 'vitest';
import { api, createStaff, setupCountry, useApp } from './helpers.js';
import { getSetting } from '../src/modules/settings/registry.js';

const ctx = useApp();
let admin: { id: string; token: string };
let country: { id: string; code: string };

beforeAll(async () => {
  admin = await createStaff(ctx, [{ code: 'system_admin' }]);
  country = await setupCountry(ctx, admin.token);
});

describe('settings', () => {
  it('temporary hold defaults to 15 minutes and is adjustable globally and per country (clause 32)', async () => {
    expect(await getSetting(ctx.db, 'booking.hold_minutes', country.id)).toBe(15);
    const put = (body: object) => api(ctx, 'PUT', '/v1/admin/settings/booking.hold_minutes', { token: admin.token, body });
    expect((await put({ scope: 'global', value: 20, reason: 'Payment gateway is slow' })).status).toBe(200);
    expect(await getSetting(ctx.db, 'booking.hold_minutes', country.id)).toBe(20);
    expect((await put({ scope: 'country', countryId: country.id, value: 10, reason: 'Local policy' })).status).toBe(200);
    expect(await getSetting(ctx.db, 'booking.hold_minutes', country.id)).toBe(10);
    expect(await getSetting(ctx.db, 'booking.hold_minutes', null)).toBe(20);

    expect((await put({ scope: 'global', value: 0, reason: 'invalid' })).body.error.code).toBe('INVALID_SETTING_VALUE');
    expect((await put({ scope: 'global', value: '15', reason: 'invalid' })).body.error.code).toBe('INVALID_SETTING_VALUE');
    expect((await put({ scope: 'country', value: 5, reason: 'no country' })).body.error.code).toBe('SCOPE_NOT_ALLOWED');
    expect((await api(ctx, 'PUT', '/v1/admin/settings/booking.typo', { token: admin.token, body: { scope: 'global', value: 1, reason: 'typo' } })).body.error.code).toBe('UNKNOWN_SETTING');

    // Other test files change this key for their own countries; keep only this file's entries.
    const history = (await api(ctx, 'GET', '/v1/admin/settings/booking.hold_minutes/history', { token: admin.token })).body
      .filter((h: { countryId: string | null }) => h.countryId === null || h.countryId === country.id);
    expect(history.map((h: { newValue: number }) => h.newValue)).toEqual([10, 20]);
    expect(history[1]).toMatchObject({ oldValue: null, reason: 'Payment gateway is slow' });

    // Reset global so other files see the default.
    await put({ scope: 'global', value: 15, reason: 'Restore default' });
  });

  it('lists definitions with effective values', async () => {
    const res = await api(ctx, 'GET', '/v1/admin/settings', { token: admin.token });
    const hold = res.body.find((s: { key: string }) => s.key === 'booking.hold_minutes');
    expect(hold.default).toBe(15);
    expect(hold.scopes).toEqual(['global', 'country']);
  });
});

describe('audit log (clause 70)', () => {
  it('is append-only at the database level', async () => {
    const row = (await ctx.db.query('SELECT id FROM audit_log ORDER BY id DESC LIMIT 1')).rows[0];
    await expect(ctx.db.query('UPDATE audit_log SET action = $2 WHERE id = $1', [row.id, 'tampered'])).rejects.toThrow(/append-only/);
    await expect(ctx.db.query('DELETE FROM audit_log WHERE id = $1', [row.id])).rejects.toThrow(/append-only/);
    await expect(ctx.db.query('TRUNCATE audit_log')).rejects.toThrow(/append-only/);
  });

  it('records actor, before/after and reason, filters by entity, and redacts secrets', async () => {
    const res = await api(ctx, 'GET', `/v1/admin/audit-log?entityType=country&entityId=${country.id}`, { token: admin.token });
    expect(res.status).toBe(200);
    expect(res.body.items[0]).toMatchObject({ action: 'country.created', actorId: admin.id, actorKind: 'staff' });

    const staff = await api(ctx, 'GET', '/v1/admin/audit-log?action=staff.created', { token: admin.token });
    for (const item of staff.body.items) expect(JSON.stringify(item.after)).not.toMatch(/Passw0rd/);

    const paged = await api(ctx, 'GET', '/v1/admin/audit-log?limit=2', { token: admin.token });
    expect(paged.body.items).toHaveLength(2);
    const next = await api(ctx, 'GET', `/v1/admin/audit-log?limit=2&before=${paged.body.nextBefore}`, { token: admin.token });
    expect(Number(next.body.items[0].id)).toBeLessThan(Number(paged.body.nextBefore) + 0.5);
  });

  it('requires global audit.view', async () => {
    const scoped = await createStaff(ctx, [{ code: 'manager', countryId: country.id }]);
    expect((await api(ctx, 'GET', '/v1/admin/audit-log', { token: scoped.token })).status).toBe(403);
  });
});
