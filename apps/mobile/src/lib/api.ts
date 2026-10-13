import { createClient, type ApiClient } from '@events/shared';
import { storage } from './storage';

/** The API address is fixed at build time (EXPO_PUBLIC_API_URL). */
export const API_URL = (process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000').replace(/\/$/, '');

interface Tokens { accessToken: string; refreshToken: string; expiresIn: number }
const AT = 'events.at';
const RT = 'events.rt';

export async function saveTokens(t: Tokens) {
  await storage.set(AT, t.accessToken);
  await storage.set(RT, t.refreshToken);
}
export async function clearTokens() {
  await storage.del(AT);
  await storage.del(RT);
}
export const hasSession = async () => !!(await storage.get(RT));

/**
 * Refresh tokens rotate and a reused one revokes the session, so concurrent requests share one
 * refresh call.
 */
let refreshing: Promise<boolean> | null = null;
async function refresh(): Promise<boolean> {
  refreshing ??= (async () => {
    try {
      const rt = await storage.get(RT);
      if (!rt) return false;
      const r = await fetch(`${API_URL}/v1/auth/refresh`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken: rt }) });
      if (!r.ok) { await clearTokens(); return false; }
      await saveTokens((await r.json()) as Tokens);
      return true;
    } finally {
      setTimeout(() => { refreshing = null; }, 0);
    }
  })();
  return refreshing;
}

let currentLang = 'ar';
export const setApiLang = (l: string) => { currentLang = l; };

export const api: ApiClient = createClient({
  baseUrl: API_URL,
  lang: () => currentLang,
  headers: async (): Promise<Record<string, string>> => {
    const at = await storage.get(AT);
    return at ? { authorization: `Bearer ${at}` } : {};
  },
  onUnauthorized: refresh,
});

export async function login(identifier: string, password: string) {
  await saveTokens(await api.post<Tokens>('/v1/auth/login', { identifier, password }));
}
export async function register(body: Record<string, unknown>) {
  await saveTokens(await api.post<Tokens>('/v1/auth/register', { ...body, accountType: 'customer' }));
}
export async function logout() {
  const rt = await storage.get(RT);
  try { if (rt) await api.post('/v1/auth/logout', { refreshToken: rt }); } catch { /* the session is cleared locally anyway */ }
  await clearTokens();
}

/** Multipart upload of a picked file (native: uri descriptor; web: the File object). */
export function fileForm(asset: { uri: string; name: string; mimeType?: string; file?: File }, fields: Record<string, string> = {}) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  if (asset.file) f.append('file', asset.file, asset.name);
  else f.append('file', { uri: asset.uri, name: asset.name, type: asset.mimeType ?? 'application/octet-stream' } as unknown as Blob);
  return f;
}
