import { randomInt } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createPool, type Db } from '../src/db/pool.js';
import { hashPassword } from '../src/lib/password.js';

export interface Ctx {
  app: FastifyInstance;
  db: Db;
}

/** Boots the real app on the test database for one test file. */
export function useApp(): Ctx {
  const ctx = {} as Ctx;
  beforeAll(async () => {
    const config = loadConfig();
    ctx.db = createPool(config.DATABASE_URL);
    ctx.app = (await buildApp(config, ctx.db)) as unknown as FastifyInstance;
    await ctx.app.ready();
  });
  afterAll(async () => {
    await ctx.app.close();
    await ctx.db.end();
  });
  return ctx;
}

export const PASSWORD = 'Passw0rd-123';
export const uniq = () => `${Date.now().toString(36)}${randomInt(1e6).toString(36)}`;

/** Random 2-letter country code not yet used in this database. */
export async function freshCountryCode(db: Db): Promise<string> {
  for (;;) {
    const code = String.fromCharCode(65 + randomInt(26), 65 + randomInt(26));
    const r = await db.query('SELECT 1 FROM countries WHERE code = $1', [code]);
    if (!r.rowCount) return code;
  }
}

export function phone(prefix = '+966') {
  return `${prefix}5${String(randomInt(1e8)).padStart(8, '0')}`;
}

export async function api(ctx: Ctx, method: string, url: string, opts: { token?: string; body?: unknown; lang?: string } = {}) {
  const res = await ctx.app.inject({
    method: method as 'GET',
    url,
    headers: {
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.lang ? { 'accept-language': opts.lang } : {}),
    },
    ...(opts.body !== undefined ? { payload: opts.body as object } : {}),
  });
  return { status: res.statusCode, body: res.body ? (() => { try { return JSON.parse(res.body); } catch { return res.body; } })() : null };
}

/** Creates a staff user directly with the given system/custom role codes (global unless countryId given). */
export async function createStaff(ctx: Ctx, roles: { code: string; countryId?: string | null }[]): Promise<{ id: string; token: string; email: string }> {
  const email = `staff-${uniq()}@test.local`;
  const id = (await ctx.db.query<{ id: string }>(
    `INSERT INTO users (kind, full_name, email, preferred_language) VALUES ('staff', 'Staff Member', $1, 'en') RETURNING id`, [email])).rows[0]!.id;
  await ctx.db.query('INSERT INTO user_credentials (user_id, password_hash) VALUES ($1, $2)', [id, await hashPassword(PASSWORD)]);
  await ctx.db.query('INSERT INTO staff_profiles (user_id) VALUES ($1)', [id]);
  for (const r of roles) {
    await ctx.db.query('INSERT INTO user_roles (user_id, role_id, country_id) SELECT $1, id, $3 FROM roles WHERE code = $2', [id, r.code, r.countryId ?? null]);
  }
  return { id, email, token: await login(ctx, email) };
}

export async function login(ctx: Ctx, identifier: string, password = PASSWORD): Promise<string> {
  const res = await api(ctx, 'POST', '/v1/auth/login', { body: { identifier, password } });
  if (res.status !== 200) throw new Error(`login failed: ${JSON.stringify(res.body)}`);
  return res.body.accessToken;
}

/** Creates an active country with published customer/provider terms and privacy policy, via the admin API. */
export async function setupCountry(ctx: Ctx, adminToken: string, prefix = '+966'): Promise<{ id: string; code: string }> {
  const code = await freshCountryCode(ctx.db);
  const res = await api(ctx, 'POST', '/v1/admin/countries', {
    token: adminToken,
    body: { code, name: { ar: `دولة ${code}`, en: `Country ${code}` }, baseCurrency: 'SAR', timezone: 'Asia/Riyadh', defaultLanguage: 'ar', phonePrefix: prefix, isActive: true, currencies: ['USD'] },
  });
  if (res.status !== 201) throw new Error(`country: ${JSON.stringify(res.body)}`);
  for (const kind of ['customer_terms', 'provider_terms', 'privacy_policy']) {
    const t = await api(ctx, 'POST', '/v1/admin/terms', { token: adminToken, body: { kind, countryId: res.body.id, version: '1.0', content: { ar: 'نص', en: 'Text' } } });
    if (t.status !== 201) throw new Error(`terms: ${JSON.stringify(t.body)}`);
  }
  return { id: res.body.id, code };
}

