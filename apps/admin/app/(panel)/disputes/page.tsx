'use client';
import { useTr } from '@events/web-kit/client';
import { Badge, DateTime, ListView, Money, Page } from '@events/web-kit/ui';
import { opts } from '@/lib/util';

type Row = { id: string; number: string; kind: string; bookingNumber: string | null; type: string; subject: string; complainantRole: string; disputedAmount: string | null; currency: string | null; heldAmount: string; status: string; createdAt: string };

export default function Disputes() {
  const tr = useTr();
  return (
    <Page title={tr({ ar: 'النزاعات والشكاوى', en: 'Disputes & complaints' })}>
      <ListView<Row>
        path="/v1/admin/disputes"
        filters={[
          { name: 'status', label: tr({ ar: 'الحالة', en: 'Status' }), type: 'select', options: opts('dispute') },
          { name: 'kind', label: tr({ ar: 'النوع', en: 'Kind' }), type: 'select', options: [{ value: 'dispute', label: { ar: 'نزاع', en: 'Dispute' } }, { value: 'complaint', label: { ar: 'شكوى', en: 'Complaint' } }] },
          { name: 'assignedToMe', label: tr({ ar: 'المسندة إليّ', en: 'Assigned to me' }), type: 'checkbox' },
        ]}
        rowHref={(r) => `/disputes/${r.id}`}
        columns={[
          { key: 'number', label: { ar: 'الرقم', en: 'Number' } },
          { key: 'subject', label: { ar: 'الموضوع', en: 'Subject' } },
          { key: 'type', label: { ar: 'النوع', en: 'Type' }, render: (r) => <Badge group="disputeType" value={r.type} /> },
          { key: 'bookingNumber', label: { ar: 'الحجز', en: 'Booking' } },
          { key: 'complainantRole', label: { ar: 'مقدم من', en: 'Raised by' } },
          { key: 'disputedAmount', label: { ar: 'المبلغ محل النزاع', en: 'Disputed' }, render: (r) => <Money amount={r.disputedAmount} currency={r.currency} /> },
          { key: 'status', label: { ar: 'الحالة', en: 'Status' }, render: (r) => <Badge group="dispute" value={r.status} /> },
          { key: 'createdAt', label: { ar: 'التاريخ', en: 'Date' }, render: (r) => <DateTime value={r.createdAt} /> },
        ]}
      />
    </Page>
  );
}
