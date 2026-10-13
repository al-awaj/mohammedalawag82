'use client';
import { useState } from 'react';
import { localized } from '@events/shared';
import { useApp, useGet, useTr } from '@events/web-kit/client';
import { ActionButton, DataTable, DateTime, ErrorBox, Filters, Loading, Notice, Page, Text } from '@events/web-kit/ui';

type Block = { id: string; serviceId: string; serviceTitle: Record<string, string>; kind: string; start: string; end: string; units: number; bookingRef: string | null; reason: string | null; internalNotes: string | null; expiresAt: string | null };
const KIND: Record<string, { ar: string; en: string }> = {
  hold: { ar: 'حجز مؤقت (بانتظار الدفع)', en: 'Temporary hold (awaiting payment)' }, booking: { ar: 'حجز مؤكد', en: 'Confirmed booking' },
  external: { ar: 'حجز خارج المنصة', en: 'Booked outside the platform' }, closed: { ar: 'إغلاق', en: 'Closed' },
};
const iso = (d: Date) => d.toISOString().slice(0, 10);

export default function Calendar() {
  const tr = useTr();
  const { lang } = useApp();
  const services = (useGet<{ id: string; title: Record<string, string> }[]>('/v1/provider/services').data ?? []).map((s) => ({ value: s.id, label: localized(s.title, lang) }));
  const now = new Date();
  const [f, setF] = useState<Record<string, string>>({ from: iso(now), to: iso(new Date(now.getTime() + 60 * 86400000)) });
  const { data, error, isLoading } = useGet<Block[]>('/v1/provider/calendar', f);
  return (
    <Page title={tr({ ar: 'التقويم', en: 'Calendar' })} actions={
      <ActionButton variant="primary" label={tr({ ar: 'حجز خارجي أو إغلاق', en: 'External booking or closure' })}
        note={tr({ ar: 'سجّل هنا الحجوزات التي تمت خارج المنصة حتى لا يُحجز نفس الموعد مرتين.', en: 'Record bookings made outside the platform here so the same slot is never booked twice.' })}
        fields={[
          { name: 'serviceId', label: { ar: 'الخدمة', en: 'Service' }, type: 'select', required: true, options: services },
          { name: 'kind', label: { ar: 'النوع', en: 'Kind' }, type: 'select', required: true, options: [{ value: 'external', label: KIND.external! }, { value: 'closed', label: KIND.closed! }] },
          { name: 'start', label: { ar: 'من', en: 'From' }, type: 'datetime', required: true },
          { name: 'end', label: { ar: 'إلى', en: 'To' }, type: 'datetime', required: true },
          { name: 'reason', label: { ar: 'السبب', en: 'Reason' }, required: true },
          { name: 'internalNotes', label: { ar: 'ملاحظات داخلية', en: 'Internal notes' }, type: 'textarea' },
        ]}
        run={(api, { serviceId, ...v }) => api.post(`/v1/provider/services/${serviceId}/blocks`, v)} />
    }>
      <Filters value={f} onChange={(v) => setF({ ...f, ...v })} specs={[
        { name: 'from', label: tr({ ar: 'من', en: 'From' }), type: 'date' }, { name: 'to', label: tr({ ar: 'إلى', en: 'To' }), type: 'date' },
        { name: 'serviceId', label: tr({ ar: 'الخدمة', en: 'Service' }), type: 'select', options: services },
      ]} />
      <Notice>{tr({ ar: 'المواعيد المحجوزة مؤقتًا تُفتح تلقائيًا إذا لم يكتمل الدفع في الوقت المحدد.', en: 'Temporarily held slots reopen automatically if payment is not completed in time.' })}</Notice>
      <ErrorBox error={error} />
      {isLoading ? <Loading /> : (
        <DataTable rows={data ?? []} columns={[
          { key: 'start', label: { ar: 'من', en: 'From' }, render: (b) => <DateTime value={b.start} /> },
          { key: 'end', label: { ar: 'إلى', en: 'To' }, render: (b) => <DateTime value={b.end} /> },
          { key: 'kind', label: { ar: 'النوع', en: 'Kind' }, render: (b) => tr(KIND[b.kind] ?? { ar: b.kind, en: b.kind }) },
          { key: 'serviceTitle', label: { ar: 'الخدمة', en: 'Service' }, render: (b) => <Text value={b.serviceTitle} /> },
          { key: 'reason', label: { ar: 'السبب', en: 'Reason' } },
          { key: 'remove', label: '', render: (b) => (b.kind === 'external' || b.kind === 'closed') ? (
            <ActionButton variant="danger" label={tr({ ar: 'إزالة', en: 'Remove' })} fields={[{ name: 'reason', label: { ar: 'السبب', en: 'Reason' }, type: 'textarea', required: true }]}
              run={(api, v) => api.del(`/v1/provider/blocks/${b.id}`, v)} />
          ) : null },
        ]} />
      )}
    </Page>
  );
}
