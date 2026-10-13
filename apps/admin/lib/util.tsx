'use client';
import { ENUMS } from '@events/shared';
import { useGet } from '@events/web-kit/client';
import type { Option } from '@events/web-kit/ui';

/** Options for a select from one of the shared enumerations. */
export const opts = (group: string): Option[] => Object.entries(ENUMS[group] ?? {}).map(([value, label]) => ({ value, label }));
export const raw = (...values: string[]): Option[] => values.map((v) => ({ value: v, label: v }));
export const bi = (ar: string, en: string) => ({ ar, en });

export interface Country { id: string; code: string; name: { ar?: string; en?: string }; baseCurrency: string; currencies: string[]; timezone: string }

/** Active countries (public list) for selects and for showing codes instead of ids. */
export function useCountries() {
  const q = useGet<Country[]>('/v1/countries');
  const list = q.data ?? [];
  return {
    list,
    options: list.map((c) => ({ value: c.id, label: { ar: `${c.name.ar ?? c.code} (${c.code})`, en: `${c.name.en ?? c.code} (${c.code})` } })) as Option[],
    code: (id: string | null | undefined) => (id ? list.find((c) => c.id === id)?.code ?? id.slice(0, 8) : '—'),
  };
}

export function useCurrencies(): Option[] {
  const q = useGet<{ code: string }[]>('/v1/currencies');
  return (q.data ?? []).map((c) => ({ value: c.code, label: c.code }));
}

export const short = (id: string | null | undefined) => (id ? id.slice(0, 8) : '—');
