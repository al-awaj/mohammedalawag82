'use client';
import { useTr } from '@events/web-kit/client';
import { Badge, DateTime, ListView, Money, Page } from '@events/web-kit/ui';
import { opts, useCountries } from '@/lib/util';

type Row = { id: string; number: string; kind: string; countryId: string; currency: string; total: string; issuedAt: string; bookingId: string | null };

export default function Documents() {
  const tr = useTr();
  const countries = useCountries();
  return (
    <Page title={tr({ ar: 'المستندات المصدرة', en: 'Issued documents' })}>
      <ListView<Row>
        path="/v1/admin/documents"
        filters={[
          { name: 'country', label: tr({ ar: 'الدولة', en: 'Country' }), type: 'select', options: countries.options },
          { name: 'kind', label: tr({ ar: 'النوع', en: 'Kind' }), type: 'select', options: opts('document') },
          { name: 'number', label: tr({ ar: 'الرقم', en: 'Number' }) },
        ]}
        columns={[
          { key: 'number', label: { ar: 'الرقم', en: 'Number' }, render: (d) => <code>{d.number}</code> },
          { key: 'kind', label: { ar: 'النوع', en: 'Kind' }, render: (d) => <Badge group="document" value={d.kind} /> },
          { key: 'countryId', label: { ar: 'الدولة', en: 'Country' }, render: (d) => countries.code(d.countryId) },
          { key: 'total', label: { ar: 'المبلغ', en: 'Amount' }, render: (d) => <Money amount={d.total} currency={d.currency} /> },
          { key: 'issuedAt', label: { ar: 'تاريخ الإصدار', en: 'Issued' }, render: (d) => <DateTime value={d.issuedAt} /> },
          { key: 'print', label: '', render: (d) => (
            <span className="row gap">
              <a href={`/bff/v1/documents/${d.id}?format=html&lang=ar`} target="_blank" rel="noopener noreferrer">عربي</a>
              <a href={`/bff/v1/documents/${d.id}?format=html&lang=en`} target="_blank" rel="noopener noreferrer">English</a>{' · '}
              <a href={`/bff/v1/documents/${d.id}?format=pdf&lang=ar`} target="_blank" rel="noopener noreferrer">PDF</a>
            </span>
          ) },
        ]}
      />
    </Page>
  );
}
