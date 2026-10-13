'use client';
import { enumLabel } from '@events/shared';
import { useApp, useTr } from '@events/web-kit/client';
import { Badge, DateTime, ListView, Money, Page } from '@events/web-kit/ui';
import { opts } from '@/lib/util';

type Row = { id: string; name: string; eventType: string; countryCode: string; city: string; eventDate: string; status: string; budgetAmount: string | null; budgetCurrency: string | null; customerName: string; bookingCount: number };

export default function Events() {
  const tr = useTr();
  const { lang } = useApp();
  return (
    <Page title={tr({ ar: 'المناسبات', en: 'Events' })}>
      <ListView<Row>
        path="/v1/admin/events"
        filters={[
          { name: 'status', label: tr({ ar: 'الحالة', en: 'Status' }), type: 'select', options: opts('event') },
          { name: 'from', label: tr({ ar: 'من', en: 'From' }), type: 'date' },
          { name: 'to', label: tr({ ar: 'إلى', en: 'To' }), type: 'date' },
          { name: 'q', label: tr({ ar: 'اسم المناسبة أو العميل', en: 'Event or customer name' }) },
        ]}
        rowHref={(r) => `/events/${r.id}`}
        columns={[
          { key: 'name', label: { ar: 'المناسبة', en: 'Event' } },
          { key: 'eventType', label: { ar: 'النوع', en: 'Type' }, render: (r) => enumLabel('eventType', r.eventType, lang) },
          { key: 'customerName', label: { ar: 'العميل', en: 'Customer' } },
          { key: 'eventDate', label: { ar: 'التاريخ', en: 'Date' }, render: (r) => <DateTime value={r.eventDate} dateOnly /> },
          { key: 'city', label: { ar: 'المدينة', en: 'City' }, render: (r) => `${r.city} (${r.countryCode})` },
          { key: 'bookingCount', label: { ar: 'الحجوزات', en: 'Bookings' } },
          { key: 'budgetAmount', label: { ar: 'الميزانية', en: 'Budget' }, render: (r) => (r.budgetAmount ? <Money amount={r.budgetAmount} currency={r.budgetCurrency} /> : '—') },
          { key: 'status', label: { ar: 'الحالة', en: 'Status' }, render: (r) => <Badge group="event" value={r.status} /> },
        ]}
      />
    </Page>
  );
}
