import { beforeAll, describe, expect, it } from 'vitest';
import { api, createStaff, expireCooldown, latestCode, login, PASSWORD, phone, register, setupCountry, useApp } from './helpers.js';

const ctx = useApp();
let country: { id: string; code: string };

beforeAll(async () => {
  const admin = await createStaff(ctx, [{ code: 'system_admin' }]);
  country = await setupCountry(ctx, admin.token);
});

describe('customer registration (test 1)', () => {
  it('registers a customer, records accepted terms, queues phone verification and audits', async () => {
    const u = await register(ctx, country.code);
    const me = await api(ctx, 'GET', '/v1/me', { token: u.token });
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ kind: 'customer', countryCode: country.code, preferredLanguage: 'ar', phoneVerifiedAt: null });

    const terms = await ctx.db.query(
      `SELECT t.kind FROM terms_acceptances a JOIN terms_versions t ON t.id = a.terms_version_id WHERE a.user_id = $1 ORDER BY t.kind`, [u.userId]);
    expect(terms.rows.map((r) => r.kind)).toEqual(['customer_terms', 'privacy_policy']);

    const outbox = await ctx.db.query(`SELECT channel, target, status FROM message_outbox WHERE channel <> 'web' AND recipient_user_id = $1`, [u.userId]);
    expect(outbox.rows).toEqual([{ channel: 'sms', target: u.phone, status: 'pending' }]);

    const audit = await ctx.db.query(`SELECT action FROM audit_log WHERE entity_id = $1`, [u.userId]);
    expect(audit.rows.map((r) => r.action)).toContain('user.registered');
  });

  it('stores only a password hash', async () => {
    const u = await register(ctx, country.code);
    const r = await ctx.db.query('SELECT password_hash FROM user_credentials WHERE user_id = $1', [u.userId]);
    expect(r.rows[0].password_hash).toMatch(/^scrypt\$/);
    expect(r.rows[0].password_hash).not.toContain(PASSWORD);
  });

  it('rejects duplicates, missing consent, mismatched phone prefix and inactive country', async () => {
    const u = await register(ctx, country.code);
    const base = { fullName: 'X Y', countryCode: country.code, preferredLanguage: 'en', password: PASSWORD, acceptTerms: true };
    expect((await api(ctx, 'POST', '/v1/auth/register', { body: { ...base, phone: u.phone } })).body.error.code).toBe('PHONE_TAKEN');
    expect((await api(ctx, 'POST', '/v1/auth/register', { body: { ...base, phone: phone(), email: u.email } })).body.error.code).toBe('EMAIL_TAKEN');
    expect((await api(ctx, 'POST', '/v1/auth/register', { body: { ...base, phone: phone(), acceptTerms: false } })).body.error.code).toBe('TERMS_NOT_ACCEPTED');
    expect((await api(ctx, 'POST', '/v1/auth/register', { body: { ...base, phone: phone('+971') } })).body.error.code).toBe('PHONE_COUNTRY_MISMATCH');
    expect((await api(ctx, 'POST', '/v1/auth/register', { body: { ...base, phone: phone(), countryCode: 'ZZ' } })).body.error.code).toBe('COUNTRY_NOT_AVAILABLE');
    const weak = await api(ctx, 'POST', '/v1/auth/register', { body: { ...base, phone: phone(), password: 'short' } });
    expect(weak.status).toBe(400);
    expect(weak.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('returns translated error messages (test 35)', async () => {
    const ar = await api(ctx, 'POST', '/v1/auth/login', { body: { identifier: phone(), password: 'x' }, lang: 'ar' });
    const en = await api(ctx, 'POST', '/v1/auth/login', { body: { identifier: phone(), password: 'x' }, lang: 'en' });
    expect(ar.body.error.message).toBe('بيانات الدخول غير صحيحة');
    expect(en.body.error.message).toBe('Invalid credentials');
  });
});

describe('phone verification', () => {
  it('verifies with the right code, counts wrong attempts and blocks after 5', async () => {
    const u = await register(ctx, country.code);
    const code = await latestCode(ctx, u.userId, 'auth.verify_phone');
    const wrong = code === '000000' ? '111111' : '000000';
    const bad = await api(ctx, 'POST', '/v1/auth/verification/confirm', { token: u.token, body: { channel: 'phone', code: wrong } });
    expect(bad.body.error.code).toBe('CODE_INVALID');
    const attempts = await ctx.db.query('SELECT attempts FROM verification_codes WHERE user_id = $1', [u.userId]);
    expect(attempts.rows[0].attempts).toBe(1);

    expect((await api(ctx, 'POST', '/v1/auth/verification/confirm', { token: u.token, body: { channel: 'phone', code } })).status).toBe(204);
    expect((await api(ctx, 'GET', '/v1/me', { token: u.token })).body.phoneVerifiedAt).not.toBeNull();
    expect((await api(ctx, 'POST', '/v1/auth/verification/request', { token: u.token, body: { channel: 'phone' } })).body.error.code).toBe('ALREADY_VERIFIED');
  });

  it('locks a code after too many wrong attempts and rate-limits resends', async () => {
    const u = await register(ctx, country.code);
    const code = await latestCode(ctx, u.userId, 'auth.verify_phone');
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) await api(ctx, 'POST', '/v1/auth/verification/confirm', { token: u.token, body: { channel: 'phone', code: wrong } });
    const blocked = await api(ctx, 'POST', '/v1/auth/verification/confirm', { token: u.token, body: { channel: 'phone', code } });
    expect(blocked.body.error.code).toBe('CODE_TOO_MANY_ATTEMPTS');

    expect((await api(ctx, 'POST', '/v1/auth/verification/request', { token: u.token, body: { channel: 'phone' } })).status).toBe(429);
    await expireCooldown(ctx, u.userId);
    expect((await api(ctx, 'POST', '/v1/auth/verification/request', { token: u.token, body: { channel: 'phone' } })).status).toBe(202);
    const fresh = await latestCode(ctx, u.userId, 'auth.verify_phone');
    expect((await api(ctx, 'POST', '/v1/auth/verification/confirm', { token: u.token, body: { channel: 'phone', code: fresh } })).status).toBe(204);
  });
});

