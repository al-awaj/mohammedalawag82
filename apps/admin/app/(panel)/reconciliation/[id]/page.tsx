'use client';
import { use, useState } from 'react';
import { useGet, useTr } from '@events/web-kit/client';
import { ActionButton, Badge, Card, DataTable, DateTime, ErrorBox, Filters, Json, Loading, Money, Page } from '@events/web-kit/ui';
import { opts } from '@/lib/util';

type Item = { id: string; status: string; kind: string; externalRef: string | null; paymentNumber: string | null; refundNumber: string | null; statementAmount: string | null; platformAmount: string | null; currency: string | null; note: string | null; resolvedAt: string | null; resolution: string | null };
type Run = { id: string; sourceName: string; periodFrom: string; periodTo: string; summary: unknown; items: Item[] };

export default function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const tr = useTr();
  const [f, setF] = useState<Record<string, string>>({});
  const { data, error, isLoading } = useGet<Run>(`/v1/admin/reconciliation/runs/${id}`, f);
  if (isLoading) return <Loading />;
  if (error || !data) return <ErrorBox error={error} />;
  return (
    <Page title={data.sourceName}>
      <Card title={tr({ ar: 'الملخص', en: 'Summary' })}><Json value={data.summary} /></Card>
      <Filters value={f} onChange={setF} specs={[
        { name: 'status', label: tr({ ar: 'النتيجة', en: 'Result' }), type: 'select', options: opts('reconciliation') },
        { name: 'unresolved', label: tr({ ar: 'غير المعالجة فقط', en: 'Unresolved only' }), type: 'checkbox' },
      ]} />
      <DataTable rows={data.items} columns={[
        { key: 'status', label: { ar: 'النتيجة', en: 'Result' }, render: (i) => <Badge group="reconciliation" value={i.status} /> },
        { key: 'kind', label: { ar: 'النوع', en: 'Kind' } },
        { key: 'externalRef', label: { ar: 'المرجع', en: 'Reference' }, render: (i) => <code>{i.externalRef ?? '—'}</code> },
        { key: 'record', label: { ar: 'في المنصة', en: 'Platform record' }, render: (i) => i.paymentNumber ?? i.refundNumber ?? '—' },
        { key: 'statementAmount', label: { ar: 'في الكشف', en: 'Statement' }, render: (i) => <Money amount={i.statementAmount} currency={i.currency} /> },
        { key: 'platformAmount', label: { ar: 'في المنصة', en: 'Platform' }, render: (i) => <Money amount={i.platformAmount} currency={i.currency} /> },
        { key: 'note', label: { ar: 'ملاحظة', en: 'Note' } },
        { key: 'resolution', label: { ar: 'المعالجة', en: 'Resolution' }, render: (i) => i.resolvedAt ? <span>{i.resolution} (<DateTime value={i.resolvedAt} />)</span> : i.status === 'matched' ? '—' : (
          <ActionButton label={tr({ ar: 'تسجيل المعالجة', en: 'Record resolution' })} fields={[{ name: 'resolution', label: { ar: 'ما الذي تم', en: 'What was done' }, type: 'textarea', required: true }]}
            run={(api, v) => api.post(`/v1/admin/reconciliation/items/${i.id}/resolve`, v)} />
        ) },
      ]} />
    </Page>
  );
}
