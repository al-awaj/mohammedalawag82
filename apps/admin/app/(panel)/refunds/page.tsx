'use client';
import { useTr } from '@events/web-kit/client';
import { Badge, DateTime, ListView, Money, Page } from '@events/web-kit/ui';
import { opts } from '@/lib/util';

type Row = { id: string; number: string; bookingNumber: string; amount: string; currency: string; source: string; method: string; status: string; requestedByKind: string; createdAt: string };

export default function Refunds() {
  const tr = useTr();
  return (
    <Page title={tr({ ar: 'الاستردادات', en: 'Refunds' })}>
      <ListView<Row>
        path="/v1/admin/refunds"
        filters={[{ name: 'status', label: tr({ ar: 'الحالة', en: 'Status' }), type: 'select', options: opts('refund') }]}
        rowHref={(r) => `/refunds/${r.id}`}
        columns={[
          { key: 'number', label: { ar: 'الرقم', en: 'Number' } },
          { key: 'bookingNumber', label: { ar: 'الحجز', en: 'Booking' } },
          { key: 'amount', label: { ar: 'المبلغ', en: 'Amount' }, render: (r) => <Money amount={r.amount} currency={r.currency} /> },
          { key: 'source', label: { ar: 'المصدر', en: 'Source' } },
          { key: 'method', label: { ar: 'الطريقة', en: 'Method' }, render: (r) => <Badge group="paymentMethod" value={r.method} /> },
          { key: 'status', label: { ar: 'الحالة', en: 'Status' }, render: (r) => <Badge group="refund" value={r.status} /> },
          { key: 'createdAt', label: { ar: 'التاريخ', en: 'Date' }, render: (r) => <DateTime value={r.createdAt} /> },
        ]}
      />
    </Page>
  );
}
