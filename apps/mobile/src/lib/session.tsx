import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { I18nManager, Platform } from 'react-native';
import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { ApiError, type Lang, type Query } from '@events/shared';
import { api, clearTokens, hasSession, login, logout, register, setApiLang } from './api';
import { prefs } from './storage';

export interface User { id: string; kind: string; fullName: string; phone: string | null; email: string | null; countryCode: string | null; preferredLanguage: string; phoneVerifiedAt: string | null }

interface Ctx {
  lang: Lang; setLang: (l: Lang) => void; country: string | null; setCountry: (c: string) => void;
  user: User | null | undefined; signIn: (identifier: string, password: string) => Promise<void>;
  signUp: (body: Record<string, unknown>) => Promise<void>; signOut: () => Promise<void>; reloadUser: () => Promise<void>;
}
const SessionCtx = createContext<Ctx | null>(null);
const qc = new QueryClient({ defaultOptions: { queries: { retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 2, staleTime: 10_000 } } });

/** Arabic is right-to-left. On devices the layout direction applies after the app restarts. */
function applyDirection(l: Lang) {
  const rtl = l === 'ar';
  if (Platform.OS === 'web') {
    if (typeof document !== 'undefined') { document.documentElement.dir = rtl ? 'rtl' : 'ltr'; document.documentElement.lang = l; }
  } else if (I18nManager.isRTL !== rtl) {
    I18nManager.allowRTL(rtl);
    I18nManager.forceRTL(rtl);
  }
}

export function SessionProvider({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={qc}><Inner>{children}</Inner></QueryClientProvider>;
}

function Inner({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>('ar');
  const [country, setCountryState] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const client = useQueryClient();
  useEffect(() => {
    (async () => {
      const l = ((await prefs.get('lang')) === 'en' ? 'en' : 'ar') as Lang;
      setLangState(l); setApiLang(l); applyDirection(l);
      setCountryState(await prefs.get('country'));
      setReady(true);
    })();
  }, []);
  const me = useQuery({
    queryKey: ['me'],
    enabled: ready,
    queryFn: async () => {
      if (!(await hasSession())) return null;
      try {
        const u = await api.get<User>('/v1/me');
        if (u.kind !== 'customer') { await clearTokens(); return null; }
        return u;
      } catch (e) { if (e instanceof ApiError && e.status === 401) return null; throw e; }
    },
  });
  const value: Ctx = {
    lang,
    setLang: (l) => { setLangState(l); setApiLang(l); void prefs.set('lang', l); applyDirection(l); void client.invalidateQueries(); },
    country: country ?? me.data?.countryCode ?? null,
    setCountry: (c) => { setCountryState(c); void prefs.set('country', c); },
    user: ready ? me.data : undefined,
    signIn: async (i, p) => { await login(i, p); await client.invalidateQueries(); },
    signUp: async (b) => { await register(b); await client.invalidateQueries(); },
    signOut: async () => { await logout(); client.clear(); },
    reloadUser: async () => { await client.invalidateQueries({ queryKey: ['me'] }); },
  };
  if (!ready) return null;
  return <SessionCtx.Provider value={value}>{children}</SessionCtx.Provider>;
}

export function useSession(): Ctx {
  const c = useContext(SessionCtx);
  if (!c) throw new Error('SessionProvider missing');
  return c;
}

export function useGet<T>(path: string | null, query?: Query, opts: { refetchInterval?: number } = {}) {
  return useQuery({ queryKey: [path, query] as QueryKey, queryFn: () => api.get<T>(path!, query), enabled: !!path, ...opts });
}

export function useAction<V, R = unknown>(fn: (vars: V) => Promise<R>) {
  const client = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: () => client.invalidateQueries() });
}
