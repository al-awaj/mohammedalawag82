'use client';
import { useState } from 'react';
import { useAction, useApp, useGet, useTr } from '@events/web-kit/client';
import { ActionButton, Button, Card, DataTable, DateTime, ErrorBox, Filters, Form, ListView, Notice, Page, type Option } from '@events/web-kit/ui';
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
      <StatementImport countries={countries.options} integrations={integrations} funds={funds} />
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

type Line = { externalRef: string; kind: string; amount: string; currency: string; status?: string };
type Parsed = { format: string; lines: Line[]; skipped: { row: number; reason: string }[]; columns?: string[] };

/**
 * Statement file import: a CSV export (the admin names the columns) or a CAMT.053 bank statement. The file is read
 * first and shown for review; the reconciliation run is created only after confirmation.
 */
function StatementImport({ countries, integrations, funds }: { countries: Option[]; integrations: Option[]; funds: Option[] }) {
  const tr = useTr();
  const { api } = useApp();
  const [file, setFile] = useState<File | null>(null);
  const [format, setFormat] = useState<'auto' | 'csv' | 'camt053'>('auto');
  const [map, setMap] = useState({ referenceColumn: '', amountColumn: '', currencyColumn: '', kindColumn: '', statusColumn: '', defaultCurrency: '', decimalComma: false });
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const create = useAction((a, v: Record<string, unknown>) => a.post<{ id: string }>('/v1/admin/reconciliation/runs', { ...v, lines: parsed?.lines ?? [] }));
  const read = async () => {
    if (!file) return;
    setBusy(true); setErr(null); setParsed(null);
    try {
      const f = new FormData();
      if (format !== 'auto') f.append('format', format);
      for (const [k, v] of Object.entries(map)) if (v) f.append(k, String(v));
      f.append('file', file);
      setParsed(await api.upload<Parsed>('/v1/admin/reconciliation/parse', f));
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  const set = (k: keyof typeof map) => (e: React.ChangeEvent<HTMLInputElement>) => setMap({ ...map, [k]: k === 'decimalComma' ? e.target.checked : e.target.value });
  const csv = format !== 'camt053';
  return (
    <Card title={tr({ ar: 'استيراد ملف كشف (CSV أو CAMT.053)', en: 'Import a statement file (CSV or CAMT.053)' })}>
      <div className="form-grid">
        <label className="field"><span>{tr({ ar: 'الملف', en: 'File' })}</span><input id="f-statement" type="file" accept=".csv,.txt,.xml" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setParsed(null); }} /></label>
        <label className="field"><span>{tr({ ar: 'الصيغة', en: 'Format' })}</span>
          <select id="f-format" value={format} onChange={(e) => setFormat(e.target.value as typeof format)}>
            <option value="auto">{tr({ ar: 'تلقائي', en: 'Detect' })}</option><option value="csv">CSV</option><option value="camt053">CAMT.053 (XML)</option>
          </select></label>
        {csv && <>
          <label className="field"><span>{tr({ ar: 'عمود المرجع', en: 'Reference column' })} *</span><input id="f-referenceColumn" value={map.referenceColumn} onChange={set('referenceColumn')} /></label>
          <label className="field"><span>{tr({ ar: 'عمود المبلغ', en: 'Amount column' })} *</span><input id="f-amountColumn" value={map.amountColumn} onChange={set('amountColumn')} /></label>
          <label className="field"><span>{tr({ ar: 'عمود العملة', en: 'Currency column' })}</span><input id="f-currencyColumn" value={map.currencyColumn} onChange={set('currencyColumn')} /></label>
          <label className="field"><span>{tr({ ar: 'أو عملة ثابتة', en: 'or a fixed currency' })}</span><input id="f-defaultCurrency" dir="ltr" placeholder="SAR" value={map.defaultCurrency} onChange={set('defaultCurrency')} /></label>
          <label className="field"><span>{tr({ ar: 'عمود النوع (اختياري؛ وإلا فالإشارة السالبة = استرداد)', en: 'Type column (optional; otherwise negative = refund)' })}</span><input id="f-kindColumn" value={map.kindColumn} onChange={set('kindColumn')} /></label>
          <label className="field"><span>{tr({ ar: 'عمود الحالة (اختياري)', en: 'Status column (optional)' })}</span><input id="f-statusColumn" value={map.statusColumn} onChange={set('statusColumn')} /></label>
          <label className="check field"><input type="checkbox" checked={map.decimalComma} onChange={set('decimalComma')} />{tr({ ar: 'الفاصلة العشرية فاصلة (1.234,50)', en: 'Decimal comma (1.234,50)' })}</label>
        </>}
      </div>
      <div className="form-actions"><Button variant="secondary" disabled={!file || busy} onClick={read}>{tr({ ar: 'قراءة الملف ومعاينته', en: 'Read and preview' })}</Button></div>
      <ErrorBox error={err ?? create.error} />
      {parsed && <>
        {parsed.columns && <p className="small muted">{tr({ ar: 'أعمدة الملف', en: 'File columns' })}: {parsed.columns.join(' · ')}</p>}
        <Notice kind={parsed.skipped.length ? 'warning' : 'success'}>
          {tr({ ar: `أسطر مقروءة: ${parsed.lines.length} · متجاهلة: ${parsed.skipped.length}`, en: `Lines read: ${parsed.lines.length} · skipped: ${parsed.skipped.length}` })}
        </Notice>
        {parsed.skipped.length > 0 && <ul className="small" data-testid="skipped">{parsed.skipped.slice(0, 20).map((s) => <li key={s.row}>{tr({ ar: 'سطر', en: 'Row' })} {s.row}: {s.reason}</li>)}</ul>}
        <DataTable rowKey="externalRef" rows={parsed.lines.slice(0, 50)} columns={[
          { key: 'externalRef', label: { ar: 'المرجع', en: 'Reference' } }, { key: 'kind', label: { ar: 'النوع', en: 'Type' } },
          { key: 'amount', label: { ar: 'المبلغ', en: 'Amount' } }, { key: 'currency', label: { ar: 'العملة', en: 'Currency' } }, { key: 'status', label: { ar: 'الحالة', en: 'Status' } },
        ]} />
        {parsed.lines.length > 0 && (
          <Form busy={create.isPending} submitLabel={tr({ ar: 'إنشاء المطابقة', en: 'Create reconciliation' })} fields={[
            { name: 'countryId', label: { ar: 'الدولة', en: 'Country' }, type: 'select', required: true, options: countries },
            { name: 'integrationId', label: { ar: 'مزود الدفع', en: 'Payment provider' }, type: 'select', options: integrations },
            { name: 'accountId', label: { ar: 'أو الصندوق/الحساب البنكي', en: 'or fund / bank account' }, type: 'select', options: funds },
            { name: 'periodFrom', label: { ar: 'من', en: 'From' }, type: 'date', required: true },
            { name: 'periodTo', label: { ar: 'إلى', en: 'To' }, type: 'date', required: true },
            { name: 'sourceName', label: { ar: 'اسم الكشف', en: 'Statement name' }, required: true, defaultValue: file?.name },
          ]} onSubmit={(v) => create.mutate(v, { onSuccess: (r) => { window.location.href = `/reconciliation/${r.id}`; } })} />
        )}
      </>}
    </Card>
  );
}
