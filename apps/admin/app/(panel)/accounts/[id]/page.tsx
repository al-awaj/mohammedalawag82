'use client';
import { use, useState } from 'react';
import { useGet, useTr } from '@events/web-kit/client';
import { DataTable, DateTime, ErrorBox, Filters, Loading, Money, Page } from '@events/web-kit/ui';

type Statement = { account: { id: string; code: string; currency: string; type: string }; openingDebitMinusCredit: string; lines: { entryNumber: string; occurredAt: string; description: string; sourceType: string; debit: string; credit: string; bookingId: string | null }[] };

export default function AccountStatement({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const tr = useTr();
  const [f, setF] = useState<Record<string, string>>({});
  const { data, error, isLoading } = useGet<Statement>(`/v1/admin/accounts/${id}/statement`, f);
  return (
    <Page title={`${tr({ ar: 'كشف حساب', en: 'Account statement' })} ${data?.account.code ?? ''}`}>
      <Filters value={f} onChange={setF} specs={[{ name: 'from', label: tr({ ar: 'من', en: 'From' }), type: 'date' }, { name: 'to', label: tr({ ar: 'إلى', en: 'To' }), type: 'date' }]} />
      <ErrorBox error={error} />
      {isLoading ? <Loading /> : data && <>
        <p>{tr({ ar: 'الرصيد الافتتاحي (مدين−دائن)', en: 'Opening balance (Dr−Cr)' })}: <Money amount={data.openingDebitMinusCredit} currency={data.account.currency} /></p>
        <DataTable rows={data.lines.map((l, i) => ({ ...l, id: `${l.entryNumber}-${i}` }))} columns={[
          { key: 'occurredAt', label: { ar: 'التاريخ', en: 'Date' }, render: (l) => <DateTime value={l.occurredAt} /> },
          { key: 'entryNumber', label: { ar: 'القيد', en: 'Entry' } },
          { key: 'description', label: { ar: 'البيان', en: 'Description' } },
          { key: 'debit', label: { ar: 'مدين', en: 'Debit' }, render: (l) => <Money amount={l.debit} currency={data.account.currency} /> },
          { key: 'credit', label: { ar: 'دائن', en: 'Credit' }, render: (l) => <Money amount={l.credit} currency={data.account.currency} /> },
        ]} />
      </>}
    </Page>
  );
}
