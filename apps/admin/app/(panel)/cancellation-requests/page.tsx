'use client';
import Link from 'next/link';
import { useTr } from '@events/web-kit/client';
import { ActionButton, Badge, DateTime, ListView, Money, Page, reasonField } from '@events/web-kit/ui';

type Row = { id: string; bookingId: string; bookingNumber: string; bookingStatus: string; reason: string; computedRefund: string; status: string; approvedRefund: string | null; decisionReason: string | null; createdAt: string; currency: string };

export default function CancellationRequests() {
  const tr = useTr();
  return (
    <Page title={tr({ ar: 'طلبات الإلغاء', en: 'Cancellation requests' })}>
      <ListView<Row>
        path="/v1/admin/cancellation-requests"
        initialFilters={{ status: 'pending' }}
        filters={[{ name: 'status', label: tr({ ar: 'الحالة', en: 'Status' }), type: 'select', options: [
          { value: 'pending', label: { ar: 'معلقة', en: 'Pending' } }, { value: 'approved', label: { ar: 'معتمدة', en: 'Approved' } }, { value: 'rejected', label: { ar: 'مرفوضة', en: 'Rejected' } }] }]}
        columns={[
          { key: 'bookingNumber', label: { ar: 'الحجز', en: 'Booking' }, render: (r) => <Link href={`/bookings/${r.bookingId}`}>{r.bookingNumber}</Link> },
          { key: 'bookingStatus', label: { ar: 'حالة الحجز', en: 'Booking status' }, render: (r) => <Badge group="booking" value={r.bookingStatus} /> },
          { key: 'reason', label: { ar: 'سبب العميل', en: 'Customer reason' } },
          { key: 'computedRefund', label: { ar: 'الاسترداد وفق السياسة', en: 'Refund per policy' }, render: (r) => <Money amount={r.computedRefund} currency={r.currency} /> },
          { key: 'createdAt', label: { ar: 'التاريخ', en: 'Date' }, render: (r) => <DateTime value={r.createdAt} /> },
          { key: 'status', label: { ar: 'الحالة', en: 'Status' }, render: (r) => r.status },
          { key: 'actions', label: '', render: (r) => r.status === 'pending' ? (
            <ActionButton variant="primary" label={tr({ ar: 'قرار', en: 'Decide' })} fields={[
              { name: 'decision', label: { ar: 'القرار', en: 'Decision' }, type: 'select', required: true, options: [
                { value: 'approve', label: { ar: 'موافقة على الإلغاء', en: 'Approve cancellation' } }, { value: 'reject', label: { ar: 'رفض', en: 'Reject' } }] },
              { name: 'refundAmount', label: { ar: 'مبلغ الاسترداد (يترك فارغًا لتطبيق السياسة)', en: 'Refund amount (blank = policy)' }, type: 'decimal' },
              reasonField(),
            ]} run={(api, v) => api.post(`/v1/admin/cancellation-requests/${r.id}/decide`, v)} />
          ) : r.decisionReason },
        ]}
      />
    </Page>
  );
}
