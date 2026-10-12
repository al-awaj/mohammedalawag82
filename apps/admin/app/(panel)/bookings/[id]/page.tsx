'use client';
import Link from 'next/link';
import { use } from 'react';
import { useCan, useGet, useTr } from '@events/web-kit/client';
import { ActionButton, ApiLink, Badge, Card, DataTable, DateTime, Detail, ErrorBox, Json, Loading, Money, Page, reasonField, Text } from '@events/web-kit/ui';

interface Booking {
  id: string; number: string; orderId: string; orderNumber: string; status: string; serviceId: string; serviceTitle: Record<string, string>; packageName: Record<string, string> | null;
  startAt: string; endAt: string; units: number; guests: number | null; pricingUnit: string; unitPrice: string; quantityFactor: string; addOns: { code: string; name: Record<string, string>; price: string }[];
  subtotal: string; total: string; currency: string; depositType: string; depositValue: string; upfrontAmount: string; balanceDueAt: string | null; securityDepositAmount: string;
  cancellationPolicy: unknown; requiresProviderApproval: boolean; holdExpiresAt: string | null; approvalDeadline: string | null; discountAmount: string;
  discountPlatformBorne: string; discountProviderBorne: string; decisionReason: string | null; customerNotes: string | null; createdAt: string;
  paidAmount: string; remainingAmount: string; providerName: string; customerName: string; customerPhone: string | null; customerEmail: string | null;
  history: { from: string | null; to: string; actorKind: string; reason: string | null; at: string }[];
}

