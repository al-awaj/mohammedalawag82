'use client';
import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { ApiError, createClient, type ApiClient, type Lang, type Query } from '@events/shared';
import { COMMON, type CommonKey } from './strings';

interface Ctx { lang: Lang; api: ApiClient; setLang: (l: Lang) => void }
const AppCtx = createContext<Ctx | null>(null);

/** Root providers for a web interface. `lang` comes from the `lang` cookie read on the server. */
export function AppProviders({ lang: initial, children }: { lang: Lang; children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initial);
  const [qc] = useState(() => new QueryClient({
    defaultOptions: {
      queries: { retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 2, refetchOnWindowFocus: false, staleTime: 10_000 },
    },
  }));
  const api = useMemo(() => createClient({ baseUrl: '/bff', lang: () => lang, headers: () => ({ 'x-csrf': '1' }) }), [lang]);
  const setLang = (l: Lang) => {
    document.cookie = `lang=${l}; Path=/; Max-Age=31536000; SameSite=Lax`;
    setLangState(l);
    document.documentElement.lang = l;
    document.documentElement.dir = l === 'ar' ? 'rtl' : 'ltr';
    qc.invalidateQueries();
  };
  return (
    <AppCtx.Provider value={{ lang, api, setLang }}>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </AppCtx.Provider>
  );
}

export function useApp(): Ctx {
  const c = useContext(AppCtx);
  if (!c) throw new Error('AppProviders missing');
  return c;
}

export function useT() {
  const { lang } = useApp();
  return (key: CommonKey | (string & {}), vars?: Record<string, string | number>) => {
    let s = (COMMON as Record<string, { ar: string; en: string }>)[key]?.[lang] ?? key;
    if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
    return s;
  };
}

/** Bilingual inline text: tr({ ar: '...', en: '...' }). */
export function useTr() {
  const { lang } = useApp();
  return (s: { ar: string; en: string }) => s[lang];
}

export interface SessionUser {
  id: string; kind: 'staff' | 'provider' | 'customer'; fullName: string; email: string | null; phone: string | null;
  countryCode: string | null; preferredLanguage: string; phoneVerifiedAt: string | null; emailVerifiedAt: string | null;
  roles: { code: string; countryCode: string | null }[]; permissions: string[];
}

export function useSession() {
  const { api } = useApp();
  return useQuery({
    queryKey: ['session'],
    queryFn: async () => {
      try { return await api.get<SessionUser>('/session'); } catch (e) { if (e instanceof ApiError && e.status === 401) return null; throw e; }
    },
    staleTime: 60_000,
  });
}

export function useCan() {
  const { data } = useSession();
  return (perm: string) => !!data?.permissions.includes(perm);
}

/** GET through the proxy: useGet('/v1/admin/bookings', { status }). */
export function useGet<T = unknown>(path: string | null, query?: Query, opts: { refetchInterval?: number } = {}) {
  const { api } = useApp();
  return useQuery({
    queryKey: [path, query] as QueryKey,
    queryFn: () => api.get<T>(path!, query),
    enabled: !!path,
    ...opts,
  });
}

/** Mutation that refreshes every cached query afterwards (data on screen always reflects the server). */
export function useAction<V = unknown, R = unknown>(fn: (api: ApiClient, vars: V) => Promise<R>) {
  const { api } = useApp();
  const qc = useQueryClient();
  return useMutation({ mutationFn: (v: V) => fn(api, v), onSuccess: () => qc.invalidateQueries() });
}

export { ApiError };
