'use client';
import { useGet, useTr } from '@events/web-kit/client';
import { Badge, Card, DataTable, DateTime, ErrorBox, Loading, Money, Notice, Page, Text } from '@events/web-kit/ui';
import { useProvider } from '@/lib/provider';

type Earnings = {
  items: { id: string; bookingNumber: string; serviceTitle: Record<string, string>; startAt: string; currency: string; bookingTotal: string; collectedByPlatform: string; collectedDirectly: string; commission: string; net: string; status: string; dueAt: string | null }[];
  totals: { currency: string; status: string; net: string; commission: string; count: number }[];
};
type Settlement = { id: string; number: string; kind: string; amount: string; currency: string; method: string; status: string; paidAt: string | null; externalRef: string | null; createdAt: string };

export default function EarningsPage() {
  const tr = useTr();
  const { provider } = useProvider();
  const e = useGet<Earnings>('/v1/provider/earnings', { limit: 200 });
  const s = useGet<Settlement[]>('/v1/provider/settlements');
  return (
    <Page title={tr({ ar: 'المستحقات والتسويات', en: 'Earnings & settlements' })}>
      <Notice>{tr({ ar: 'تصبح المستحقات قابلة للتسوية بعد إتمام الخدمة (والمراجعة إن طُلبت). المبالغ المعلقة بسبب نزاع تخص الحجز المتنازع عليه فقط.', en: 'Earnings become settleable after the service is completed (and reviewed if required). Amounts on hold for a dispute concern that booking only.' })}
        {provider?.interimSettlementEligible ? ` ${tr({ ar: 'حسابك مؤهل للتسويات المرحلية وفق اتفاقيتك.', en: 'Your account is eligible for interim settlements under your agreement.' })}` : ''}</Notice>
      <ErrorBox error={e.error ?? s.error} />
      {e.isLoading ? <Loading /> : <>
        <Card title={tr({ ar: 'الإجماليات حسب الحالة', en: 'Totals by status' })}>
          <DataTable rows={(e.data?.totals ?? []).map((t, i) => ({ ...t, id: String(i) }))} columns={[
            { key: 'status', label: { ar: 'الحالة', en: 'Status' }, render: (t) => <Badge group="earning" value={t.status} /> },
            { key: 'count', label: { ar: 'عدد الحجوزات', en: 'Bookings' } },
            { key: 'commission', label: { ar: 'العمولة', en: 'Commission' }, render: (t) => <Money amount={t.commission} currency={t.currency} /> },
            { key: 'net', label: { ar: 'صافي مستحقاتك', en: 'Your net' }, render: (t) => <Money amount={t.net} currency={t.currency} /> },
          ]} />
        </Card>
        <Card title={tr({ ar: 'تفاصيل المستحقات', en: 'Earnings by booking' })}>
          <DataTable rows={e.data?.items ?? []} columns={[
            { key: 'bookingNumber', label: { ar: 'الحجز', en: 'Booking' } },
            { key: 'serviceTitle', label: { ar: 'الخدمة', en: 'Service' }, render: (r) => <Text value={r.serviceTitle} /> },
            { key: 'startAt', label: { ar: 'الموعد', en: 'Date' }, render: (r) => <DateTime value={r.startAt} dateOnly /> },
            { key: 'bookingTotal', label: { ar: 'قيمة الحجز', en: 'Booking total' }, render: (r) => <Money amount={r.bookingTotal} currency={r.currency} /> },
            { key: 'collectedByPlatform', label: { ar: 'حصّلته المنصة', en: 'Collected by platform' }, render: (r) => <Money amount={r.collectedByPlatform} currency={r.currency} /> },
            { key: 'collectedDirectly', label: { ar: 'حصّلته مباشرة', en: 'Collected directly' }, render: (r) => <Money amount={r.collectedDirectly} currency={r.currency} /> },
            { key: 'commission', label: { ar: 'العمولة', en: 'Commission' }, render: (r) => <Money amount={r.commission} currency={r.currency} /> },
            { key: 'net', label: { ar: 'الصافي', en: 'Net' }, render: (r) => <Money amount={r.net} currency={r.currency} /> },
            { key: 'status', label: { ar: 'الحالة', en: 'Status' }, render: (r) => <Badge group="earning" value={r.status} /> },
          ]} />
        </Card>
      </>}
      <Card title={tr({ ar: 'التسويات المدفوعة لك', en: 'Settlements paid to you' })}>
        <DataTable rows={s.data ?? []} columns={[
          { key: 'number', label: { ar: 'الرقم', en: 'Number' } },
          { key: 'kind', label: { ar: 'النوع', en: 'Kind' }, render: (r) => (r.kind === 'interim' ? tr({ ar: 'مرحلية', en: 'Interim' }) : tr({ ar: 'عادية', en: 'Regular' })) },
          { key: 'amount', label: { ar: 'المبلغ', en: 'Amount' }, render: (r) => <Money amount={r.amount} currency={r.currency} /> },
          { key: 'status', label: { ar: 'الحالة', en: 'Status' }, render: (r) => <Badge group="settlement" value={r.status} /> },
          { key: 'paidAt', label: { ar: 'تاريخ الدفع', en: 'Paid' }, render: (r) => <DateTime value={r.paidAt} /> },
          { key: 'externalRef', label: { ar: 'مرجع التحويل', en: 'Transfer reference' } },
        ]} />
      </Card>
    </Page>
  );
}