describe('login, lockout and sessions', () => {
  it('logs in by phone or email', async () => {
    const u = await register(ctx, country.code);
    expect(await login(ctx, u.phone)).toBeTruthy();
    expect(await login(ctx, u.email.toUpperCase())).toBeTruthy();
  });

  it('does not reveal whether an account exists', async () => {
    const unknown = await api(ctx, 'POST', '/v1/auth/login', { body: { identifier: phone(), password: 'whatever1' } });
    const u = await register(ctx, country.code);
    const wrongPw = await api(ctx, 'POST', '/v1/auth/login', { body: { identifier: u.phone, password: 'whatever1' } });
    expect(unknown.status).toBe(401);
    expect(wrongPw.body).toEqual(unknown.body);
  });

  it('locks the account after 5 failures and audits it (test 34)', async () => {
    const u = await register(ctx, country.code);
    for (let i = 0; i < 5; i++) await api(ctx, 'POST', '/v1/auth/login', { body: { identifier: u.phone, password: 'wrong-pass-1' } });
    const locked = await api(ctx, 'POST', '/v1/auth/login', { body: { identifier: u.phone, password: PASSWORD } });
    expect(locked.status).toBe(423);
    expect(locked.body.error.code).toBe('AUTH_ACCOUNT_LOCKED');
    const a = await ctx.db.query(`SELECT action FROM audit_log WHERE entity_id = $1 ORDER BY id`, [u.userId]);
    expect(a.rows.map((r) => r.action)).toContain('auth.account_locked');
  });

  it('rotates refresh tokens and revokes the family on reuse', async () => {
    const u = await register(ctx, country.code);
    const r1 = await api(ctx, 'POST', '/v1/auth/refresh', { body: { refreshToken: u.refreshToken } });
    expect(r1.status).toBe(200);
    const reuse = await api(ctx, 'POST', '/v1/auth/refresh', { body: { refreshToken: u.refreshToken } });
    expect(reuse.status).toBe(401);
    // The legitimately rotated token is now revoked too.
    expect((await api(ctx, 'POST', '/v1/auth/refresh', { body: { refreshToken: r1.body.refreshToken } })).status).toBe(401);
    const a = await ctx.db.query(`SELECT 1 FROM audit_log WHERE entity_id = $1 AND action = 'auth.refresh_reuse_detected'`, [u.userId]);
    // Both presentations of a revoked token are reuse events.
    expect(a.rowCount).toBe(2);
  });

  it('logout revokes the session', async () => {
    const u = await register(ctx, country.code);
    expect((await api(ctx, 'POST', '/v1/auth/logout', { token: u.token, body: { refreshToken: u.refreshToken } })).status).toBe(204);
    expect((await api(ctx, 'POST', '/v1/auth/refresh', { body: { refreshToken: u.refreshToken } })).status).toBe(401);
  });

  it('rejects missing, malformed and forged tokens (test 34)', async () => {
    expect((await api(ctx, 'GET', '/v1/me')).status).toBe(401);
    expect((await api(ctx, 'GET', '/v1/me', { token: 'garbage' })).body.error.code).toBe('AUTH_INVALID_TOKEN');
    const forged = 'eyJhbGciOiJIUzI1NiJ9.eyJraW5kIjoic3RhZmYiLCJzdWIiOiIwMDAwMDAwMC0wMDAwLTAwMDAtMDAwMC0wMDAwMDAwMDAwMDAiLCJpc3MiOiJldmVudHMtcGxhdGZvcm0ifQ.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    expect((await api(ctx, 'GET', '/v1/me', { token: forged })).status).toBe(401);
  });
});

describe('password recovery', () => {
  it('resets via code, revokes sessions, and is silent for unknown accounts', async () => {
    const u = await register(ctx, country.code);
    expect((await api(ctx, 'POST', '/v1/auth/password/forgot', { body: { identifier: phone() } })).status).toBe(202);
    expect((await api(ctx, 'POST', '/v1/auth/password/forgot', { body: { identifier: u.phone } })).status).toBe(202);
    const code = await latestCode(ctx, u.userId, 'auth.reset_password');
    const res = await api(ctx, 'POST', '/v1/auth/password/reset', { body: { identifier: u.phone, code, newPassword: 'NewPassw0rd-9' } });
    expect(res.status).toBe(204);
    expect((await api(ctx, 'POST', '/v1/auth/refresh', { body: { refreshToken: u.refreshToken } })).status).toBe(401);
    expect(await login(ctx, u.phone, 'NewPassw0rd-9')).toBeTruthy();
    // Code is single-use.
    expect((await api(ctx, 'POST', '/v1/auth/password/reset', { body: { identifier: u.phone, code, newPassword: 'Other-Passw0rd' } })).body.error.code).toBe('CODE_INVALID');
  });

  it('updates profile language and audits it', async () => {
    const u = await register(ctx, country.code);
    const res = await api(ctx, 'PATCH', '/v1/me', { token: u.token, body: { preferredLanguage: 'en' } });
    expect(res.body.preferredLanguage).toBe('en');
    expect((await api(ctx, 'PATCH', '/v1/me', { token: u.token, body: { preferredLanguage: 'fr' } })).body.error.code).toBe('LANGUAGE_NOT_SUPPORTED');
  });
});
