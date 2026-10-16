import { createHash } from 'node:crypto';

/**
 * Backend-for-frontend used by the three web interfaces. The browser never sees an access or refresh
 * token: both live in httpOnly, SameSite=Strict cookies scoped to /bff, and every API call goes through
 * this proxy, which attaches the bearer token and rotates it when it expires.
 *
 *   POST /bff/session/login     { identifier, password }  → sets cookies if the account kind fits this app
 *   POST /bff/session/register  (customer and provider apps) → registers and signs in
 *   POST /bff/session/logout
 *   GET  /bff/session            → the current user (/v1/me) or 401
 *   *    /bff/v1/...             → proxied to the API
 *
 * Mutating requests must carry `x-csrf: 1` (a custom header cannot be sent cross-site without a CORS
 * preflight, which this proxy never grants) and, when the browser sends one, a same-origin Origin.
 */
export type AccountKind = 'staff' | 'provider' | 'customer';

export interface BffOptions {
  apiUrl: string;
  kinds: AccountKind[];
  cookiePrefix: string;
  allowRegister?: boolean;
  secureCookies?: boolean;
}

interface Tokens { accessToken: string; refreshToken: string; expiresIn: number }

const REFRESH_DAYS = 30;
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const HOP_HEADERS = ['content-type', 'content-disposition', 'cache-control'];

/**
 * Refresh tokens rotate and a reused one revokes the whole session (theft detection), so parallel
 * requests holding the same expired cookie must share one refresh. Results are kept briefly for
 * requests that were already in flight with the old cookie. Per process: run one instance per session
 * (sticky sessions) or share this cache if the web tier is scaled out.
 */
const inflight = new Map<string, { at: number; p: Promise<Tokens | null> }>();
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/**
 * `localhost` can resolve to the IPv6 address first (Windows, recent Node) while the API listens on IPv4,
 * which makes every proxied call fail. Server-to-server calls use the IPv4 loopback explicitly.
 */
export function apiBase(url: string) {
  return url.replace(/^(https?:\/\/)localhost(?=[:/]|$)/i, '$1127.0.0.1').replace(/\/+$/, '');
}

