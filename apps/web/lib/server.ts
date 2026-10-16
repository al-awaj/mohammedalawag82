import { apiBase } from '@events/web-kit/bff';
import 'server-only';
import { cookies, headers } from 'next/headers';
import type { Lang } from '@events/shared';

/** Server-side reads of public catalog data (no session needed), in the visitor's language. */
const API = apiBase(process.env.API_URL ?? 'http://localhost:3000');

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

/** The currency the visitor chose to see approximate prices in (cookie), or null for the service's own currency. */
export async function displayCurrency(): Promise<string | null> {
  const v = (await cookies()).get('dcur')?.value ?? null;
  return v && /^[A-Z]{3}$/.test(v) ? v : null;
}

/**
 * Latest exchange rates from each listed currency to the display currency (clause 11). Used only to show "≈" amounts;
 * bookings and payments stay in the service currency. A pair without a published rate is simply not converted.
 */
export async function displayRates(currencies: string[], lang: Lang): Promise<{ code: string; rates: Record<string, string> } | null> {
  const code = await displayCurrency();
  if (!code) return null;
  const rates: Record<string, string> = {};
  await Promise.all([...new Set(currencies)].filter((c) => c && c !== code).map(async (c) => {
    const r = await publicGet<{ rate: string }>(`/v1/exchange-rates/latest?base=${c}&quote=${code}`, lang);
    if (r?.rate) rates[c] = r.rate;
  }));
  return { code, rates };
}
