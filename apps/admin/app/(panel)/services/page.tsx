'use client';
import { useTr } from '@events/web-kit/client';
import { Badge, DateTime, ListView, Money, Page, Text } from '@events/web-kit/ui';
import { opts } from '@/lib/util';

type Row = { id: string; title: Record<string, string>; status: string; basePrice: string; currency: string; city: string; countryCode: string; typeCode: string; providerName: string; updatedAt: string };

export default function Services() {
  const tr = useTr();
  return (
    <Page title={tr({ ar: 'الخدمات', en: 'Services' })}>
      <ListView<Row>
        path="/v1/admin/services"
        select={(d) => (d as { items: Row[] } | undefined)?.items ?? []}
        filters={[
          { name: 'status', label: tr({ ar: 'الحالة', en: 'Status' }), type: 'select', options: opts('service') },
          { name: 'q', label: tr({ ar: 'بحث', en: 'Search' }) },
        ]}
        rowHref={(r) => `/services/${r.id}`}
        columns={[
          { key: 'title', label: { ar: 'الخدمة', en: 'Service' }, render: (r) => <Text value={r.title} /> },
          { key: 'providerName', label: { ar: 'صاحب الخدمة', en: 'Provider' } },
          { key: 'typeCode', label: { ar: 'النوع', en: 'Type' } },
          { key: 'city', label: { ar: 'المدينة', en: 'City' }, render: (r) => `${r.countryCode} · ${r.city}` },
          { key: 'basePrice', label: { ar: 'السعر', en: 'Price' }, render: (r) => <Money amount={r.basePrice} currency={r.currency} /> },
          { key: 'status', label: { ar: 'الحالة', en: 'Status' }, render: (r) => <Badge group="service" value={r.status} /> },
          { key: 'updatedAt', label: { ar: 'آخر تحديث', en: 'Updated' }, render: (r) => <DateTime value={r.updatedAt} /> },
        ]}
      />
    </Page>
  );
}
