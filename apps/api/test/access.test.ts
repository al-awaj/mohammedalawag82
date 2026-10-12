import { beforeAll, describe, expect, it } from 'vitest';
import { api, createStaff, login, PASSWORD, register, setupCountry, uniq, useApp } from './helpers.js';

const ctx = useApp();
let admin: { id: string; token: string };
let country: { id: string; code: string };

beforeAll(async () => {
  admin = await createStaff(ctx, [{ code: 'system_admin' }]);
  country = await setupCountry(ctx, admin.token);
});

const roleId = async (code: string) => (await ctx.db.query('SELECT id FROM roles WHERE code = $1', [code])).rows[0].id as string;

describe('staff, roles and permissions (test 33)', () => {
  it('creates a staff member with a country-scoped role who can then sign in', async () => {
    const email = `agent-${uniq()}@test.local`;
    const res = await api(ctx, 'POST', '/v1/admin/staff', {
      token: admin.token,
      body: { fullName: 'Bookings Agent', email, password: PASSWORD, jobTitle: 'Agent', roles: [{ roleId: await roleId('bookings_agent'), countryId: country.id }] },
    });
    expect(res.status).toBe(201);
    const token = await login(ctx, email);
    const me = await api(ctx, 'GET', '/v1/me', { token });
    expect(me.body.roles).toEqual([{ code: 'bookings_agent', countryCode: country.code }]);
    expect(me.body.permissions).toContain('bookings.accept');
    expect(me.body.permissions).not.toContain('refunds.execute');
  });

  it('creates a custom role and lists the permission catalog', async () => {
    const perms = await api(ctx, 'GET', '/v1/admin/permissions', { token: admin.token });
    expect(perms.body.length).toBeGreaterThan(40);
    const code = `auditor_${uniq().slice(0, 8)}`;
    const role = await api(ctx, 'POST', '/v1/admin/roles', { token: admin.token, body: { code, name: { ar: 'مدقق', en: 'Auditor' }, permissions: ['audit.view', 'reports.view'] } });
    expect(role.status).toBe(201);
    expect((await api(ctx, 'POST', '/v1/admin/roles', { token: admin.token, body: { code, name: { en: 'Dup' }, permissions: [] } })).body.error.code).toBe('CODE_TAKEN');
    expect((await api(ctx, 'POST', '/v1/admin/roles', { token: admin.token, body: { code: 'x_bad_perm', name: { en: 'X' }, permissions: ['nope.nope'] } })).status).toBe(400);
    expect((await api(ctx, 'DELETE', `/v1/admin/roles/${role.body.id}`, { token: admin.token })).status).toBe(204);
  });

  it('protects system roles', async () => {
    const id = await roleId('system_admin');
    expect((await api(ctx, 'DELETE', `/v1/admin/roles/${id}`, { token: admin.token })).body.error.code).toBe('SYSTEM_ROLE_LOCKED');
    expect((await api(ctx, 'PATCH', `/v1/admin/roles/${id}`, { token: admin.token, body: { permissions: [] } })).body.error.code).toBe('SYSTEM_ROLE_LOCKED');
  });

  it('prevents privilege escalation when granting roles', async () => {
    // A role manager limited to one country cannot grant global roles or roles with permissions they lack.
    const code = `role_mgr_${uniq().slice(0, 8)}`;
    const r = await api(ctx, 'POST', '/v1/admin/roles', { token: admin.token, body: { code, name: { en: 'Role manager' }, permissions: ['roles.view', 'roles.manage', 'bookings.view'] } });
    const mgr = await createStaff(ctx, [{ code, countryId: country.id }]);
    const target = await createStaff(ctx, []);
    const grant = (rid: string, countryId: string | null) =>
      api(ctx, 'PUT', `/v1/admin/staff/${target.id}/roles`, { token: mgr.token, body: { roles: [{ roleId: rid, countryId }], reason: 'Testing escalation' } });

    expect((await grant(await roleId('system_admin'), country.id)).status).toBe(403);
    expect((await grant(r.body.id, null)).status).toBe(403);
    expect((await grant(r.body.id, country.id)).status).toBe(200);
    // Cannot create roles with permissions the actor does not hold globally.
    expect((await api(ctx, 'POST', '/v1/admin/roles', { token: mgr.token, body: { code: `x_${uniq().slice(0, 8)}`, name: { en: 'X' }, permissions: ['refunds.execute'] } })).status).toBe(403);
  });

  it('forbids changing your own roles or status', async () => {
    expect((await api(ctx, 'PUT', `/v1/admin/staff/${admin.id}/roles`, { token: admin.token, body: { roles: [], reason: 'self demotion' } })).body.error.code).toBe('CANNOT_MODIFY_SELF');
    expect((await api(ctx, 'POST', `/v1/admin/users/${admin.id}/status`, { token: admin.token, body: { status: 'disabled', reason: 'self lock' } })).body.error.code).toBe('CANNOT_MODIFY_SELF');
  });

  it('disabling a user blocks access immediately and revokes sessions', async () => {
    const u = await register(ctx, country.code);
    const res = await api(ctx, 'POST', `/v1/admin/users/${u.userId}/status`, { token: admin.token, body: { status: 'disabled', reason: 'Fraudulent activity' } });
    expect(res.status).toBe(200);
    expect((await api(ctx, 'GET', '/v1/me', { token: u.token })).status).toBe(401);
    expect((await api(ctx, 'POST', '/v1/auth/refresh', { body: { refreshToken: u.refreshToken } })).status).toBe(401);
    expect((await api(ctx, 'POST', '/v1/auth/login', { body: { identifier: u.phone, password: PASSWORD } })).body.error.code).toBe('AUTH_ACCOUNT_DISABLED');
    const a = await ctx.db.query(`SELECT reason FROM audit_log WHERE entity_id = $1 AND action = 'user.status_changed'`, [u.userId]);
    expect(a.rows[0].reason).toBe('Fraudulent activity');
  });
});

describe('unauthorized access (test 34)', () => {
  it('customers and providers cannot reach admin endpoints', async () => {
    const c = await register(ctx, country.code);
    const p = await register(ctx, country.code, 'provider');
    for (const token of [c.token, p.token]) {
      for (const [m, url] of [['GET', '/v1/admin/users'], ['GET', '/v1/admin/roles'], ['GET', '/v1/admin/audit-log'], ['GET', '/v1/admin/settings'], ['POST', '/v1/admin/countries']] as const) {
        expect((await api(ctx, m, url, { token, body: m === 'POST' ? {} : undefined })).status).toBe(403);
      }
    }
  });

  it('staff without a permission are refused even when they know the endpoint', async () => {
    const reviewer = await createStaff(ctx, [{ code: 'payment_reviewer' }]);
    expect((await api(ctx, 'POST', '/v1/admin/staff', { token: reviewer.token, body: { fullName: 'X', email: `x-${uniq()}@t.local`, password: PASSWORD } })).status).toBe(403);
    expect((await api(ctx, 'GET', '/v1/admin/users', { token: reviewer.token })).status).toBe(403);
  });

  it('country-scoped staff only see users from their country', async () => {
    const other = await setupCountry(ctx, admin.token, '+971');
    await register(ctx, other.code, 'customer', '+971');
    const scoped = await createStaff(ctx, [{ code: 'manager', countryId: country.id }]);
    const list = await api(ctx, 'GET', '/v1/admin/users', { token: scoped.token });
    expect(list.status).toBe(200);
    expect(list.body.items.length).toBeGreaterThan(0);
    expect(list.body.items.every((u: { countryCode: string }) => u.countryCode === country.code)).toBe(true);
  });
});
