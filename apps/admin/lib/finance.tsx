'use client';
import { useGet } from '@events/web-kit/client';
import type { Option } from '@events/web-kit/ui';
import { localized, type Lang } from '@events/shared';

export type Account = { id: string; countryId: string; currency: string; code: string; kind: string; type: string; name: Record<string, string>; isSystem: boolean; isActive: boolean; details: Record<string, unknown>; balance: string };

export function useFunds(lang: Lang): Option[] {
  const accounts = useGet<Account[]>('/v1/admin/accounts').data ?? [];
  return accounts.filter((a) => ['cash', 'bank', 'wallet', 'gateway'].includes(a.kind) && a.isActive)
    .map((a) => ({ value: a.id, label: `${a.code} · ${localized(a.name, lang)} · ${a.currency}` }));
}

export function useProviders(): Option[] {
  const d = useGet<{ items: { id: string; businessName: string; countryCode: string }[] }>('/v1/admin/providers', { limit: 200, status: 'active' }).data;
  return (d?.items ?? []).map((p) => ({ value: p.id, label: `${p.businessName} (${p.countryCode})` }));
}
