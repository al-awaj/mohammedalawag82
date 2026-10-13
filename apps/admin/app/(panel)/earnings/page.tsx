'use client';
import { useTr } from '@events/web-kit/client';
import { ActionButton, Badge, ListView, Money, Page } from '@events/web-kit/ui';
import { opts } from '@/lib/util';

type Row = { id: string; bookingNumber: string; providerName: string; currency: string; bookingTotal: string; collectedByPlatform: string; collectedDirectly: string; commission: string; net: string; status: string; statusReason: string | null };

export default function Earnings() {
  const tr = useTr();
  return (
    <Page title={tr({ ar: 'مستحقات أصحاب الخدمات', en: 'Provider earnings' })}>
      <ListView<Row>
        path="/v1/admin/earnings"
        filters={[{ name: 'status', label: tr({ ar: 'الحالة', en: 'Status' }), type: 'select', options: opts('earning') }]}
        columns={[
          { key: 'bookingNumber', label: { ar: 'الحجز', en: 'Booking' } },
          { key: 'providerName', label: { ar: 'صاحب الخدمة', en: 'Provider' } },
          { key: 'bookingTotal', label: { ar: 'قيمة الحجز', en: 'Booking total' }, render: (r) => <Money amount={r.bookingTotal} currency={r.currency} /> },
          { key: 'collectedByPlatform', label: { ar: 'محصل عبر المنصة', en: 'Via platform' }, render: (r) => <Money amount={r.collectedByPlatform} currency={r.currency} /> },
          { key: 'collectedDirectly', label: { ar: 'محصل مباشرة', en: 'Direct' }, render: (r) => <Money amount={r.collectedDirectly} currency={r.currency} /> },
          { key: 'commission', label: { ar: 'العمولة', en: 'Commission' }, render: (r) => <Money amount={r.commission} currency={r.currency} /> },
          { key: 'net', label: { ar: 'الصافي', en: 'Net' }, render: (r) => <Money amount={r.net} currency={r.currency} /> },
          { key: 'status', label: { ar: 'الحالة', en: 'Status' }, render: (r) => <Badge group="earning" value={r.status} /> },
          { key: 'actions', label: '', render: (r) => r.status === 'under_review' ? (
            <ActionButton label={tr({ ar: 'اعتماد المراجعة', en: 'Approve review' })} fields={[{ name: 'note', label: { ar: 'ملاحظة', en: 'Note' }, type: 'textarea' }]}
              run={(api, v) => api.post(`/v1/admin/earnings/${r.id}/approve-review`, v)} />
          ) : r.statusReason },
        ]}
      />
    </Page>
  );
}
