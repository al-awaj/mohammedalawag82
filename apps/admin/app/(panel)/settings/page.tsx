'use client';
import { useCan, useGet, useTr } from '@events/web-kit/client';
import { ActionButton, DataTable, DateTime, ErrorBox, Loading, Notice, Page, reasonField, Text } from '@events/web-kit/ui';
import { useCountries } from '@/lib/util';

type Setting = { key: string; description: Record<string, string>; default: unknown; scopes: string[]; values: { scope: string; countryId: string | null; value: unknown; updatedAt: string }[] };

export default function Settings() {
  const tr = useTr();
  const can = useCan();
  const countries = useCountries();
  const { data, error, isLoading } = useGet<Setting[]>('/v1/admin/settings');
  if (isLoading) return <Loading />;
  return (
    <Page title={tr({ ar: 'الإعدادات', en: 'Settings' })}>
      <Notice>{tr({ ar: 'تغيير الإعداد يسري على العمليات الجديدة فقط ولا يغير الحجوزات أو المستندات السابقة. كل تغيير مسجل بسببه.', en: 'Changes apply to new operations only and never alter past bookings or documents. Every change is recorded with its reason.' })}</Notice>
      <ErrorBox error={error} />
      <DataTable rowKey="key" rows={data ?? []} columns={[
        { key: 'key', label: { ar: 'الإعداد', en: 'Setting' }, render: (s) => <div><code>{s.key}</code><div className="small muted"><Text value={s.description} /></div></div> },
        { key: 'default', label: { ar: 'الافتراضي', en: 'Default' }, render: (s) => <code>{JSON.stringify(s.default)}</code> },
        { key: 'values', label: { ar: 'القيم المضبوطة', en: 'Overrides' }, render: (s) => s.values.length ? s.values.map((v, i) => (
          <div key={i} className="small"><code>{JSON.stringify(v.value)}</code> — {v.scope === 'global' ? tr({ ar: 'عام', en: 'global' }) : countries.code(v.countryId)} (<DateTime value={v.updatedAt} dateOnly />)</div>
        )) : '—' },
        { key: 'edit', label: '', render: (s) => can('settings.manage') ? (
          <ActionButton label={tr({ ar: 'تغيير', en: 'Change' })} fields={[
            { name: 'scope', label: { ar: 'النطاق', en: 'Scope' }, type: 'select', required: true, options: s.scopes.map((x) => ({ value: x, label: x === 'global' ? { ar: 'عام', en: 'Global' } : { ar: 'دولة', en: 'Country' } })) },
            { name: 'countryId', label: { ar: 'الدولة', en: 'Country' }, type: 'select', options: countries.options },
            { name: 'value', label: { ar: 'القيمة (JSON)', en: 'Value (JSON)' }, type: 'json', required: true, defaultValue: s.values.find((v) => v.scope === 'global')?.value ?? s.default },
            reasonField(),
          ]} run={(api, v) => api.put(`/v1/admin/settings/${s.key}`, v)} />
        ) : null },
      ]} />
    </Page>
  );
}
