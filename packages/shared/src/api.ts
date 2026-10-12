/**
 * Minimal API client shared by the web interfaces (through their server-side proxy) and the mobile app
 * (directly, with tokens in secure storage). The API remains the only place where rules are enforced.
 */
export interface ApiErrorBody { code: string; message: string; details?: unknown }

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

export type Query = Record<string, string | number | boolean | null | undefined | string[]>;

export interface ClientOptions {
  baseUrl: string;
  lang: () => string;
  /** Extra headers per request (e.g. Authorization on mobile, the CSRF marker on web). */
  headers?: () => Record<string, string> | Promise<Record<string, string>>;
  /** Called once on 401; return true if the session was refreshed and the request should be retried. */
  onUnauthorized?: () => Promise<boolean>;
  fetch?: typeof fetch;
}

export function toQueryString(q?: Query): string {
  if (!q) return '';
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) v.forEach((x) => sp.append(k, x));
    else sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

export function createClient(opts: ClientOptions) {
  const f = opts.fetch ?? fetch;
  async function raw(method: string, path: string, init: { query?: Query; body?: unknown; form?: FormData; headers?: Record<string, string> } = {}, retried = false): Promise<Response> {
    const headers: Record<string, string> = { 'accept-language': opts.lang(), ...(await opts.headers?.()), ...init.headers };
    let body: BodyInit | undefined;
    if (init.form) body = init.form;
    else if (init.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(init.body);
    }
    const res = await f(`${opts.baseUrl}${path}${toQueryString(init.query)}`, { method, headers, body, credentials: 'same-origin' });
    if (res.status === 401 && !retried && opts.onUnauthorized && (await opts.onUnauthorized())) return raw(method, path, init, true);
    return res;
  }
  async function request<T = unknown>(method: string, path: string, init: { query?: Query; body?: unknown; form?: FormData; headers?: Record<string, string> } = {}): Promise<T> {
    const res = await raw(method, path, init);
    const text = await res.text();
    let data: unknown = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) {
      const e = (data as { error?: ApiErrorBody } | null)?.error;
      throw new ApiError(res.status, e?.code ?? `HTTP_${res.status}`, e?.message ?? res.statusText, e?.details);
    }
    return data as T;
  }
  return {
    raw,
    request,
    get: <T = unknown>(path: string, query?: Query) => request<T>('GET', path, { query }),
    post: <T = unknown>(path: string, body?: unknown, headers?: Record<string, string>) => request<T>('POST', path, { body: body ?? {}, headers }),
    put: <T = unknown>(path: string, body?: unknown) => request<T>('PUT', path, { body: body ?? {} }),
    patch: <T = unknown>(path: string, body?: unknown) => request<T>('PATCH', path, { body: body ?? {} }),
    del: <T = unknown>(path: string, body?: unknown) => request<T>('DELETE', path, { body }),
    upload: <T = unknown>(path: string, form: FormData) => request<T>('POST', path, { form }),
  };
}
export type ApiClient = ReturnType<typeof createClient>;
