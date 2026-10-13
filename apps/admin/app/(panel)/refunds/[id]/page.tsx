'use client';
import Link from 'next/link';
import { use } from 'react';
import { useGet, useSession, useTr } from '@events/web-kit/client';
import { ActionButton, Badge, Card, DataTable, DateTime, Detail, ErrorBox, Loading, Money, Notice, Page, reasonField } from '@events/web-kit/ui';

interface Refund {
  id: string; number: string; bookingId: string; bookingNumber: string; paymentId: string; amount: string; currency: string; source: string; reason: string; method: string; status: string;
  externalRef: string | null; failureReason: string | null; rejectionReason: string | null; requestedBy: string | null; requestedByKind: string; approvedBy: string | null; approvedAt: string | null;
  executedAt: string | null; createdAt: string; history: { from: string | null; to: string; actorKind: string; reason: string | null; at: string }[];
}

export default function RefundPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const tr = useTr();
  const me = useSession().data;
  const { data: r, error, isLoading } = useGet<Refund>(`/v1/admin/refunds/${id}`);
  if (isLoading) return <Loading />;
  if (error || !r) return <ErrorBox error={error} />;
  const ownRequest = r.requestedBy === me?.id;
  return (
    <Page title={`${tr({ ar: 'استرداد', en: 'Refund' })} ${r.number}`} actions={<>
      {r.status === 'requested' && <>
        <ActionButton variant="primary" label={tr({ ar: 'اعتماد', en: 'Approve' })} disabled={ownRequest}
          note={tr({ ar: 'الاعتماد ينقل المبلغ إلى استردادات مستحقة؛ لا يخرج المال قبل التنفيذ.', en: 'Approval moves the amount to refunds payable; money leaves only on execution.' })}
          run={(api) => api.post(`/v1/admin/refunds/${id}/approve`)} />
        <ActionButton variant="danger" label={tr({ ar: 'رفض', en: 'Reject' })} fields={[reasonField()]} run={(api, v) => api.post(`/v1/admin/refunds/${id}/reject`, v)} />
      </>}
      {r.status === 'approved' && (
        <ActionButton variant="primary" label={tr({ ar: 'تنفيذ', en: 'Execute' })}
          note={tr({ ar: 'بالبوابة: يُرسل الطلب لمزود الدفع ويكتمل عند تأكيده. يدويًا: أدخل مرجع التحويل.', en: 'Gateway: sent to the payment provider, completes on its confirmation. Manual: enter the transfer reference.' })}
          fields={[{ name: 'externalRef', label: { ar: 'مرجع التحويل (للتنفيذ اليدوي)', en: 'Transfer reference (manual)' } }]}
          run={(api, v) => api.post(`/v1/admin/refunds/${id}/execute`, v)} />
      )}
      {['approved', 'processing'].includes(r.status) && (
        <ActionButton variant="danger" label={tr({ ar: 'تسجيل فشل', en: 'Mark failed' })} fields={[reasonField()]} run={(api, v) => api.post(`/v1/admin/refunds/${id}/fail`, v)} />
      )}
    </>}>
      {ownRequest && r.status === 'requested' && <Notice kind="warning">{tr({ ar: 'لا يمكنك اعتماد طلب أنشأته بنفسك (مبدأ الأربع عيون).', en: 'You cannot approve a request you created (four-eyes rule).' })}</Notice>}
      <Card>
        <Detail items={[
          [tr({ ar: 'الحالة', en: 'Status' }), <Badge key="s" group="refund" value={r.status} />],
          [tr({ ar: 'المبلغ', en: 'Amount' }), <Money key="a" amount={r.amount} currency={r.currency} />],
          [tr({ ar: 'الحجز', en: 'Booking' }), <Link key="b" href={`/bookings/${r.bookingId}`}>{r.bookingNumber}</Link>],
          [tr({ ar: 'الدفعة الأصلية', en: 'Original payment' }), <Link key="p" href={`/payments/${r.paymentId}`}>{r.paymentId.slice(0, 8)}</Link>],
          [tr({ ar: 'المصدر', en: 'Source' }), r.source],
          [tr({ ar: 'الطريقة', en: 'Method' }), <Badge key="m" group="paymentMethod" value={r.method} />],
          [tr({ ar: 'السبب', en: 'Reason' }), r.reason],
          [tr({ ar: 'طلبه', en: 'Requested by' }), r.requestedByKind],
          [tr({ ar: 'اعتمد في', en: 'Approved at' }), <DateTime key="ap" value={r.approvedAt} />],
          [tr({ ar: 'نُفذ في', en: 'Executed at' }), <DateTime key="ex" value={r.executedAt} />],
          [tr({ ar: 'المرجع', en: 'Reference' }), r.externalRef],
          [tr({ ar: 'سبب الفشل/الرفض', en: 'Failure/rejection' }), r.failureReason ?? r.rejectionReason],
        ]} />
      </Card>
      <Card title={tr({ ar: 'السجل', en: 'History' })}>
        <DataTable rows={r.history.map((h, i) => ({ ...h, id: String(i) }))} columns={[
          { key: 'at', label: { ar: 'الوقت', en: 'Time' }, render: (h) => <DateTime value={h.at} /> },
          { key: 'to', label: { ar: 'إلى', en: 'To' }, render: (h) => <Badge group="refund" value={h.to} /> },
          { key: 'actorKind', label: { ar: 'بواسطة', en: 'By' } },
          { key: 'reason', label: { ar: 'السبب', en: 'Reason' } },
        ]} />
      </Card>
    </Page>
  );
}
