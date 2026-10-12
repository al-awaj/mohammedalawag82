'use client';
import { useState } from 'react';
import { useCan, useGet, useTr } from '@events/web-kit/client';
import { ActionButton, DataTable, DateTime, ErrorBox, Filters, Loading, Page, Text } from '@events/web-kit/ui';

type Block = { id: string; serviceId: string; serviceTitle: Record<string, string>; kind: string; start: string; end: string; units: number; bookingRef: string | null; reason: string | null; providerName: string; countryCode: string; city: string; typeCode: string; expiresAt: string | null };

const KIND: Record<string, { ar: string; en: string }> = {
  hold: { ar: 'حجز مؤقت', en: 'Temporary hold' }, booking: { ar: 'حجز', en: 'Booking' }, external: { ar: 'حجز خارجي', en: 'External booking' }, closed: { ar: 'إغلاق', en: 'Closed' },
};
const iso = (d: Date) => d.toISOString().slice(0, 10);

export default function Calendar() {
  const tr = useTr();
  const can = useCan();
  const today = new Date();
  const [f, setF] = useState<Record<string, string>>({ from: iso(today), to: iso(new Date(today.getTime() + 30 * 86400000)) });
  const { data, error, isLoading } = useGet<Block[]>('/v1/admin/calendar', f);
  return (
    <Page title={tr({ ar: 'التقويم', en: 'Calendar' })}>
      <Filters value={f} onChange={(v) => setF({ ...f, ...v })} specs={[
        { name: 'from', label: tr({ ar: 'من', en: 'From' }), type: 'date' },
        { name: 'to', label: tr({ ar: 'إلى', en: 'To' }), type: 'date' },
        { name: 'countryCode', label: tr({ ar: 'رمز الدولة', en: 'Country code' }) },
        { name: 'city', label: tr({ ar: 'المدينة', en: 'City' }) },
        { name: 'kinds', label: tr({ ar: 'النوع', en: 'Kind' }), type: 'select', options: Object.entries(KIND).map(([value, label]) => ({ value, label })) },
      ]} />
      <ErrorBox error={error} />
      {isLoading ? <Loading /> : (
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
