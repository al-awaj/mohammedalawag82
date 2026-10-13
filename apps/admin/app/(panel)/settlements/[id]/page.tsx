'use client';
import Link from 'next/link';
import { use } from 'react';
import { useGet, useSession, useTr } from '@events/web-kit/client';
import { ActionButton, Badge, Card, DataTable, DateTime, Detail, ErrorBox, Loading, Money, Notice, Page, reasonField } from '@events/web-kit/ui';

interface Settlement {
  id: string; number: string; providerId: string; providerName: string; currency: string; kind: string; amount: string; method: string; accountId: string; status: string;
  createdBy: string; approvedBy: string | null; approvedAt: string | null; paidAt: string | null; externalRef: string | null; failureReason: string | null; notes: string | null; createdAt: string;
  items: { earningId: string; bookingId: string; bookingNumber: string; amount: string; status: string }[];
  history: { from: string | null; to: string; reason: string | null; at: string }[];
}

export default function SettlementPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const tr = useTr();
  const me = useSession().data;
  const { data: s, error, isLoading } = useGet<Settlement>(`/v1/admin/settlements/${id}`);
  if (isLoading) return <Loading />;
  if (error || !s) return <ErrorBox error={error} />;
  const mine = s.createdBy === me?.id;
  return (
    <Page title={`${tr({ ar: 'تسوية', en: 'Settlement' })} ${s.number}`} actions={<>
      {s.status === 'pending_approval' && <ActionButton variant="primary" disabled={mine} label={tr({ ar: 'اعتماد', en: 'Approve' })} run={(api) => api.post(`/v1/admin/settlements/${id}/approve`)} />}
      {s.status === 'approved' && <ActionButton variant="primary" label={tr({ ar: 'تسجيل الدفع', en: 'Record payout' })}
        fields={[{ name: 'externalRef', label: { ar: 'مرجع التحويل', en: 'Transfer reference' }, required: true }]}
        run={(api, v) => api.post(`/v1/admin/settlements/${id}/mark-paid`, v)} />}
      {s.status === 'approved' && <ActionButton variant="danger" label={tr({ ar: 'تسجيل فشل', en: 'Mark failed' })} fields={[reasonField()]} run={(api, v) => api.post(`/v1/admin/settlements/${id}/mark-failed`, v)} />}
      {['pending_approval', 'approved'].includes(s.status) && <ActionButton variant="danger" label={tr({ ar: 'إلغاء', en: 'Cancel' })} fields={[reasonField()]} run={(api, v) => api.post(`/v1/admin/settlements/${id}/cancel`, v)} />}
    </>}>
      {mine && s.status === 'pending_approval' && <Notice kind="warning">{tr({ ar: 'يعتمد التسوية موظف غير منشئها.', en: 'A settlement is approved by someone other than its creator.' })}</Notice>}
      <Card>
        <Detail items={[
          [tr({ ar: 'الحالة', en: 'Status' }), <Badge key="s" group="settlement" value={s.status} />],
          [tr({ ar: 'صاحب الخدمة', en: 'Provider' }), s.providerName],
          [tr({ ar: 'النوع', en: 'Kind' }), s.kind],
          [tr({ ar: 'المبلغ', en: 'Amount' }), <Money key="a" amount={s.amount} currency={s.currency} />],
          [tr({ ar: 'الطريقة', en: 'Method' }), <Badge key="m" group="paymentMethod" value={s.method} />],
          [tr({ ar: 'المرجع', en: 'Reference' }), s.externalRef],
          [tr({ ar: 'اعتمدت', en: 'Approved' }), <DateTime key="ap" value={s.approvedAt} />],
          [tr({ ar: 'دُفعت', en: 'Paid' }), <DateTime key="pd" value={s.paidAt} />],
          [tr({ ar: 'ملاحظات', en: 'Notes' }), s.notes ?? s.failureReason],
        ]} />
      </Card>
      <Card title={tr({ ar: 'البنود', en: 'Items' })}>
        <DataTable rowKey="earningId" rows={s.items} columns={[
          { key: 'bookingNumber', label: { ar: 'الحجز', en: 'Booking' }, render: (i) => <Link href={`/bookings/${i.bookingId}`}>{i.bookingNumber}</Link> },
          { key: 'amount', label: { ar: 'المبلغ', en: 'Amount' }, render: (i) => <Money amount={i.amount} currency={s.currency} /> },
          { key: 'status', label: { ar: 'الحالة', en: 'Status' } },
        ]} />
      </Card>
      <Card title={tr({ ar: 'السجل', en: 'History' })}>
        <DataTable rows={s.history.map((h, i) => ({ ...h, id: String(i) }))} columns={[
          { key: 'at', label: { ar: 'الوقت', en: 'Time' }, render: (h) => <DateTime value={h.at} /> },
          { key: 'to', label: { ar: 'إلى', en: 'To' }, render: (h) => <Badge group="settlement" value={h.to} /> },
          { key: 'reason', label: { ar: 'السبب', en: 'Reason' } },
        ]} />
      </Card>
    </Page>
  );
}
