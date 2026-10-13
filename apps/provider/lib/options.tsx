'use client';
import { localized } from '@events/shared';
import { useApp, useGet, useSession } from '@events/web-kit/client';
import type { Option } from '@events/web-kit/ui';

/** Currencies allowed in the provider's country (base currency first). */
export function useCurrencyOptions(): Option[] {
  const session = useSession().data;
  const countries = useGet<{ code: string; baseCurrency: string; currencies: string[] }[]>('/v1/countries').data ?? [];
  const c = countries.find((x) => x.code === session?.countryCode);
  const list = c ? [...new Set([c.baseCurrency, ...c.currencies])] : [];
  return list.map((x) => ({ value: x.trim(), label: x.trim() }));
}

export function usePolicyOptions(): Option[] {
  const { lang } = useApp();
  const list = useGet<{ id: string; name: Record<string, string>; isActive: boolean }[]>('/v1/provider/cancellation-policies').data ?? [];
  return list.filter((p) => p.isActive).map((p) => ({ value: p.id, label: localized(p.name, lang) }));
}
