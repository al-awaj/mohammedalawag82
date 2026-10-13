'use client';
import Link from 'next/link';
import { use } from 'react';
import { formatMoney, localized } from '@events/shared';
import { useApp, useGet, useTr } from '@events/web-kit/client';
import { EventPicker } from '@/lib/events';
import { ActionButton, ApiLink, Badge, Card, DataTable, DateTime, Detail, disputeFields, ErrorBox, Loading, Money, Notice, Page } from '@events/web-kit/ui';

interface Booking {
  id: string; number: string; orderId: string; status: string; serviceId: string; serviceTitle: Record<string, string>; packageName: Record<string, string> | null; startAt: string; endAt: string;
  guests: number | null; addOns: { code: string; name: Record<string, string>; price: string }[]; subtotal: string; discountAmount: string; total: string; currency: string; upfrontAmount: string;
  balanceDueAt: string | null; paidAmount: string; remainingAmount: string; providerName: string | null; holdExpiresAt: string | null; decisionReason: string | null;
  cancellationPolicy: { description: Record<string, string>; tiers: { hoursBefore: number; refundPercentOfPaid: number }[]; depositRefundable: boolean } | null;
  history: { to: string; reason: string | null; at: string }[]; eventId: string | null;
}
type Preview = { mode: string; hoursBefore: number; platformPaid: string; directPaid: string; refund: string; retained: string; refundPercent: number | null; note: string };

