'use client';
import { useState } from 'react';
import { toQueryString } from '@events/shared';
import { useGet, useTr } from '@events/web-kit/client';
import { ApiLink, DataTable, ErrorBox, Filters, Loading, Money, Page, Text } from '@events/web-kit/ui';

type Row = { serviceId: string; serviceTitle: Record<string, string>; currency: string; bookings: number; completed: number; cancelledOrNoShow: number; completedValue: string; paymentsReceived: string; commission: string; net: string; settled: string; outstanding: string; refunded: string; rating: string | null };

export default function Reports() {
  const tr = useTr();
  const [f, setF] = useState<Record<string, string>>({});
  const q = Object.fromEntries(Object.entries(f).filter(([, v]) => v));
  const { data, error, isLoading } = useGet<{ rows: Row[] }>('/v1/provider/reports/summary', q);
  const m = (k: keyof Row) => (r: Row) => <Money amount={String(r[k])} currency={r.currency} />;
  return (
    <Page title={tr({ ar: 'تقرير خدماتي', en: 'My services report' })} actions={<ApiLink path={`/v1/provider/reports/summary${toQueryString({ ...q, format: 'csv' })}`}>{tr({ ar: 'تصدير CSV', en: 'Export CSV' })}</ApiLink>}>
      <Filters value={f} onChange={setF} specs={[{ name: 'from', label: tr({ ar: 'من', en: 'From' }), type: 'date' }, { name: 'to', label: tr({ ar: 'إلى', en: 'To' }), type: 'date' }]} />
      <ErrorBox error={error} />
      {isLoading ? <Loading /> : (
        <DataTable rowKey="serviceId" rows={data?.rows ?? []} columns={[
          { key: 'serviceTitle', label: { ar: 'الخدمة', en: 'Service' }, render: (r) => <Text value={r.serviceTitle} /> },
          { key: 'bookings', label: { ar: 'الحجوزات', en: 'Bookings' } },
          { key: 'completed', label: { ar: 'المكتملة', en: 'Completed' } },
          { key: 'cancelledOrNoShow', label: { ar: 'الملغاة/عدم الحضور', en: 'Cancelled / no-show' } },
          { key: 'paymentsReceived', label: { ar: 'المدفوعات', en: 'Payments' }, render: m('paymentsReceived') },
          { key: 'commission', label: { ar: 'العمولة', en: 'Commission' }, render: m('commission') },
          { key: 'net', label: { ar: 'الصافي', en: 'Net' }, render: m('net') },
          { key: 'settled', label: { ar: 'المُسوّى', en: 'Settled' }, render: m('settled') },
          { key: 'outstanding', label: { ar: 'المتبقي لك', en: 'Outstanding' }, render: m('outstanding') },
          { key: 'refunded', label: { ar: 'المسترد للعملاء', en: 'Refunded' }, render: m('refunded') },
          { key: 'rating', label: { ar: 'التقييم', en: 'Rating' }, render: (r) => r.rating ?? '—' },
        ]} />
      )}
    </Page>
  );
}
