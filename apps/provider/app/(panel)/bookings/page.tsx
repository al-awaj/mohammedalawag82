'use client';
import { useTr } from '@events/web-kit/client';
import { Badge, DateTime, ListView, Money, Page, Text } from '@events/web-kit/ui';
import { ENUMS } from '@events/shared';

type Row = { id: string; number: string; status: string; serviceTitle: Record<string, string>; startAt: string; total: string; paidAmount: string; remainingAmount: string; currency: string; customerName: string };

export default function Bookings() {
  const tr = useTr();
  return (
    <Page title={tr({ ar: 'الحجوزات', en: 'Bookings' })}>
      <ListView<Row>
        path="/v1/provider/bookings"
        initialFilters={{ when: 'upcoming' }}
        filters={[
          { name: 'when', label: tr({ ar: 'الفترة', en: 'Period' }), type: 'select', options: [
            { value: 'upcoming', label: { ar: 'القادمة', en: 'Upcoming' } }, { value: 'past', label: { ar: 'السابقة', en: 'Past' } }, { value: 'all', label: { ar: 'الكل', en: 'All' } }] },
          { name: 'status', label: tr({ ar: 'الحالة', en: 'Status' }), type: 'select', options: Object.entries(ENUMS.booking!).map(([value, label]) => ({ value, label })) },
        ]}
        rowHref={(r) => `/bookings/${r.id}`}
        columns={[
          { key: 'number', label: { ar: 'الرقم', en: 'Number' } },
          { key: 'serviceTitle', label: { ar: 'الخدمة', en: 'Service' }, render: (r) => <Text value={r.serviceTitle} /> },
          { key: 'customerName', label: { ar: 'العميل', en: 'Customer' } },
          { key: 'startAt', label: { ar: 'الموعد', en: 'Date' }, render: (r) => <DateTime value={r.startAt} /> },
          { key: 'total', label: { ar: 'الإجمالي', en: 'Total' }, render: (r) => <Money amount={r.total} currency={r.currency} /> },
          { key: 'paidAmount', label: { ar: 'المدفوع', en: 'Paid' }, render: (r) => <Money amount={r.paidAmount} currency={r.currency} /> },
          { key: 'status', label: { ar: 'الحالة', en: 'Status' }, render: (r) => <Badge group="booking" value={r.status} /> },
        ]}
      />
    </Page>
  );
}
