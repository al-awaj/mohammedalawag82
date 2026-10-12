import 'server-only';
import { cookies, headers } from 'next/headers';
import type { Lang } from '@events/shared';

/** Server-side reads of public catalog data (no session needed), in the visitor's language. */
const API = process.env.API_URL ?? 'http://localhost:3000';

export async function visitor(): Promise<{ lang: Lang; country: string | null }> {
  const c = await cookies();
  const lang: Lang = c.get('lang')?.value === 'en' ? 'en' : 'ar';
  const country = c.get('country')?.value ?? null;
  return { lang, country: country && /^[A-Z]{2}$/.test(country) ? country : null };
}

export async function publicGet<T>(path: string, lang: Lang): Promise<T | null> {
  const h = await headers();
  const r = await fetch(`${API}${path}`, {
    headers: { 'accept-language': lang, ...(h.get('x-forwarded-for') ? { 'x-forwarded-for': h.get('x-forwarded-for')! } : {}) },
    // Prices and availability change at any time: never serve them from a cache.
    cache: 'no-store',
  });
  return r.ok ? ((await r.json()) as T) : null;
}

export interface Country { id: string; code: string; name: Record<string, string>; baseCurrency: string; currencies: string[]; timezone: string; defaultLanguage: string; phonePrefix: string }

/** Active countries and the visitor's current one (cookie, else the first). */
export async function currentCountry(lang: Lang, code: string | null) {
  const list = (await publicGet<Country[]>('/v1/countries', lang)) ?? [];
  return { list, country: list.find((c) => c.code === code) ?? list[0] ?? null };
}
