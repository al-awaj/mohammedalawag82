import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { codeAt, stepAt, verifyCode } from '../src/lib/totp.js';
import { evaluateCoupon } from '../src/modules/promotions/service.js';
import { api, createStaff, PASSWORD, setupCountry, useApp } from './helpers.js';
import { marketplace } from './fixtures.js';

/** Two-step sign-in, account export and deletion, system status, staff credentials, multi-country promotions. */
const ctx = useApp();
let m: Awaited<ReturnType<typeof marketplace>>;
beforeAll(async () => { m = await marketplace(ctx, 'PAY_SANDBOX_ACCOUNTS_SECRET'); });
afterAll(async () => { await ctx.db.query(`DELETE FROM settings WHERE key = 'security.staff_mfa_required'`); });

const login = (identifier: string, password = PASSWORD) => api(ctx, 'POST', '/v1/auth/login', { body: { identifier, password } });
const now = () => codeAt(secretOf.value!, stepAt(Date.now()));
const secretOf: { value: string | null } = { value: null };

describe('two-step sign-in', () => {
  it('implements RFC 6238 and refuses a code twice', () => {
    // RFC 6238 test vector (SHA-1, T = 59s): 94287082 → last 6 digits.
    expect(codeAt('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 1)).toBe('287082');
    const step = verifyCode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', '287082', 0, 59_000);
    expect(step).toBe(1);
    expect(verifyCode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', '287082', 1, 59_000)).toBeNull();
  });

  it('a staff member turns it on; sign-in then needs a fresh code', async () => {
    const s = await createStaff(ctx, [{ code: 'support_agent' }]);
    const setup = await api(ctx, 'POST', '/v1/me/mfa/setup', { token: s.token });
    expect(setup.body.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
    secretOf.value = setup.body.secret;
    expect((await api(ctx, 'POST', '/v1/me/mfa/enable', { token: s.token, body: { code: '000000' } })).status).toBe(401);
    expect((await api(ctx, 'POST', '/v1/me/mfa/enable', { token: s.token, body: { code: now() } })).status).toBe(204);
    expect((await ctx.db.query('SELECT secret_enc FROM user_mfa WHERE user_id = $1', [s.id])).rows[0].secret_enc).not.toContain(secretOf.value);

    const l = await login(s.email);
    expect(l.body).toMatchObject({ mfaRequired: true });
    expect(l.body.accessToken).toBeUndefined();
    expect((await api(ctx, 'POST', '/v1/auth/mfa/verify', { body: { mfaToken: l.body.mfaToken, code: '000000' } })).status).toBe(401);
    // The code used to enable is spent; wait for the next step to keep the test deterministic.
    await ctx.db.query('UPDATE user_mfa SET last_step = last_step - 1 WHERE user_id = $1', [s.id]);
    const ok = await api(ctx, 'POST', '/v1/auth/mfa/verify', { body: { mfaToken: l.body.mfaToken, code: now() } });
    expect(ok.status).toBe(200);
    expect(ok.body.accessToken).toBeDefined();
    expect((await api(ctx, 'POST', '/v1/auth/mfa/verify', { body: { mfaToken: l.body.mfaToken, code: now() } })).status).toBe(401);

    // Lost phone: an administrator resets it.
    expect((await api(ctx, 'POST', `/v1/admin/staff/${s.id}/mfa/reset`, { token: m.admin.token, body: { reason: 'Lost phone' } })).status).toBe(204);
    expect((await login(s.email)).body.accessToken).toBeDefined();
  });

  it('when required, staff without it must set it up before getting a session', async () => {
    await api(ctx, 'PUT', '/v1/admin/settings/security.staff_mfa_required', { token: m.admin.token, body: { scope: 'global', value: true, reason: 'Security policy' } });
    try {
    const s = await createStaff(ctx, [{ code: 'support_agent' }]);
    expect(s.token).toBeUndefined(); // no session without the second step
    const l = await login(s.email);
    expect(l.body).toMatchObject({ mfaSetupRequired: true });
    const setup = await api(ctx, 'POST', '/v1/auth/mfa/setup', { body: { mfaToken: l.body.mfaToken } });
    secretOf.value = setup.body.secret;
    const ok = await api(ctx, 'POST', '/v1/auth/mfa/verify', { body: { mfaToken: l.body.mfaToken, code: now() } });
    expect(ok.body.accessToken).toBeDefined();
    expect((await api(ctx, 'GET', '/v1/me/mfa', { token: ok.body.accessToken })).body).toMatchObject({ enabled: true, required: true });
    // Customers are not affected.
    const c = await m.customer();
    expect((await api(ctx, 'GET', '/v1/me/mfa', { token: c.token })).body.required).toBe(false);
    } finally {
      await ctx.db.query(`DELETE FROM settings WHERE key = 'security.staff_mfa_required'`);
    }
  });
});

describe('personal data', () => {
  it('exports the data and closes the account only when nothing is open', async () => {
    const h = await m.hall();
    const c = await m.customer();
    const o = await m.order(c.token, h.serviceId);
    const ex = await ctx.app.inject({ method: 'GET', url: '/v1/me/export', headers: { authorization: `Bearer ${c.token}` } });
    expect(ex.headers['content-disposition']).toContain('attachment');
    expect(JSON.parse(ex.body).bookings).toHaveLength(1);

    expect((await api(ctx, 'POST', '/v1/me/delete', { token: c.token, body: { password: 'wrong-password', confirm: true } })).status).toBe(401);
    expect((await api(ctx, 'POST', '/v1/me/delete', { token: c.token, body: { password: PASSWORD, confirm: true } })).body.error.code).toBe('ACCOUNT_HAS_OPEN_ITEMS');
    await ctx.db.query(`UPDATE bookings SET status = 'expired' WHERE id = $1`, [o.bookings[0]!.id]);
    expect((await api(ctx, 'POST', '/v1/me/delete', { token: c.token, body: { password: PASSWORD, confirm: true } })).status).toBe(204);
    const u = (await ctx.db.query('SELECT full_name, phone, email, status FROM users WHERE id = $1', [c.userId])).rows[0];
    expect(u).toMatchObject({ phone: null, status: 'deleted' });
    expect(u.email).toMatch(/@deleted\.invalid$/);
    expect((await ctx.db.query('SELECT 1 FROM bookings WHERE id = $1', [o.bookings[0]!.id])).rowCount).toBe(1);
    expect((await login(c.phone)).status).toBe(401);
    // Providers close accounts through the administration.
    expect((await api(ctx, 'POST', '/v1/me/delete', { token: h.p.token, body: { password: PASSWORD, confirm: true } })).body.error.code).toBe('ACCOUNT_DELETION_BY_SUPPORT');
  });
});

describe('administration', () => {
  it('shows system status to staff only', async () => {
    const r = await api(ctx, 'GET', '/v1/admin/system/status', { token: m.admin.token });
    expect(r.status).toBe(200);
    expect(r.body.database.ok).toBe(true);
    expect(r.body.migrations.latest).toMatch(/^\d{4}_/);
    expect((await api(ctx, 'GET', '/v1/admin/system/status', { token: (await m.customer()).token })).status).toBe(403);
  });

  it('changes a staff email and sets a temporary password', async () => {
    const s = await createStaff(ctx, [{ code: 'support_agent' }]);
    const email = `renamed-${Date.now()}@test.local`;
    expect((await api(ctx, 'PATCH', `/v1/admin/staff/${s.id}`, { token: m.admin.token, body: { email } })).status).toBe(200);
    expect((await api(ctx, 'POST', `/v1/admin/staff/${s.id}/password`, { token: m.admin.token, body: { newPassword: 'Temp-Passw0rd-9', reason: 'Forgot password' } })).status).toBe(204);
    expect((await login(email, 'Temp-Passw0rd-9')).body.accessToken).toBeDefined();
    expect((await api(ctx, 'POST', `/v1/admin/staff/${m.admin.id}/password`, { token: m.admin.token, body: { newPassword: 'Temp-Passw0rd-9', reason: 'x self' } })).status).toBe(400);
  });

  it('applies a multi-country promotion only in its countries', async () => {
    const other = (await setupCountry(ctx, m.admin.token)).id;
    const third = (await setupCountry(ctx, m.admin.token)).id;
    const code = `MULTI${Date.now().toString(36).toUpperCase()}`;
    const r = await api(ctx, 'POST', '/v1/admin/promotions', { token: m.admin.token, body: {
      code, name: { en: 'Two countries' }, discountType: 'percent', discountValue: '10', startsAt: new Date(Date.now() - 60_000).toISOString(),
      endsAt: new Date(Date.now() + 86_400_000).toISOString(), countryIds: [m.country.id, other], costBearer: 'platform' } });
    expect(r.status).toBe(201);
    const item = (countryId: string) => ({ key: 'k', serviceId: m.hallType, serviceTypeId: m.hallType, providerId: m.hallType, countryId, currency: 'SAR', total: '1000.0000', customerId: m.admin.id });
    expect((await evaluateCoupon(ctx.db, code, [item(m.country.id)], false)).total).toBe(1_000_000n);
    expect((await evaluateCoupon(ctx.db, code, [item(other)], false)).total).toBe(1_000_000n);
    await expect(evaluateCoupon(ctx.db, code, [item(third)], false)).rejects.toThrow();
  });
});