export function createBff(opts: BffOptions) {
  const API = apiBase(opts.apiUrl);
  const AT = `${opts.cookiePrefix}_at`;
  const RT = `${opts.cookiePrefix}_rt`;
  // COOKIE_SECURE=false allows a production build on plain http://localhost (scripts/start-local.mjs).
  const secure = opts.secureCookies ?? (process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE !== 'false' : process.env.NODE_ENV === 'production');
  const cookie = (name: string, value: string, maxAge: number) =>
    `${name}=${encodeURIComponent(value)}; Path=/bff; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
  const setSession = (h: Headers, t: Tokens) => {
    // The access cookie expires a little before the token so a refresh happens first.
    h.append('set-cookie', cookie(AT, t.accessToken, Math.max(10, t.expiresIn - 30)));
    h.append('set-cookie', cookie(RT, t.refreshToken, REFRESH_DAYS * 86400));
  };
  const clearSession = (h: Headers) => {
    h.append('set-cookie', cookie(AT, '', 0));
    h.append('set-cookie', cookie(RT, '', 0));
  };
  const json = (status: number, body: unknown, headers = new Headers()) => {
    headers.set('content-type', 'application/json; charset=utf-8');
    headers.set('cache-control', 'no-store');
    return new Response(JSON.stringify(body), { status, headers });
  };
  const error = (status: number, code: string, message: string) => json(status, { error: { code, message } });

  const forwarded = (req: Request) => {
    const h: Record<string, string> = {};
    const xff = req.headers.get('x-forwarded-for');
    if (xff) h['x-forwarded-for'] = xff;
    const lang = req.headers.get('accept-language');
    if (lang) h['accept-language'] = lang;
    return h;
  };

  async function api(path: string, init: RequestInit & { token?: string } = {}) {
    const headers = new Headers(init.headers);
    if (init.token) headers.set('authorization', `Bearer ${init.token}`);
    return fetch(`${API}${path}`, { ...init, headers, redirect: 'manual', cache: 'no-store' });
  }

  async function refresh(rt: string, req: Request): Promise<Tokens | null> {
    const key = sha(rt);
    const now = Date.now();
    for (const [k, v] of inflight) if (now - v.at > 60_000) inflight.delete(k);
    const hit = inflight.get(key);
    if (hit) return hit.p;
    const p = (async () => {
      const r = await api('/v1/auth/refresh', { method: 'POST', headers: { 'content-type': 'application/json', ...forwarded(req) }, body: JSON.stringify({ refreshToken: rt }) });
      return r.ok ? ((await r.json()) as Tokens) : null;
    })();
    inflight.set(key, { at: now, p });
    return p;
  }

  async function me(token: string, req: Request) {
    const r = await api('/v1/me', { token, headers: forwarded(req) });
    return r.ok ? ((await r.json()) as { kind: AccountKind } & Record<string, unknown>) : null;
  }

  function csrfOk(req: Request): boolean {
    if (!MUTATING.has(req.method)) return true;
    if (req.headers.get('x-csrf') !== '1') return false;
    const origin = req.headers.get('origin');
    if (!origin) return true;
    const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
    try { return new URL(origin).host === host; } catch { return false; }
  }

  /** Signs in with fresh tokens: checks the account kind belongs to this interface. */
  async function startSession(t: Tokens, req: Request) {
    const user = await me(t.accessToken, req);
    if (!user || !opts.kinds.includes(user.kind)) {
      await api('/v1/auth/logout', { method: 'POST', token: t.accessToken, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken: t.refreshToken }) });
      const ar = (req.headers.get('accept-language') ?? '').startsWith('ar');
      return error(403, 'WRONG_ACCOUNT_TYPE', ar ? 'هذا الحساب لا يستخدم هذه الواجهة' : 'This account cannot use this application');
    }
    const h = new Headers();
    setSession(h, t);
    return json(200, user, h);
  }

  async function session(req: Request, action: string) {
    const cookies = parseCookies(req.headers.get('cookie'));
    if (action === 'login' && req.method === 'POST') {
      const r = await api('/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', ...forwarded(req) }, body: await req.text() });
      if (!r.ok) return new Response(await r.text(), { status: r.status, headers: { 'content-type': 'application/json' } });
      const body = (await r.json()) as Tokens & { mfaToken?: string };
      // Second step pending: no session yet; the page asks for the authenticator code.
      if (body.mfaToken) return json(200, body);
      return startSession(body, req);
    }
    if (action === 'mfa' && req.method === 'POST') {
      const r = await api('/v1/auth/mfa/verify', { method: 'POST', headers: { 'content-type': 'application/json', ...forwarded(req) }, body: await req.text() });
      if (!r.ok) return new Response(await r.text(), { status: r.status, headers: { 'content-type': 'application/json' } });
      return startSession((await r.json()) as Tokens, req);
    }
    if (action === 'mfa-setup' && req.method === 'POST') {
      const r = await api('/v1/auth/mfa/setup', { method: 'POST', headers: { 'content-type': 'application/json', ...forwarded(req) }, body: await req.text() });
      return new Response(await r.text(), { status: r.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
    }
    if (action === 'register' && req.method === 'POST' && opts.allowRegister) {
      const body = JSON.parse((await req.text()) || '{}') as Record<string, unknown>;
      const accountType = opts.kinds.includes('provider') ? 'provider' : 'customer';
      const r = await api('/v1/auth/register', { method: 'POST', headers: { 'content-type': 'application/json', ...forwarded(req) }, body: JSON.stringify({ ...body, accountType }) });
      if (!r.ok) return new Response(await r.text(), { status: r.status, headers: { 'content-type': 'application/json' } });
      return startSession((await r.json()) as Tokens, req);
    }
    if (action === 'logout' && req.method === 'POST') {
      const h = new Headers();
      clearSession(h);
      if (cookies[AT] || cookies[RT]) {
        let token = cookies[AT];
        if (!token && cookies[RT]) token = (await refresh(cookies[RT]!, req))?.accessToken;
        if (token) await api('/v1/auth/logout', { method: 'POST', token, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken: cookies[RT] }) });
      }
      return json(200, { ok: true }, h);
    }
    if (action === '' && req.method === 'GET') return proxy(req, '/v1/me');
    return error(404, 'NOT_FOUND', 'Not found');
  }

  async function proxy(req: Request, apiPath: string) {
    const cookies = parseCookies(req.headers.get('cookie'));
    const out = new Headers({ 'cache-control': 'no-store' });
    let token = cookies[AT];
    const rt = cookies[RT];
    if (!token && rt) {
      const t = await refresh(rt, req);
      if (t) { setSession(out, t); token = t.accessToken; } else clearSession(out);
    }
    const body = MUTATING.has(req.method) ? await req.arrayBuffer() : undefined;
    const headers: Record<string, string> = forwarded(req);
    for (const h of ['content-type', 'idempotency-key']) {
      const v = req.headers.get(h);
      if (v) headers[h] = v;
    }
    const search = new URL(req.url).search;
    const send = (tok?: string) => api(`${apiPath}${search}`, { method: req.method, headers, body, token: tok });
    let res = await send(token);
    if (res.status === 401 && rt && token) {
      const t = await refresh(rt, req);
      if (t) { setSession(out, t); res = await send(t.accessToken); } else clearSession(out);
    }
    for (const h of HOP_HEADERS) {
      const v = res.headers.get(h);
      if (v) out.set(h, v);
    }
    return new Response(res.body, { status: res.status, headers: out });
  }

  async function handle(req: Request, segments: string[]): Promise<Response> {
    if (!csrfOk(req)) return error(403, 'CSRF_REJECTED', 'Request rejected');
    const [head, ...rest] = segments;
    if (head === 'session') return session(req, rest.join('/'));
    if (head === 'v1' && rest.length && !rest.includes('..')) {
      // Webhooks and token endpoints are not reachable through the browser proxy.
      if (rest[0] === 'webhooks' || (rest[0] === 'auth' && ['login', 'refresh', 'logout', 'register'].includes(rest[1] ?? ''))) return error(404, 'NOT_FOUND', 'Not found');
      return proxy(req, `/v1/${rest.map(encodeURIComponent).join('/')}`);
    }
    return error(404, 'NOT_FOUND', 'Not found');
  }

  /** Route handlers for app/bff/[...path]/route.ts */
  const route = async (req: Request, ctx: { params: Promise<{ path: string[] }> }) => handle(req, (await ctx.params).path);
  return { handle, GET: route, POST: route, PUT: route, PATCH: route, DELETE: route };
}

/** Server-side API access with the visitor's cookie (Server Components); null when not signed in. */
export function serverApi(apiUrl: string, cookiePrefix: string) {
  return async function get<T>(path: string, cookieHeader: string | null, lang: string): Promise<T | null> {
    const at = parseCookies(cookieHeader)[`${cookiePrefix}_at`];
    const r = await fetch(`${apiUrl}${path}`, { headers: { 'accept-language': lang, ...(at ? { authorization: `Bearer ${at}` } : {}) }, cache: 'no-store' });
    return r.ok ? ((await r.json()) as T) : null;
  };
}
