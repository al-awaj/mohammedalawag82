'use client';
import { useState } from 'react';
import { useApp, useGet, useTr } from '@events/web-kit/client';
import { ActionButton, Badge, Card, DataTable, DateTime, ErrorBox, Filters, ListView, Money, Page } from '@events/web-kit/ui';
import { opts, useCurrencies } from '@/lib/util';
import { useFunds, useProviders } from '@/lib/finance';

type Row = { id: string; number: string; providerName: string; currency: string; kind: string; amount: string; method: string; status: string; createdAt: string; paidAt: string | null };

export default function Settlements() {
  const tr = useTr();
  const { lang } = useApp();
  const providers = useProviders();
  const funds = useFunds(lang);
  const currencies = useCurrencies();
  const [pv, setPv] = useState<Record<string, string>>({});
  const preview = useGet<{ total: string; items: { earningId: string; bookingNumber: string; amount: string }[] }>(pv.providerId && pv.currency ? '/v1/admin/settlements/preview' : null, pv);
  return (
    <Page title={tr({ ar: 'التسويات', en: 'Settlements' })} actions={
      <ActionButton variant="primary" label={tr({ ar: 'تسوية جديدة', en: 'New settlement' })}
        note={tr({ ar: 'تشمل التسوية العادية كل المستحقات الجاهزة لهذا صاحب الخدمة بهذه العملة. الاعتماد والدفع من موظف آخر.', en: 'A regular settlement includes all due earnings of this provider in this currency. Approval and payout are by another staff member.' })}
        fields={[
          { name: 'providerId', label: { ar: 'صاحب الخدمة', en: 'Provider' }, type: 'select', required: true, options: providers },
          { name: 'currency', label: { ar: 'العملة', en: 'Currency' }, type: 'select', required: true, options: currencies },
          { name: 'accountId', label: { ar: 'الصندوق الذي يُدفع منه', en: 'Paying fund' }, type: 'select', required: true, options: funds },
          { name: 'method', label: { ar: 'طريقة الدفع', en: 'Method' }, type: 'select', required: true, options: opts('paymentMethod').filter((o) => ['bank_transfer', 'cash', 'wallet'].includes(o.value)) },
          { name: 'kind', label: { ar: 'النوع', en: 'Kind' }, type: 'select', options: [{ value: 'regular', label: { ar: 'عادية', en: 'Regular' } }, { value: 'interim', label: { ar: 'مرحلية', en: 'Interim' } }] },
          { name: 'bookingId', label: { ar: 'الحجز (للتسوية المرحلية)', en: 'Booking (interim only)' } },
          { name: 'amount', label: { ar: 'المبلغ (للتسوية المرحلية)', en: 'Amount (interim only)' }, type: 'decimal' },
          { name: 'notes', label: { ar: 'ملاحظات', en: 'Notes' }, type: 'textarea' },
        ]}
        run={(api, v) => api.post('/v1/admin/settlements', v)} />
    }>
      <Card title={tr({ ar: 'معاينة المستحقات الجاهزة للتسوية', en: 'Preview earnings ready to settle' })}>
        <Filters value={pv} onChange={setPv} specs={[
          { name: 'providerId', label: tr({ ar: 'صاحب الخدمة', en: 'Provider' }), type: 'select', options: providers },
          { name: 'currency', label: tr({ ar: 'العملة', en: 'Currency' }), type: 'select', options: currencies },
        ]} />
        <ErrorBox error={preview.error} />
        {preview.data && <>
          <p><strong>{tr({ ar: 'الإجمالي', en: 'Total' })}:</strong> <Money amount={preview.data.total} currency={pv.currency} /></p>
          <DataTable rowKey="earningId" rows={preview.data.items} columns={[
            { key: 'bookingNumber', label: { ar: 'الحجز', en: 'Booking' } },
            { key: 'amount', label: { ar: 'المبلغ', en: 'Amount' }, render: (i) => <Money amount={i.amount} currency={pv.currency} /> },
          ]} />
        </>}
      </Card>
      <ListView<Row>
        path="/v1/admin/settlements"
        filters={[{ name: 'status', label: tr({ ar: 'الحالة', en: 'Status' }), type: 'select', options: opts('settlement') }]}
        rowHref={(r) => `/settlements/${r.id}`}
        columns={[
          { key: 'number', label: { ar: 'الرقم', en: 'Number' } },
          { key: 'providerName', label: { ar: 'صاحب الخدمة', en: 'Provider' } },
          { key: 'kind', label: { ar: 'النوع', en: 'Kind' } },
          { key: 'amount', label: { ar: 'المبلغ', en: 'Amount' }, render: (r) => <Money amount={r.amount} currency={r.currency} /> },
          { key: 'status', label: { ar: 'الحالة', en: 'Status' }, render: (r) => <Badge group="settlement" value={r.status} /> },
          { key: 'createdAt', label: { ar: 'أُنشئت', en: 'Created' }, render: (r) => <DateTime value={r.createdAt} /> },
          { key: 'paidAt', label: { ar: 'دُفعت', en: 'Paid' }, render: (r) => <DateTime value={r.paidAt} /> },
        ]}
      />
    </Page>
  );
}
