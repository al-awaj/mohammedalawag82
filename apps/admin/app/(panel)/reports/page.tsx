'use client';
import { useState } from 'react';
import { toQueryString } from '@events/shared';
import { useCan, useGet, useTr } from '@events/web-kit/client';
import { ApiLink, Card, DataTable, ErrorBox, Filters, Json, Loading, Money, Notice, Page } from '@events/web-kit/ui';
import { useCountries, useCurrencies } from '@/lib/util';

type Result = { rows: Record<string, unknown>[]; moneyFields: string[]; notes: string[]; displayCurrency?: string; convertedTotals?: Record<string, string>; fxRates?: unknown[] };

const NAMES: Record<string, { ar: string; en: string }> = {
  overview: { ar: 'نظرة تشغيلية', en: 'Operational overview' }, revenue: { ar: 'إيرادات المنصة', en: 'Platform revenue' },
  commissions: { ar: 'العمولات', en: 'Commissions' }, 'payments-by-method': { ar: 'المدفوعات حسب الطريقة', en: 'Payments by method' },
  'payments-by-currency': { ar: 'المدفوعات حسب العملة', en: 'Payments by currency' }, refunds: { ar: 'الاستردادات', en: 'Refunds' },
  'provider-earnings': { ar: 'مستحقات أصحاب الخدمات', en: 'Provider earnings' }, settlements: { ar: 'التسويات', en: 'Settlements' },
  'fund-balances': { ar: 'أرصدة الصناديق', en: 'Fund balances' }, 'fx-differences': { ar: 'فروق الصرف', en: 'FX differences' },
  'bookings-payments': { ar: 'الحجوزات والمدفوع والمتبقي', en: 'Bookings, paid and remaining' }, discounts: { ar: 'الخصومات والعروض', en: 'Discounts & promotions' },
  disputes: { ar: 'النزاعات ذات الأثر المالي', en: 'Disputes with financial impact' }, 'trial-balance': { ar: 'ميزان المراجعة', en: 'Trial balance' },
  consolidated: { ar: 'المركز الموحد', en: 'Consolidated position' },
};

export default function Reports() {
  const tr = useTr();
  const can = useCan();
  const countries = useCountries();
  const currencies = useCurrencies();
  const [report, setReport] = useState('overview');
  const [f, setF] = useState<Record<string, string>>({});
  const q = Object.fromEntries(Object.entries(f).filter(([, v]) => v));
  const { data, error, isLoading } = useGet<Result>(`/v1/admin/reports/${report}`, q);
  const money = new Set(data?.moneyFields ?? []);
  const cols = data?.rows[0] ? Object.keys(data.rows[0]) : [];
  return (
    <Page title={tr({ ar: 'التقارير', en: 'Reports' })} actions={can('reports.export') && (
      <ApiLink path={`/v1/admin/reports/${report}${toQueryString({ ...q, format: 'csv' })}`}>{tr({ ar: 'تصدير CSV', en: 'Export CSV' })}</ApiLink>
    )}>
      <div className="filters">
        <label className="filter"><span>{tr({ ar: 'التقرير', en: 'Report' })}</span>
          <select value={report} onChange={(e) => setReport(e.target.value)}>
            {Object.entries(NAMES).map(([k, v]) => <option key={k} value={k}>{tr(v)}</option>)}
          </select>
        </label>
      </div>
      <Filters value={f} onChange={setF} specs={[
        { name: 'country', label: tr({ ar: 'الدولة', en: 'Country' }), type: 'select', options: countries.options },
        { name: 'currency', label: tr({ ar: 'العملة', en: 'Currency' }), type: 'select', options: currencies },
        { name: 'from', label: tr({ ar: 'من', en: 'From' }), type: 'date' },
        { name: 'to', label: tr({ ar: 'إلى', en: 'To' }), type: 'date' },
        { name: 'displayCurrency', label: tr({ ar: 'عرض موحد بعملة', en: 'Convert to' }), type: 'select', options: currencies },
        { name: 'rateDate', label: tr({ ar: 'تاريخ سعر الصرف', en: 'Rate date' }), type: 'date' },
      ]} />
      <Notice>{tr({ ar: 'كل رقم بعملته الأصلية. التحويل لعملة عرض يتم فقط بسعر صرف معتمد ومؤرخ، ويُعرض المبلغ الأصلي بجانبه.', en: 'Every figure is in its own currency. Conversion uses only an approved, dated exchange rate, and the original amount is kept alongside.' })}</Notice>
      <ErrorBox error={error} />
      {isLoading ? <Loading /> : data && <>
        {data.notes.map((n) => <Notice key={n} kind={n.startsWith('UNBALANCED') ? 'warning' : 'info'}>{n}</Notice>)}
        <DataTable rows={data.rows.map((r, i) => ({ ...r, id: String(i) }))} columns={cols.map((k) => ({
          key: k, label: k,
          render: money.has(k) ? (r: Record<string, unknown>) => <Money amount={String(r[k] ?? '')} currency={String(r.currency ?? '')} />
            : k.endsWith('Converted') ? (r: Record<string, unknown>) => <Money amount={String(r[k] ?? '')} currency={data.displayCurrency} />
            : undefined,
        }))} />
        {data.convertedTotals && <Card title={`${tr({ ar: 'الإجماليات المحولة', en: 'Converted totals' })} (${data.displayCurrency})`}>
          <DataTable rows={Object.entries(data.convertedTotals).map(([k, v]) => ({ id: k, field: k, total: v }))} columns={[
            { key: 'field', label: { ar: 'الحقل', en: 'Field' } },
            { key: 'total', label: { ar: 'الإجمالي', en: 'Total' }, render: (r) => <Money amount={r.total} currency={data.displayCurrency} /> },
          ]} />
          <h3>{tr({ ar: 'أسعار الصرف المستخدمة', en: 'Exchange rates used' })}</h3>
          <Json value={data.fxRates} />
        </Card>}
      </>}
    </Page>
  );
}
