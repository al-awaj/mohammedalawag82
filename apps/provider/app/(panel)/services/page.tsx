'use client';
import Link from 'next/link';
import { useGet, useTr } from '@events/web-kit/client';
import { Badge, DataTable, DateTime, ErrorBox, Loading, Money, Page, Text } from '@events/web-kit/ui';

type Row = { id: string; title: Record<string, string>; status: string; statusReason: string | null; basePrice: string; currency: string; typeCode: string; updatedAt: string };

export default function Services() {
  const tr = useTr();
  const { data, error, isLoading } = useGet<Row[]>('/v1/provider/services');
  return (
    <Page title={tr({ ar: 'خدماتي', en: 'My services' })} actions={<Link className="btn btn-primary" href="/services/new">{tr({ ar: 'خدمة جديدة', en: 'New service' })}</Link>}>
      <ErrorBox error={error} />
      {isLoading ? <Loading /> : (
        <DataTable rows={data ?? []} rowHref={(s) => `/services/${s.id}`} columns={[
          { key: 'title', label: { ar: 'الخدمة', en: 'Service' }, render: (s) => <Text value={s.title} /> },
          { key: 'typeCode', label: { ar: 'النوع', en: 'Type' } },
          { key: 'basePrice', label: { ar: 'السعر', en: 'Price' }, render: (s) => <Money amount={s.basePrice} currency={s.currency} /> },
          { key: 'status', label: { ar: 'الحالة', en: 'Status' }, render: (s) => <Badge group="service" value={s.status} /> },
          { key: 'statusReason', label: { ar: 'ملاحظة الإدارة', en: 'Admin note' } },
          { key: 'updatedAt', label: { ar: 'آخر تحديث', en: 'Updated' }, render: (s) => <DateTime value={s.updatedAt} /> },
        ]} />
      )}
    </Page>
  );
}