export default function BookingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const tr = useTr();
  const can = useCan();
  const { data: b, error, isLoading } = useGet<Booking>(`/v1/admin/bookings/${id}`);
  const refundable = useGet<{ payments: { paymentId: string; number: string; refundable: string }[] } & Record<string, unknown>>(can('refunds.execute') ? `/v1/admin/bookings/${id}/refundable` : null);
  const refunds = useGet<{ id: string; number: string; amount: string; currency: string; status: string; source: string; createdAt: string }[]>(can('refunds.execute') ? '/v1/admin/refunds' : null, { bookingId: id });
  if (isLoading) return <Loading />;
  if (error || !b) return <ErrorBox error={error} />;
  const cancellable = ['awaiting_payment', 'confirmed', 'in_progress', 'pending_provider_approval'].includes(b.status);
  return (
    <Page title={`${tr({ ar: 'حجز', en: 'Booking' })} ${b.number}`} actions={<>
      {can('documents.print') && <ApiLink path={`/v1/bookings/${id}/statement?format=html&lang=ar`}>{tr({ ar: 'كشف الحجز', en: 'Booking statement' })}</ApiLink>}
      {can('bookings.cancel') && cancellable && (
        <ActionButton variant="danger" label={tr({ ar: 'إلغاء من الإدارة', en: 'Cancel (admin)' })}
          note={tr({ ar: 'يُحسب الاسترداد وفق سياسة الحجز ما لم تحدد مبلغًا؛ صرف الاسترداد يتطلب اعتمادًا منفصلًا.', en: 'Refund follows the booking policy unless you set an amount; paying it out needs a separate approval.' })}
          fields={[reasonField(), { name: 'refundAmount', label: { ar: 'مبلغ الاسترداد (اختياري)', en: 'Refund amount (optional)' }, type: 'decimal' }]}
          run={(api, v) => api.post(`/v1/admin/bookings/${id}/cancel`, v)} />
      )}
      {can('refunds.execute') && (
        <ActionButton label={tr({ ar: 'طلب استرداد', en: 'Request refund' })}
          fields={[
            { name: 'amount', label: { ar: 'المبلغ', en: 'Amount' }, type: 'decimal', required: true },
            { name: 'source', label: { ar: 'السبب الأساسي', en: 'Source' }, type: 'select', options: [
              { value: 'manual', label: { ar: 'يدوي', en: 'Manual' } }, { value: 'slot_unavailable', label: { ar: 'الموعد غير متاح', en: 'Slot unavailable' } },
              { value: 'booking_cancelled', label: { ar: 'حجز ملغى', en: 'Booking cancelled' } }] },
            reasonField(),
          ]}
          run={(api, v) => api.post(`/v1/admin/bookings/${id}/refunds`, v)} />
      )}
    </>}>
      <Card>
        <Detail items={[
          [tr({ ar: 'الحالة', en: 'Status' }), <Badge key="s" group="booking" value={b.status} />],
          [tr({ ar: 'الطلب', en: 'Order' }), b.orderNumber],
          [tr({ ar: 'الخدمة', en: 'Service' }), <span key="sv"><Text value={b.serviceTitle} />{b.packageName && <> — <Text value={b.packageName} /></>}</span>],
          [tr({ ar: 'صاحب الخدمة', en: 'Provider' }), b.providerName],
          [tr({ ar: 'العميل', en: 'Customer' }), `${b.customerName} ${b.customerPhone ?? ''}`],
          [tr({ ar: 'الموعد', en: 'When' }), <span key="w"><DateTime value={b.startAt} /> → <DateTime value={b.endAt} /></span>],
          [tr({ ar: 'الضيوف / الوحدات', en: 'Guests / units' }), `${b.guests ?? '—'} / ${b.units}`],
          [tr({ ar: 'سعر الوحدة', en: 'Unit price' }), <span key="u"><Money amount={b.unitPrice} currency={b.currency} /> × {b.quantityFactor} ({b.pricingUnit})</span>],
          [tr({ ar: 'المجموع', en: 'Subtotal' }), <Money key="st" amount={b.subtotal} currency={b.currency} />],
          [tr({ ar: 'الخصم', en: 'Discount' }), <span key="d"><Money amount={b.discountAmount} currency={b.currency} /> ({tr({ ar: 'المنصة', en: 'platform' })} <Money amount={b.discountPlatformBorne} currency={b.currency} />)</span>],
          [tr({ ar: 'الإجمالي', en: 'Total' }), <Money key="t" amount={b.total} currency={b.currency} />],
          [tr({ ar: 'المطلوب مقدمًا', en: 'Upfront' }), <Money key="up" amount={b.upfrontAmount} currency={b.currency} />],
          [tr({ ar: 'المدفوع', en: 'Paid' }), <Money key="p" amount={b.paidAmount} currency={b.currency} />],
          [tr({ ar: 'المتبقي', en: 'Remaining' }), <Money key="r" amount={b.remainingAmount} currency={b.currency} />],
          [tr({ ar: 'استحقاق المتبقي', en: 'Balance due' }), <DateTime key="bd" value={b.balanceDueAt} />],
          [tr({ ar: 'ملاحظات العميل', en: 'Customer notes' }), b.customerNotes],
        ]} />
      </Card>
      {b.addOns.length > 0 && <Card title={tr({ ar: 'الإضافات', en: 'Add-ons' })}>
        <DataTable rowKey="code" rows={b.addOns} columns={[
          { key: 'name', label: { ar: 'الإضافة', en: 'Add-on' }, render: (a) => <Text value={a.name} /> },
          { key: 'price', label: { ar: 'السعر', en: 'Price' }, render: (a) => <Money amount={a.price} currency={b.currency} /> },
        ]} />
      </Card>}
      {refunds.data && refunds.data.length > 0 && <Card title={tr({ ar: 'الاستردادات', en: 'Refunds' })}>
        <DataTable rows={refunds.data} rowHref={(r) => `/refunds/${r.id}`} columns={[
          { key: 'number', label: { ar: 'الرقم', en: 'Number' } },
          { key: 'amount', label: { ar: 'المبلغ', en: 'Amount' }, render: (r) => <Money amount={r.amount} currency={r.currency} /> },
          { key: 'source', label: { ar: 'المصدر', en: 'Source' } },
          { key: 'status', label: { ar: 'الحالة', en: 'Status' }, render: (r) => <Badge group="refund" value={r.status} /> },
        ]} />
      </Card>}
      {refundable.data && <Card title={tr({ ar: 'القابل للاسترداد', en: 'Refundable' })}><Json value={refundable.data} /></Card>}
      <Card title={tr({ ar: 'سياسة الإلغاء المحفوظة', en: 'Cancellation policy (snapshot)' })}>{b.cancellationPolicy ? <Json value={b.cancellationPolicy} /> : '—'}</Card>
      <Card title={tr({ ar: 'السجل', en: 'History' })}>
        <DataTable rows={b.history.map((h, i) => ({ ...h, id: String(i) }))} columns={[
          { key: 'at', label: { ar: 'الوقت', en: 'Time' }, render: (h) => <DateTime value={h.at} /> },
          { key: 'from', label: { ar: 'من', en: 'From' }, render: (h) => <Badge group="booking" value={h.from} /> },
          { key: 'to', label: { ar: 'إلى', en: 'To' }, render: (h) => <Badge group="booking" value={h.to} /> },
          { key: 'actorKind', label: { ar: 'بواسطة', en: 'By' } },
          { key: 'reason', label: { ar: 'السبب', en: 'Reason' } },
        ]} />
      </Card>
      <p><Link href={`/payments?orderId=${b.orderId}`}>{tr({ ar: 'مدفوعات هذا الطلب', en: 'Payments of this order' })}</Link></p>
    </Page>
  );
}
