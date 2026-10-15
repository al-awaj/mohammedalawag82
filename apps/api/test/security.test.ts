import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, createStaff, register, setupCountry, useApp } from './helpers.js';

/**
 * Systematic security checks over every route the API exposes (taken from its own OpenAPI document),
 * so a new endpoint cannot ship without authentication or authorisation by accident.
 */
const ctx = useApp();

/** Routes that are intentionally reachable without a session. */
const PUBLIC = new Set([
  'POST /v1/auth/register', 'POST /v1/auth/login', 'POST /v1/auth/refresh', 'POST /v1/auth/password/forgot', 'POST /v1/auth/password/reset',
  'GET /v1/languages', 'GET /v1/currencies', 'GET /v1/countries', 'GET /v1/exchange-rates/latest', 'GET /v1/terms/current',
  'GET /v1/categories', 'GET /v1/categories/{id}/image', 'GET /v1/services', 'GET /v1/services/{id}', 'GET /v1/services/{id}/availability',
  'GET /v1/services/{id}/reviews', 'GET /v1/media/{id}', 'POST /v1/quote', 'GET /v1/providers/{id}', 'GET /v1/help',
  'GET /v1/branding', 'GET /v1/branding/logo',
]);

interface Route { method: string; path: string; url: string }
let routes: Route[] = [];
let customer: { token: string };
let provider: { token: string };
let support: { token: string };
let admin: { token: string };

beforeAll(async () => {
  const spec = ctx.app.swagger() as { paths: Record<string, Record<string, unknown>> };
  routes = Object.entries(spec.paths).flatMap(([path, ops]) => Object.keys(ops).map((m) => ({
    method: m.toUpperCase(), path, url: path.replace(/\{[^}]+\}/g, () => randomUUID()),
  })));
  admin = await createStaff(ctx, [{ code: 'system_admin' }]);
  const country = await setupCountry(ctx, admin.token);
  customer = await register(ctx, country.code, 'customer');
  provider = await register(ctx, country.code, 'provider');
  support = await createStaff(ctx, [{ code: 'support_agent', countryId: country.id }]);
});

const call = (r: Route, token?: string, body: unknown = {}) => ctx.app.inject({
  method: r.method as 'GET', url: r.url,
  headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(r.method !== 'GET' && r.method !== 'DELETE' ? { 'content-type': 'application/json' } : {}) },
  ...(r.method !== 'GET' && r.method !== 'DELETE' ? { payload: JSON.stringify(body) } : {}),
});

describe('authentication on every route (test 34)', () => {
  it('discovers the full route table', () => {
    expect(routes.length).toBeGreaterThan(200);
  });

  it('refuses every non-public route without a session', async () => {
    const leaks: string[] = [];
    for (const r of routes) {
      const key = `${r.method} ${r.path}`;
      if (PUBLIC.has(key) || r.path.startsWith('/v1/webhooks/')) continue;
      const res = await call(r);
      if (res.statusCode !== 401) leaks.push(`${key} → ${res.statusCode}`);
    }
    expect(leaks).toEqual([]);
  });

  it('refuses forged, expired and wrongly signed tokens', async () => {
    const me = routes.find((r) => r.method === 'GET' && r.path === '/v1/me')!;
    const [h, p] = customer.token.split('.');
    const payload = JSON.parse(Buffer.from(p!, 'base64url').toString());
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const forged = [
      `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ ...payload })}.`,                       // unsigned
      `${h}.${b64({ ...payload, sub: randomUUID() })}.${customer.token.split('.')[2]}`,       // tampered subject
      `${h}.${b64({ ...payload, exp: Math.floor(Date.now() / 1000) - 60 })}.${customer.token.split('.')[2]}`, // tampered expiry
      'not-a-token',
    ];
    for (const t of forged) expect((await call(me, t)).statusCode).toBe(401);
  });
});

describe('authorisation by account kind and permission (tests 33-34)', () => {
  it('keeps customers and providers out of every staff route', async () => {
    const leaks: string[] = [];
    for (const r of routes.filter((x) => x.path.startsWith('/v1/admin/'))) {
      for (const [who, token] of [['customer', customer.token], ['provider', provider.token]] as const) {
        const res = await call(r, token);
        if (res.statusCode !== 403 && res.statusCode !== 404) leaks.push(`${who}: ${r.method} ${r.path} → ${res.statusCode}`);
      }
    }
    expect(leaks).toEqual([]);
  });

  it('keeps customers out of the provider panel and providers out of customer-only routes', async () => {
    const leaks: string[] = [];
    for (const r of routes.filter((x) => x.path.startsWith('/v1/provider/'))) {
      const res = await call(r, customer.token);
      if (res.statusCode !== 403 && res.statusCode !== 404) leaks.push(`customer: ${r.method} ${r.path} → ${res.statusCode}`);
    }
    for (const r of routes.filter((x) => /^\/v1\/(cart|checkout|orders|events)/.test(x.path))) {
      const res = await call(r, provider.token);
      if (res.statusCode !== 403 && res.statusCode !== 404) leaks.push(`provider: ${r.method} ${r.path} → ${res.statusCode}`);
    }
    expect(leaks).toEqual([]);
  });

  it('gives a support agent no access to money, settings, roles or reports', async () => {
    const forbidden = /^\/v1\/admin\/(payments|refunds|settlements|earnings|accounts|ledger|commission-rules|payment-|settings|roles|reports|documents|reconciliation|audit-log|staff|exchange-rates|countries|currencies|promotions|notification|messaging|reminder)/;
    const leaks: string[] = [];
    for (const r of routes.filter((x) => forbidden.test(x.path))) {
      const res = await call(r, support.token);
      if (res.statusCode !== 403 && res.statusCode !== 404) leaks.push(`${r.method} ${r.path} → ${res.statusCode}`);
    }
    expect(leaks).toEqual([]);
  });
});

describe('robustness against malformed input', () => {
  it('never answers with a server error to junk input, even for a full administrator', async () => {
    const junk = [{}, { a: "' OR 1=1 --" }, { amount: '-1', reason: '<script>alert(1)</script>', countryId: 'x' }];
    const errors: string[] = [];
    for (const r of routes) {
      if (r.path.startsWith('/v1/webhooks/')) continue;
      for (const body of r.method === 'GET' || r.method === 'DELETE' ? [undefined] : junk) {
        const res = await call(r, admin.token, body);
        if (res.statusCode >= 500) errors.push(`${r.method} ${r.path} → ${res.statusCode} ${res.body.slice(0, 120)}`);
      }
    }
    expect(errors).toEqual([]);
  });

  it('treats injection attempts in search and filters as plain data', async () => {
    const probes = ["' OR '1'='1", '1; DROP TABLE users; --', '%27%20OR%201=1', '\\x00', '"><img src=x onerror=alert(1)>'];
    for (const q of probes) {
      const res = await api(ctx, 'GET', `/v1/services?country=SA&q=${encodeURIComponent(q)}`);
      expect(res.status).toBeLessThan(500);
      const audit = await api(ctx, 'GET', `/v1/admin/audit-log?action=${encodeURIComponent(q)}`, { token: admin.token });
      expect(audit.status).toBeLessThan(500);
    }
    expect((await ctx.db.query('SELECT count(*)::int AS n FROM users')).rows[0].n).toBeGreaterThan(0);
  });

  it('sets security headers and hides server details', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/v1/languages' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
    const notFound = await ctx.app.inject({ method: 'GET', url: '/v1/does-not-exist' });
    expect(notFound.statusCode).toBe(404);
    expect(notFound.body).not.toMatch(/stack|node_modules|at .*\.ts/);
  });
});