export async function register(ctx: Ctx, countryCode: string, accountType: 'customer' | 'provider' = 'customer', prefix = '+966') {
  const p = phone(prefix);
  const email = `u-${uniq()}@test.local`;
  const res = await api(ctx, 'POST', '/v1/auth/register', {
    body: { accountType, fullName: 'Test User', phone: p, email, countryCode, preferredLanguage: 'ar', password: PASSWORD, acceptTerms: true },
  });
  if (res.status !== 201) throw new Error(`register: ${JSON.stringify(res.body)}`);
  return { userId: res.body.userId as string, token: res.body.accessToken as string, refreshToken: res.body.refreshToken as string, phone: p, email };
}

/** Reads the latest OTP queued for a user (what the SMS/email driver would deliver). */
export async function latestCode(ctx: Ctx, userId: string, templateKey: string): Promise<string> {
  const r = await ctx.db.query<{ payload: { code: string } }>(
    `SELECT payload FROM message_outbox WHERE channel <> 'web' AND recipient_user_id = $1 AND template_key = $2 ORDER BY created_at DESC LIMIT 1`, [userId, templateKey]);
  return r.rows[0]!.payload.code;
}

/** Lets a resend happen in tests without waiting for the 60s cool-down. */
export async function expireCooldown(ctx: Ctx, userId: string) {
  await ctx.db.query(`UPDATE verification_codes SET created_at = created_at - interval '2 minutes' WHERE user_id = $1`, [userId]);
}

export const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
// Smallest valid PNG header + IHDR is enough for magic-byte detection.
export const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
export const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(64, 2)]);

/** multipart/form-data upload; text fields are sent before the file as the API requires. */
export async function upload(ctx: Ctx, url: string, token: string, file: Buffer, fields: Record<string, string> = {}, name = 'file.bin') {
  const boundary = '----test' + Math.random().toString(16).slice(2);
  const parts = Object.entries(fields).map(([k, v]) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  const payload = Buffer.concat([
    ...parts,
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    file,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await ctx.app.inject({ method: 'POST', url, payload, headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/form-data; boundary=${boundary}` } });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

/** Full onboarding through the real API: register, verify phone, apply with documents, approve. */
export async function approvedProvider(ctx: Ctx, staffToken: string, countryCode: string, prefix = '+966') {
  const p = await register(ctx, countryCode, 'provider', prefix);
  const code = await latestCode(ctx, p.userId, 'auth.verify_phone');
  await api(ctx, 'POST', '/v1/auth/verification/confirm', { token: p.token, body: { channel: 'phone', code } });
  const app = await api(ctx, 'POST', '/v1/provider-applications', {
    token: p.token, body: { businessName: `Biz ${uniq()}`, activityType: 'events', countryCode, city: 'Riyadh', phone: p.phone },
  });
  for (const docType of ['identity', 'commercial_registration']) {
    await upload(ctx, `/v1/provider-applications/${app.body.id}/documents`, p.token, PDF, { docType });
  }
  await api(ctx, 'POST', `/v1/provider-applications/${app.body.id}/submit`, { token: p.token, body: { acceptTerms: true } });
  const ok = await api(ctx, 'POST', `/v1/admin/provider-applications/${app.body.id}/actions`, { token: staffToken, body: { action: 'approve' } });
  if (ok.status !== 200) throw new Error(`approve: ${JSON.stringify(ok.body)}`);
  const providerId = (await ctx.db.query<{ id: string }>('SELECT id FROM providers WHERE user_id = $1', [p.userId])).rows[0]!.id;
  return { ...p, providerId, applicationId: app.body.id as string };
}
