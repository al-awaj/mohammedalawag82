'use client';
import { localized } from '@events/shared';
import { useApp, useTr } from '@events/web-kit/client';
import { Badge, DateTime, ListView, Money, Page } from '@events/web-kit/ui';

type Row = { id: string; number: string; status: string; serviceTitle: Record<string, string>; startAt: string; total: string; paidAmount: string; remainingAmount: string; currency: string; providerName: string | null };

export default function MyBookings() {
  const tr = useTr();
  const { lang } = useApp();
  return (
    <Page title={tr({ ar: 'حجوزاتي', en: 'My bookings' })}>
      <ListView<Row> path="/v1/bookings" initialFilters={{ when: 'upcoming' }}
        filters={[{ name: 'when', label: tr({ ar: 'الفترة', en: 'Period' }), type: 'select', options: [
          { value: 'upcoming', label: { ar: 'القادمة', en: 'Upcoming' } }, { value: 'past', label: { ar: 'السابقة', en: 'Past' } }, { value: 'all', label: { ar: 'الكل', en: 'All' } }] }]}
        rowHref={(b) => `/account/bookings/${b.id}`}
        columns={[
          { key: 'number', label: { ar: 'الرقم', en: 'Number' } },
          { key: 'serviceTitle', label: { ar: 'الخدمة', en: 'Service' }, render: (b) => localized(b.serviceTitle, lang) },
          { key: 'startAt', label: { ar: 'الموعد', en: 'Date' }, render: (b) => <DateTime value={b.startAt} /> },
          { key: 'total', label: { ar: 'الإجمالي', en: 'Total' }, render: (b) => <Money amount={b.total} currency={b.currency} /> },
          { key: 'remainingAmount', label: { ar: 'المتبقي', en: 'Remaining' }, render: (b) => <Money amount={b.remainingAmount} currency={b.currency} /> },
          { key: 'status', label: { ar: 'الحالة', en: 'Status' }, render: (b) => <Badge group="booking" value={b.status} /> },
        ]} />
    </Page>
  );
}
