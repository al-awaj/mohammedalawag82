'use client';
import { useTr } from '@events/web-kit/client';
import { Badge, DateTime, ListView, Money, Page, Text } from '@events/web-kit/ui';
import { opts } from '@/lib/util';

type Row = { id: string; number: string; status: string; serviceTitle: Record<string, string>; startAt: string; total: string; paidAmount: string; remainingAmount: string; currency: string; providerName: string; customerName: string };

export default function Bookings() {
  const tr = useTr();
  return (
    <Page title={tr({ ar: 'الحجوزات', en: 'Bookings' })}>
      <ListView<Row>
        path="/v1/admin/bookings"
        filters={[
          { name: 'status', label: tr({ ar: 'الحالة', en: 'Status' }), type: 'select', options: opts('booking') },
          { name: 'from', label: tr({ ar: 'من', en: 'From' }), type: 'date' },
          { name: 'to', label: tr({ ar: 'إلى', en: 'To' }), type: 'date' },
          { name: 'q', label: tr({ ar: 'رقم الحجز أو العميل', en: 'Booking no. or customer' }) },
        ]}
        rowHref={(r) => `/bookings/${r.id}`}
        columns={[
          { key: 'number', label: { ar: 'الرقم', en: 'Number' } },
          { key: 'serviceTitle', label: { ar: 'الخدمة', en: 'Service' }, render: (r) => <Text value={r.serviceTitle} /> },
          { key: 'providerName', label: { ar: 'صاحب الخدمة', en: 'Provider' } },
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
