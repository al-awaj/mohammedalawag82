'use client';
import { useState } from 'react';
import { useCan, useGet, useTr } from '@events/web-kit/client';
import { ActionButton, Card, DataTable, ErrorBox, Filters, Loading, Money, Notice, Page, reasonField, Text } from '@events/web-kit/ui';
import { useCountries, useCurrencies } from '@/lib/util';
import type { Account } from '@/lib/finance';

type TB = { items: { code: string; kind: string; type: string; name: Record<string, string>; debit: string; credit: string; openingDebitMinusCredit: string; closingDebitMinusCredit: string }[]; totals: { debit: string; credit: string; balanced: boolean } };

export default function Accounts() {
  const tr = useTr();
  const can = useCan();
  const countries = useCountries();
  const currencies = useCurrencies();
  const [f, setF] = useState<Record<string, string>>({});
  const { data, error, isLoading } = useGet<Account[]>('/v1/admin/accounts', f);
  const tb = useGet<TB>(f.countryId && f.currency ? '/v1/admin/ledger/trial-balance' : null, { countryId: f.countryId, currency: f.currency, from: f.from, to: f.to });
  return (
    <Page title={tr({ ar: 'الصناديق والحسابات', en: 'Funds & accounts' })} actions={can('accounts.manage') && (
      <ActionButton variant="primary" label={tr({ ar: 'صندوق جديد', en: 'New fund' })}
        note={tr({ ar: 'يبدأ الصندوق الجديد برصيد صفر؛ الأرصدة تأتي من القيود فقط.', en: 'A new fund starts at zero; balances come from posted entries only.' })}
        fields={[
          { name: 'countryId', label: { ar: 'الدولة', en: 'Country' }, type: 'select', required: true, options: countries.options },
          { name: 'currency', label: { ar: 'العملة', en: 'Currency' }, type: 'select', required: true, options: currencies },
          { name: 'kind', label: { ar: 'النوع', en: 'Kind' }, type: 'select', required: true, options: [
            { value: 'cash', label: { ar: 'صندوق نقدي', en: 'Cash' } }, { value: 'bank', label: { ar: 'حساب بنكي', en: 'Bank account' } },
            { value: 'wallet', label: { ar: 'محفظة إلكترونية', en: 'Wallet' } }, { value: 'gateway', label: { ar: 'ذمة بوابة دفع', en: 'Gateway receivable' } }] },
          { name: 'suffix', label: { ar: 'لاحقة الرمز', en: 'Code suffix' }, required: true, help: { ar: 'مثل 01 ← 1200-01', en: 'e.g. 01 → 1200-01' } },
          { name: 'name', label: { ar: 'الاسم', en: 'Name' }, type: 'i18n', required: true },
          { name: 'details', label: { ar: 'تفاصيل (JSON، بدون أسرار)', en: 'Details (JSON, no secrets)' }, type: 'json',
            defaultValue: { iban: '', paymentInstructions: { ar: '', en: '' } },
            help: { ar: 'paymentInstructions فقط يظهر للعميل عند الدفع بالتحويل (مثل الآيبان واسم المستفيد). باقي الحقول داخلية.', en: 'Only paymentInstructions is shown to customers paying by transfer (e.g. IBAN and beneficiary). Other fields stay internal.' } },
        ]}
        run={(api, v) => api.post('/v1/admin/accounts', v)} />
    )}>
      <Filters value={f} onChange={setF} specs={[
        { name: 'countryId', label: tr({ ar: 'الدولة', en: 'Country' }), type: 'select', options: countries.options },
        { name: 'currency', label: tr({ ar: 'العملة', en: 'Currency' }), type: 'select', options: currencies },
        { name: 'from', label: tr({ ar: 'من (ميزان المراجعة)', en: 'From (trial balance)' }), type: 'date' },
        { name: 'to', label: tr({ ar: 'إلى', en: 'To' }), type: 'date' },
      ]} />
      <ErrorBox error={error} />
      {isLoading ? <Loading /> : (
        <DataTable rows={data ?? []} rowHref={(a) => `/accounts/${a.id}`} columns={[
          { key: 'code', label: { ar: 'الرمز', en: 'Code' } },
          { key: 'name', label: { ar: 'الحساب', en: 'Account' }, render: (a) => <Text value={a.name} /> },
          { key: 'countryId', label: { ar: 'الدولة', en: 'Country' }, render: (a) => countries.code(a.countryId) },
          { key: 'kind', label: { ar: 'النوع', en: 'Kind' } },
          { key: 'balance', label: { ar: 'الرصيد', en: 'Balance' }, render: (a) => <Money amount={a.balance} currency={a.currency} /> },
          { key: 'isActive', label: { ar: 'مفعّل', en: 'Active' } },
          { key: 'actions', label: '', render: (a) => can('accounts.manage') && !a.isSystem ? (
            <ActionButton label={a.isActive ? tr({ ar: 'تعطيل', en: 'Disable' }) : tr({ ar: 'تفعيل', en: 'Enable' })}
              note={tr({ ar: 'لا يُعطّل صندوق عليه رصيد أو مرتبط بطرق دفع مفعّلة.', en: 'A fund with a balance or active payment methods cannot be disabled.' })}
              fields={[reasonField()]} run={(api, v) => api.patch(`/v1/admin/accounts/${a.id}`, { isActive: !a.isActive, ...v })} />
          ) : null },
        ]} />
      )}
      <Card title={tr({ ar: 'ميزان المراجعة', en: 'Trial balance' })}>
        {!f.countryId || !f.currency ? <p className="muted">{tr({ ar: 'اختر الدولة والعملة.', en: 'Choose a country and a currency.' })}</p> : (
          <>
            <ErrorBox error={tb.error} />
            {tb.data && <>
              <Notice kind={tb.data.totals.balanced ? 'success' : 'warning'}>
                {tb.data.totals.balanced ? tr({ ar: 'متوازن', en: 'Balanced' }) : tr({ ar: 'غير متوازن!', en: 'NOT balanced!' })} — {tr({ ar: 'مدين', en: 'Debit' })} <Money amount={tb.data.totals.debit} currency={f.currency} /> / {tr({ ar: 'دائن', en: 'Credit' })} <Money amount={tb.data.totals.credit} currency={f.currency} />
              </Notice>
              <DataTable rowKey="code" rows={tb.data.items} columns={[
                { key: 'code', label: { ar: 'الرمز', en: 'Code' } },
                { key: 'name', label: { ar: 'الحساب', en: 'Account' }, render: (r) => <Text value={r.name} /> },
                { key: 'openingDebitMinusCredit', label: { ar: 'افتتاحي (مدين−دائن)', en: 'Opening (Dr−Cr)' }, render: (r) => <Money amount={r.openingDebitMinusCredit} currency={f.currency} /> },
                { key: 'debit', label: { ar: 'مدين', en: 'Debit' }, render: (r) => <Money amount={r.debit} currency={f.currency} /> },
                { key: 'credit', label: { ar: 'دائن', en: 'Credit' }, render: (r) => <Money amount={r.credit} currency={f.currency} /> },
                { key: 'closingDebitMinusCredit', label: { ar: 'ختامي (مدين−دائن)', en: 'Closing (Dr−Cr)' }, render: (r) => <Money amount={r.closingDebitMinusCredit} currency={f.currency} /> },
              ]} />
            </>}
          </>
        )}
      </Card>
    </Page>
  );
}
