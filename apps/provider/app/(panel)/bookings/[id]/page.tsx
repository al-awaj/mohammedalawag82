'use client';
import { use } from 'react';
import { useGet, useTr } from '@events/web-kit/client';
import { ActionButton, ApiLink, Badge, Card, DataTable, DateTime, Detail, disputeFields, ErrorBox, Loading, Money, Notice, Page, reasonField, Text, RescheduleCard, InstalmentSchedule, type Instalment } from '@events/web-kit/ui';

interface Booking {
  id: string; number: string; status: string; serviceTitle: Record<string, string>; packageName: Record<string, string> | null; startAt: string; endAt: string; units: number; guests: number | null;
  unitPrice: string; quantityFactor: string; pricingUnit: string; addOns: { code: string; name: Record<string, string>; price: string }[]; subtotal: string; total: string; currency: string;
  upfrontAmount: string; instalmentPlan: Instalment[] | null; balanceDueAt: string | null; discountAmount: string; discountProviderBorne: string; requiresProviderApproval: boolean; approvalDeadline: string | null;
  decisionReason: string | null; customerNotes: string | null; paidAmount: string; remainingAmount: string; customerName: string; customerPhone: string | null;
  history: { from: string | null; to: string; actorKind: string; reason: string | null; at: string }[];
}

