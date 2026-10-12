'use client';
import { useTr } from '@events/web-kit/client';
import { Badge, DateTime, ListView, Page } from '@events/web-kit/ui';
import { opts } from '@/lib/util';

type Row = { id: string; status: string; businessName: string; activityType: string; countryCode: string; city: string; phone: string; submittedAt: string | null; createdAt: string };

export default function Applications() {
  const tr = useTr();
  return (
    <Page title={tr({ ar: 'طلبات تسجيل أصحاب الخدمات', en: 'Provider applications' })}>
      <ListView<Row>
        path="/v1/admin/provider-applications"
        select={(d) => (d as { items: Row[] } | undefined)?.items ?? []}
        filters={[
          { name: 'status', label: tr({ ar: 'الحالة', en: 'Status' }), type: 'select', options: opts('application') },
          { name: 'countryCode', label: tr({ ar: 'رمز الدولة', en: 'Country code' }) },
          { name: 'q', label: tr({ ar: 'بحث', en: 'Search' }) },
        ]}
        rowHref={(r) => `/applications/${r.id}`}
        columns={[
          { key: 'businessName', label: { ar: 'النشاط', en: 'Business' } },
          { key: 'activityType', label: { ar: 'نوع النشاط', en: 'Activity' } },
          { key: 'countryCode', label: { ar: 'الدولة', en: 'Country' } },
          { key: 'city', label: { ar: 'المدينة', en: 'City' } },
          { key: 'status', label: { ar: 'الحالة', en: 'Status' }, render: (r) => <Badge group="application" value={r.status} /> },
          { key: 'submittedAt', label: { ar: 'تاريخ الإرسال', en: 'Submitted' }, render: (r) => <DateTime value={r.submittedAt} /> },
        ]}
      />
    </Page>
  );
}