export default function BookingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const tr = useTr();
  const { lang } = useApp();
  const { data: b, error, isLoading } = useGet<Booking>(`/v1/bookings/${id}`);
  const cancellable = !!b && ['awaiting_payment', 'confirmed'].includes(b.status);
  const preview = useGet<Preview>(cancellable ? `/v1/bookings/${id}/cancellation-preview` : null);
  const refunds = useGet<{ id: string; number: string; amount: string; currency: string; status: string; createdAt: string }[]>(`/v1/bookings/${id}/refunds`);
  if (isLoading) return <Loading />;
  if (error || !b) return <ErrorBox error={error} />;
  const p = preview.data;
  return (
    <Page title={`${tr({ ar: 'حجز', en: 'Booking' })} ${b.number}`} actions={<>
      {['awaiting_payment', 'confirmed', 'in_progress'].includes(b.status) && <Link className="btn btn-primary" href={`/orders/${b.orderId}`}>{tr({ ar: 'الدفع', en: 'Payment' })}</Link>}
      <ApiLink path={`/v1/bookings/${id}/statement?format=html&lang=${lang}`}>{tr({ ar: 'كشف الحجز', en: 'Statement' })}</ApiLink>
      {cancellable && p && (
        <ActionButton variant="danger" label={tr({ ar: 'إلغاء الحجز', en: 'Cancel booking' })}
          note={p.mode === 'immediate'
            ? tr({ ar: `سيُسترد ${formatMoney(p.refund, b.currency)} ويُحتفظ بـ ${formatMoney(p.retained, b.currency)} وفق سياسة الإلغاء.`, en: `${formatMoney(p.refund, b.currency)} will be refunded and ${formatMoney(p.retained, b.currency)} retained under the cancellation policy.` })
            : tr({ ar: 'سيُرسل طلب الإلغاء للإدارة للمراجعة.', en: 'Your cancellation request will be reviewed by the administration.' })}
          fields={[{ name: 'reason', label: { ar: 'سبب الإلغاء', en: 'Reason' }, type: 'textarea', required: true }]}
          run={(api, v) => api.post(`/v1/bookings/${id}/cancel`, v)} />
      )}
      {b.status === 'completed' && <ActionButton variant="primary" label={tr({ ar: 'قيّم الخدمة', en: 'Review the service' })} fields={[
        { name: 'rating', label: { ar: 'التقييم (1-5)', en: 'Rating (1-5)' }, type: 'select', required: true, options: ['5', '4', '3', '2', '1'].map((x) => ({ value: x, label: '★'.repeat(Number(x)) })) },
        { name: 'comment', label: { ar: 'تعليقك', en: 'Your comment' }, type: 'textarea' },
      ]} run={(api, v) => api.post(`/v1/bookings/${id}/review`, { ...v, rating: Number(v.rating) })} />}
      {!['pending_provider_approval', 'awaiting_payment', 'expired', 'rejected'].includes(b.status) && (
        <ActionButton label={tr({ ar: 'فتح نزاع', en: 'Open a dispute' })} fields={disputeFields(true)} run={(api, v) => api.post('/v1/disputes', { ...v, bookingId: id, kind: 'dispute' })} />
      )}
    </>}>
      {b.status === 'awaiting_payment' && b.holdExpiresAt && <Notice kind="warning">{tr({ ar: 'الموعد محجوز مؤقتًا حتى', en: 'The slot is held until' })} <DateTime value={b.holdExpiresAt} /> — {tr({ ar: 'أكمل الدفع قبلها.', en: 'complete the payment before then.' })}</Notice>}
      {b.decisionReason && <Notice>{b.decisionReason}</Notice>}
      <Card>
        <Detail items={[
          [tr({ ar: 'الحالة', en: 'Status' }), <Badge key="s" group="booking" value={b.status} />],
          [tr({ ar: 'الخدمة', en: 'Service' }), <Link key="sv" href={`/services/${b.serviceId}`}>{localized(b.serviceTitle, lang)}{b.packageName ? ` — ${localized(b.packageName, lang)}` : ''}</Link>],
          [tr({ ar: 'مقدم الخدمة', en: 'Provider' }), b.providerName],
          [tr({ ar: 'الموعد', en: 'When' }), <span key="w"><DateTime value={b.startAt} /> → <DateTime value={b.endAt} /></span>],
          [tr({ ar: 'الضيوف', en: 'Guests' }), b.guests ?? '—'],
          [tr({ ar: 'الإجمالي', en: 'Total' }), <Money key="t" amount={b.total} currency={b.currency} />],
          [tr({ ar: 'الخصم', en: 'Discount' }), <Money key="d" amount={b.discountAmount} currency={b.currency} />],
          [tr({ ar: 'المدفوع', en: 'Paid' }), <Money key="p" amount={b.paidAmount} currency={b.currency} />],
          [tr({ ar: 'المتبقي', en: 'Remaining' }), <Money key="r" amount={b.remainingAmount} currency={b.currency} />],
          [tr({ ar: 'موعد سداد المتبقي', en: 'Balance due' }), <DateTime key="bd" value={b.balanceDueAt} dateOnly />],
        ]} />
      </Card>
      <EventPicker value={b.eventId} path={`/v1/bookings/${id}/event`} testId="booking-event" />
      {b.cancellationPolicy && <Card title={tr({ ar: 'سياسة الإلغاء المتفق عليها', en: 'Agreed cancellation policy' })}>
        <p>{localized(b.cancellationPolicy.description, lang)}</p>
        {p && <p className="small muted">{tr({ ar: 'لو ألغيت الآن:', en: 'If you cancel now:' })} {tr({ ar: 'استرداد', en: 'refund' })} {formatMoney(p.refund, b.currency)} · {tr({ ar: 'محتجز', en: 'retained' })} {formatMoney(p.retained, b.currency)}</p>}
      </Card>}
      {(refunds.data ?? []).length > 0 && <Card title={tr({ ar: 'الاستردادات', en: 'Refunds' })}>
        <DataTable rows={refunds.data!} columns={[
          { key: 'number', label: { ar: 'الرقم', en: 'Number' } },
          { key: 'amount', label: { ar: 'المبلغ', en: 'Amount' }, render: (r) => <Money amount={r.amount} currency={r.currency} /> },
          { key: 'status', label: { ar: 'الحالة', en: 'Status' }, render: (r) => <Badge group="refund" value={r.status} /> },
          { key: 'createdAt', label: { ar: 'التاريخ', en: 'Date' }, render: (r) => <DateTime value={r.createdAt} /> },
        ]} />
      </Card>}
    </Page>
  );
}