export default function BookingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const tr = useTr();
  const { data: b, error, isLoading } = useGet<Booking>(`/v1/provider/bookings/${id}`);
  if (isLoading) return <Loading />;
  if (error || !b) return <ErrorBox error={error} />;
  const started = new Date(b.startAt).getTime() <= Date.now();
  return (
    <Page title={`${tr({ ar: 'حجز', en: 'Booking' })} ${b.number}`} actions={<>
      <ApiLink path={`/v1/bookings/${id}/statement?format=html&lang=ar`}>{tr({ ar: 'كشف الحجز', en: 'Statement' })}</ApiLink>
      {b.status === 'pending_provider_approval' && <>
        <ActionButton variant="primary" label={tr({ ar: 'قبول', en: 'Accept' })} note={tr({ ar: 'بعد القبول يُطلب من العميل الدفع ضمن المهلة المحددة.', en: 'After accepting, the customer is asked to pay within the payment window.' })} run={(api) => api.post(`/v1/provider/bookings/${id}/accept`)} />
        <ActionButton variant="danger" label={tr({ ar: 'رفض', en: 'Reject' })} fields={[reasonField()]} run={(api, v) => api.post(`/v1/provider/bookings/${id}/reject`, v)} />
      </>}
      {b.status === 'confirmed' && started && <ActionButton label={tr({ ar: 'بدء التنفيذ', en: 'Start' })} run={(api) => api.post(`/v1/provider/bookings/${id}/start`)} />}
      {['confirmed', 'in_progress'].includes(b.status) && started && <ActionButton variant="primary" label={tr({ ar: 'تم التنفيذ', en: 'Mark completed' })}
        note={tr({ ar: 'عند الإتمام تُحتسب العمولة وتصبح مستحقاتك قابلة للتسوية وفق سياسة المنصة.', en: 'On completion the commission is recognised and your earnings become settleable under platform policy.' })}
        run={(api) => api.post(`/v1/provider/bookings/${id}/complete`)} />}
      {b.status === 'confirmed' && started && <ActionButton variant="danger" label={tr({ ar: 'العميل لم يحضر', en: 'Customer did not show up' })}
        note={tr({ ar: 'يُطبق على عدم الحضور سياسة الإلغاء كأن العميل ألغى عند وقت البدء.', en: 'A no-show is handled by the cancellation policy as if the customer cancelled at the start time.' })}
        run={(api) => api.post(`/v1/provider/bookings/${id}/no-show`)} />}
      {['awaiting_payment', 'confirmed'].includes(b.status) && <ActionButton variant="danger" label={tr({ ar: 'إلغاء الحجز', en: 'Cancel booking' })}
        note={tr({ ar: 'إلغاء صاحب الخدمة يرد للعميل كامل ما دفعه وفق إعدادات الدولة.', en: 'A provider cancellation refunds the customer in full per country settings.' })}
        fields={[reasonField()]} run={(api, v) => api.post(`/v1/provider/bookings/${id}/cancel`, v)} />}
      {!['pending_provider_approval', 'awaiting_payment', 'expired', 'rejected'].includes(b.status) && <ActionButton label={tr({ ar: 'فتح نزاع', en: 'Open a dispute' })} fields={disputeFields(true)}
        run={(api, v) => api.post('/v1/disputes', { ...v, bookingId: id, kind: 'dispute' })} />}
    </>}>
      {b.status === 'pending_provider_approval' && b.approvalDeadline && <Notice kind="warning">{tr({ ar: 'يجب الرد قبل', en: 'Respond before' })} <DateTime value={b.approvalDeadline} /></Notice>}
      <Card>
        <Detail items={[
          [tr({ ar: 'الحالة', en: 'Status' }), <Badge key="s" group="booking" value={b.status} />],
          [tr({ ar: 'الخدمة', en: 'Service' }), <span key="sv"><Text value={b.serviceTitle} />{b.packageName && <> — <Text value={b.packageName} /></>}</span>],
          [tr({ ar: 'العميل', en: 'Customer' }), b.customerName],
          [tr({ ar: 'جوال العميل', en: 'Customer phone' }), b.customerPhone ? <span key="ph" dir="ltr">{b.customerPhone}</span> : tr({ ar: 'يظهر بعد تأكيد الحجز', en: 'Shown once confirmed' })],
          [tr({ ar: 'الموعد', en: 'When' }), <span key="w"><DateTime value={b.startAt} /> → <DateTime value={b.endAt} /></span>],
          [tr({ ar: 'الضيوف', en: 'Guests' }), b.guests ?? '—'],
          [tr({ ar: 'الإجمالي', en: 'Total' }), <Money key="t" amount={b.total} currency={b.currency} />],
          [tr({ ar: 'خصم تتحمله', en: 'Discount you bear' }), <Money key="d" amount={b.discountProviderBorne} currency={b.currency} />],
          [tr({ ar: 'المدفوع', en: 'Paid' }), <Money key="p" amount={b.paidAmount} currency={b.currency} />],
          [tr({ ar: 'المتبقي', en: 'Remaining' }), <Money key="r" amount={b.remainingAmount} currency={b.currency} />],
          [tr({ ar: 'ملاحظات العميل', en: 'Customer notes' }), b.customerNotes],
        ]} />
      </Card>
      {b.addOns.length > 0 && <Card title={tr({ ar: 'الإضافات', en: 'Add-ons' })}>
        <DataTable rowKey="code" rows={b.addOns} columns={[
          { key: 'name', label: { ar: 'الإضافة', en: 'Add-on' }, render: (a) => <Text value={a.name} /> },
          { key: 'price', label: { ar: 'السعر', en: 'Price' }, render: (a) => <Money amount={a.price} currency={b.currency} /> },
        ]} />
      </Card>}
      <InstalmentSchedule plan={b.instalmentPlan} upfrontAmount={b.upfrontAmount} paidAmount={b.paidAmount} currency={b.currency} />
      <RescheduleCard audience="provider" bookingId={b.id} startAt={b.startAt} endAt={b.endAt} movable={false} />
      <Card title={tr({ ar: 'السجل', en: 'History' })}>
        <DataTable rows={b.history.map((h, i) => ({ ...h, id: String(i) }))} columns={[
          { key: 'at', label: { ar: 'الوقت', en: 'Time' }, render: (h) => <DateTime value={h.at} /> },
          { key: 'to', label: { ar: 'الحالة', en: 'Status' }, render: (h) => <Badge group="booking" value={h.to} /> },
          { key: 'actorKind', label: { ar: 'بواسطة', en: 'By' } },
          { key: 'reason', label: { ar: 'السبب', en: 'Reason' } },
        ]} />
      </Card>
    </Page>
  );
}
