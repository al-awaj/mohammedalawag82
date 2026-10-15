'use client';
import { useState } from 'react';
import { localized } from '@events/shared';
import { useApp, useCan, useGet, useTr } from '@events/web-kit/client';
import {
  ActionButton, CalendarView, DataTable, DateTime, ErrorBox, Filters, Loading, Page, Tabs, Text, addDays, isoDay, viewRange,
  type CalendarBlock, type CalendarMode,
} from '@events/web-kit/ui';
import { useCountries } from '@/lib/util';

type Block = CalendarBlock & { serviceId: string; providerId: string; countryCode: string; city: string; typeCode: string; expiresAt: string | null };

const KIND: Record<string, { ar: string; en: string }> = {
  hold: { ar: 'حجز مؤقت', en: 'Temporary hold' }, booking: { ar: 'حجز', en: 'Booking' }, external: { ar: 'حجز خارجي', en: 'External booking' }, closed: { ar: 'إغلاق', en: 'Closed' },
};

/** Central calendar (clause 26): month, week and day views with buffers, and a list; filters by country, city, type, provider and kind. */
export default function Calendar() {
  const tr = useTr();
  const can = useCan();
  const { lang } = useApp();
  const countries = useCountries();
  const today = isoDay(new Date());
  const [mode, setMode] = useState<CalendarMode>('month');
  const [anchor, setAnchor] = useState(today);
  const [view, setView] = useState<'calendar' | 'list'>('calendar');
  const [f, setF] = useState<Record<string, string>>({});
  const types = (useGet<{ id: string; name: Record<string, string> }[]>(can('service_types.manage') ? '/v1/admin/service-types' : null).data ?? [])
    .map((t) => ({ value: t.id, label: localized(t.name, lang) }));
  const providers = (useGet<{ items: { id: string; businessName: string }[] }>(can('providers.view') ? '/v1/admin/providers' : null, { limit: 200 }).data?.items ?? [])
    .map((p) => ({ value: p.id, label: p.businessName }));
  const range = view === 'calendar' ? viewRange(mode, anchor) : { from: anchor, to: addDays(anchor, 30) };
  const { data, error, isLoading } = useGet<Block[]>('/v1/admin/calendar', { ...f, ...range });
  return (
    <Page title={tr({ ar: 'التقويم', en: 'Calendar' })}>
      <Filters value={f} onChange={(v) => setF({ ...f, ...v })} specs={[
        { name: 'countryCode', label: tr({ ar: 'الدولة', en: 'Country' }), type: 'select', options: countries.list.map((c) => ({ value: c.code, label: localized(c.name as Record<string, string>, lang) })) },
        { name: 'city', label: tr({ ar: 'المدينة', en: 'City' }) },
        { name: 'typeId', label: tr({ ar: 'نوع الخدمة', en: 'Service type' }), type: 'select', options: types },
        { name: 'providerId', label: tr({ ar: 'صاحب الخدمة', en: 'Provider' }), type: 'select', options: providers },
        { name: 'kinds', label: tr({ ar: 'النوع', en: 'Kind' }), type: 'select', options: Object.entries(KIND).map(([value, label]) => ({ value, label })) },
      ]} />
      <Tabs value={view} onChange={setView} tabs={[{ id: 'calendar', label: tr({ ar: 'عرض التقويم', en: 'Calendar' }) }, { id: 'list', label: tr({ ar: 'قائمة (30 يومًا)', en: 'List (30 days)' }) }]} />
      <ErrorBox error={error} />
      {isLoading ? <Loading /> : view === 'calendar' ? (
        <CalendarView mode={mode} anchor={anchor} today={today} blocks={data ?? []} onMode={setMode} onAnchor={setAnchor}
          kindLabel={(k) => tr(KIND[k] ?? { ar: k, en: k })} blockHref={(b) => (b.kind === 'booking' || b.kind === 'hold') && b.bookingRef ? `/bookings/${b.bookingRef}` : null} />
      ) : (
        <DataTable rows={data ?? []} columns={[
          { key: 'start', label: { ar: 'من', en: 'From' }, render: (b) => <DateTime value={b.start} /> },
          { key: 'end', label: { ar: 'إلى', en: 'To' }, render: (b) => <DateTime value={b.end} /> },
          { key: 'kind', label: { ar: 'النوع', en: 'Kind' }, render: (b) => tr(KIND[b.kind] ?? { ar: b.kind, en: b.kind }) },
          { key: 'serviceTitle', label: { ar: 'الخدمة', en: 'Service' }, render: (b) => <Text value={b.serviceTitle} /> },
          { key: 'providerName', label: { ar: 'صاحب الخدمة', en: 'Provider' } },
          { key: 'city', label: { ar: 'المدينة', en: 'City' }, render: (b) => `${b.countryCode} · ${b.city}` },
          { key: 'reason', label: { ar: 'السبب', en: 'Reason' } },
          { key: 'actions', label: '', render: (b) => can('bookings.manage') && (b.kind === 'external' || b.kind === 'closed') ? (
            <ActionButton variant="danger" label={tr({ ar: 'إزالة', en: 'Remove' })} fields={[{ name: 'reason', label: { ar: 'السبب', en: 'Reason' }, type: 'textarea', required: true }]}
              run={(api, v) => api.del(`/v1/admin/blocks/${b.id}`, v)} />
          ) : null },
        ]} />
      )}
    </Page>
  );
}
