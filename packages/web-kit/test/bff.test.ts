import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBff } from '../src/bff';

const API = 'http://api.test';
const tokens = (n: number) => ({ accessToken: `at-${n}-${'x'.repeat(20)}`, refreshToken: `rt-${n}-${'y'.repeat(20)}`, expiresIn: 900 });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const req = (method: string, path: string, init: { cookie?: string; body?: unknown; headers?: Record<string, string> } = {}) =>
  new Request(`http://admin.test${path}`, {
    method,
    headers: { host: 'admin.test', ...(init.cookie ? { cookie: init.cookie } : {}), ...(method !== 'GET' ? { 'x-csrf': '1' } : {}), ...init.headers },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });

afterEach(() => vi.unstubAllGlobals());

describe('browser proxy (BFF)', () => {
  const bff = createBff({ apiUrl: API, kinds: ['staff'], cookiePrefix: 'adm' });

  it('signs in only accounts of the right kind and keeps tokens in httpOnly cookies', async () => {
    let kind = 'staff';
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(url);
      if (url.endsWith('/v1/auth/login')) return json(200, tokens(1));
      if (url.endsWith('/v1/me')) return json(200, { id: 'u1', kind });
      if (url.endsWith('/v1/auth/logout')) return json(200, {});
      return json(404, {});
    }));
    const ok = await bff.handle(req('POST', '/bff/session/login', { body: { identifier: 'a', password: 'b' } }), ['session', 'login']);
    expect(ok.status).toBe(200);
    const cookies = ok.headers.getSetCookie();
    expect(cookies.some((c) => c.startsWith('adm_at=at-1') && c.includes('HttpOnly') && c.includes('SameSite=Strict') && c.includes('Path=/bff'))).toBe(true);
    expect(JSON.stringify(await ok.json())).not.toContain('at-1');

    kind = 'customer';
    const wrong = await bff.handle(req('POST', '/bff/session/login', { body: { identifier: 'a', password: 'b' } }), ['session', 'login']);
    expect(wrong.status).toBe(403);
    expect(wrong.headers.getSetCookie()).toEqual([]);
    expect(calls.filter((c) => c.endsWith('/v1/auth/logout'))).toHaveLength(1); // the stray session is revoked
  });

  it('rejects cross-site and unmarked mutations', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(200, {})));
    const noHeader = new Request('http://admin.test/bff/v1/admin/roles', { method: 'POST', headers: { host: 'admin.test' }, body: '{}' });
    expect((await bff.handle(noHeader, ['v1', 'admin', 'roles'])).status).toBe(403);
    const crossSite = req('POST', '/bff/v1/admin/roles', { body: {}, headers: { origin: 'https://evil.example' } });
    expect((await bff.handle(crossSite, ['v1', 'admin', 'roles'])).status).toBe(403);
    expect((await bff.handle(req('POST', '/bff/v1/auth/refresh', { body: {} }), ['v1', 'auth', 'refresh'])).status).toBe(404);
    expect((await bff.handle(req('POST', '/bff/v1/webhooks/payments/x', { body: {} }), ['v1', 'webhooks', 'payments', 'x'])).status).toBe(404);
  });

  it('refreshes an expired session once for parallel requests', async () => {
    let refreshes = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith('/v1/auth/refresh')) { refreshes++; await new Promise((r) => setTimeout(r, 20)); return json(200, tokens(2)); }
      const auth = new Headers(init.headers).get('authorization');
      return auth === `Bearer ${tokens(2).accessToken}` ? json(200, [{ id: 1 }]) : json(401, { error: { code: 'AUTH_REQUIRED' } });
    }));
    const cookie = `adm_rt=${tokens(1).refreshToken}`;
    const res = await Promise.all([1, 2, 3].map(() => bff.handle(req('GET', '/bff/v1/admin/bookings?limit=5', { cookie }), ['v1', 'admin', 'bookings'])));
    expect(res.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(refreshes).toBe(1);
    expect(res[0]!.headers.getSetCookie().some((c) => c.startsWith('adm_at=at-2'))).toBe(true);
  });
});
