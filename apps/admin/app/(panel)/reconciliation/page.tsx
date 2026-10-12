'use client';
import { useState } from 'react';
import { useApp, useGet, useTr } from '@events/web-kit/client';
import { ActionButton, Card, DataTable, DateTime, ErrorBox, Filters, ListView, Notice, Page } from '@events/web-kit/ui';
import { useCountries } from '@/lib/util';
import { useFunds } from '@/lib/finance';

type Run = { id: string; countryId: string; sourceName: string; periodFrom: string; periodTo: string; summary: { lines: number; counts: Record<string, number> }; createdAt: string };
type Checks = { ok: boolean; issues: number; checks: Record<string, Record<string, unknown>[]> };

/** Parses "ref,kind,amount,currency[,status]" lines (header optional) into statement lines. */
function parseLines(text: string) {
  return text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^external_?ref/i.test(l)).map((l) => {
    const [externalRef, kind, amount, currency, status] = l.split(/[,;\t]/).map((x) => x.trim());
    return { externalRef, kind, amount, currency: currency?.toUpperCase(), ...(status ? { status } : {}) };
  });
}

export default function Reconciliation() {
  const tr = useTr();
  const { lang } = useApp();
  const countries = useCountries();
  const funds = useFunds(lang);
  const integrations = (useGet<{ id: string; name: string }[]>('/v1/admin/payment-integrations').data ?? []).map((i) => ({ value: i.id, label: i.name }));
  const [cf, setCf] = useState<Record<string, string>>({});
  const checks = useGet<Checks>('/v1/admin/reconciliation/checks', { country: cf.country });
  return (
    <Page title={tr({ ar: 'المطابقة', en: 'Reconciliation' })} actions={
      <ActionButton variant="primary" label={tr({ ar: 'مطابقة كشف جديد', en: 'Reconcile a statement' })}
        note={tr({ ar: 'الصق أسطر الكشف بالصيغة: المرجع,النوع(payment/refund),المبلغ,العملة[,الحالة]. النتائج للمتابعة فقط؛ أي تصحيح مالي يتم عبر المدفوعات والاستردادات المعتمدة.', en: 'Paste lines as: reference,kind(payment/refund),amount,currency[,status]. Results are findings only; any money correction goes through approved payments and refunds.' })}
        fields={[
          { name: 'countryId', label: { ar: 'الدولة', en: 'Country' }, type: 'select', required: true, options: countries.options },
          { name: 'integrationId', label: { ar: 'مزود الدفع', en: 'Payment provider' }, type: 'select', options: integrations },
          { name: 'accountId', label: { ar: 'أو الصندوق/الحساب البنكي', en: 'or fund / bank account' }, type: 'select', options: funds },
          { name: 'periodFrom', label: { ar: 'من', en: 'From' }, type: 'date', required: true },
          { name: 'periodTo', label: { ar: 'إلى', en: 'To' }, type: 'date', required: true },
          { name: 'sourceName', label: { ar: 'اسم الكشف', en: 'Statement name' }, required: true },
          { name: 'lines', label: { ar: 'الأسطر', en: 'Lines' }, type: 'textarea', required: true, placeholder: 'ref_123,payment,5000.00,SAR' },
        ]}
        run={(api, v) => api.post('/v1/admin/reconciliation/runs', { ...v, lines: parseLines(String(v.lines)) })} />
    }>
      <Card title={tr({ ar: 'فحوص الاتساق الداخلية', en: 'Internal consistency checks' })}>
        <Filters value={cf} onChange={setCf} specs={[{ name: 'country', label: tr({ ar: 'الدولة', en: 'Country' }), type: 'select', options: countries.options }]} />
        <ErrorBox error={checks.error} />
        {checks.data && (checks.data.ok
          ? <Notice kind="success">{tr({ ar: 'لا توجد فروقات بين العمليات والقيود.', en: 'No differences between operations and the ledger.' })}</Notice>
          : <>
              <Notice kind="warning">{tr({ ar: 'عدد الفروقات', en: 'Differences found' })}: {checks.data.issues}</Notice>
              {Object.entries(checks.data.checks).filter(([, rows]) => rows.length).map(([name, rows]) => (
                <div key={name}><h3>{name}</h3><DataTable rows={rows.map((r, i) => ({ ...r, id: String(i) }))} columns={Object.keys(rows[0]!).map((k) => ({ key: k, label: k }))} /></div>
              ))}
            </>)}
      </Card>
      <ListView<Run> path="/v1/admin/reconciliation/runs" rowHref={(r) => `/reconciliation/${r.id}`} columns={[
        { key: 'sourceName', label: { ar: 'الكشف', en: 'Statement' } },
        { key: 'countryId', label: { ar: 'الدولة', en: 'Country' }, render: (r) => countries.code(r.countryId) },
        { key: 'period', label: { ar: 'الفترة', en: 'Period' }, render: (r) => `${r.periodFrom.slice(0, 10)} → ${r.periodTo.slice(0, 10)}` },
        { key: 'lines', label: { ar: 'الأسطر', en: 'Lines' }, render: (r) => r.summary.lines },
        { key: 'counts', label: { ar: 'النتائج', en: 'Results' }, render: (r) => Object.entries(r.summary.counts).map(([k, n]) => `${k}: ${n}`).join(' · ') },
        { key: 'createdAt', label: { ar: 'التاريخ', en: 'Date' }, render: (r) => <DateTime value={r.createdAt} /> },
      ]} />
    </Page>
  );
}
