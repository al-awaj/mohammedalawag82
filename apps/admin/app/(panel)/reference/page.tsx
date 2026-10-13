'use client';
import { useState } from 'react';
import { useCan, useGet, useTr } from '@events/web-kit/client';
import { ActionButton, DataTable, DateTime, ErrorBox, Loading, Notice, Page, reasonField, Tabs, Text, type FieldSpec } from '@events/web-kit/ui';
import { raw, useCountries } from '@/lib/util';

type Country = { id: string; code: string; name: Record<string, string>; baseCurrency: string; timezone: string; defaultLanguage: string; phonePrefix: string; isActive: boolean; currencies: string[]; taxSettings: Record<string, unknown>; invoiceSettings: Record<string, unknown> };
type Currency = { code: string; name: Record<string, string>; symbol: string; minorUnits: number; isActive: boolean };
type Rate = { id: string; base: string; quote: string; rate: string; effectiveAt: string; source: string; enteredBy: string };

export default function Reference() {
  const tr = useTr();
  const can = useCan();
  const tabs = [
    ...(can('countries.manage') ? [{ id: 'countries' as const, label: tr({ ar: 'الدول', en: 'Countries' }) }] : []),
    ...(can('currencies.manage') ? [{ id: 'currencies' as const, label: tr({ ar: 'العملات', en: 'Currencies' }) }] : []),
    ...(can('exchange_rates.manage') ? [{ id: 'rates' as const, label: tr({ ar: 'أسعار الصرف', en: 'Exchange rates' }) }] : []),
    ...(can('terms.manage') ? [{ id: 'terms' as const, label: tr({ ar: 'الشروط والسياسات', en: 'Terms & policies' }) }] : []),
  ];
  const [tab, setTab] = useState(tabs[0]?.id ?? 'countries');
  return (
    <Page title={tr({ ar: 'الدول والعملات والشروط', en: 'Countries, currencies, terms' })}>
      <Tabs value={tab} onChange={setTab} tabs={tabs} />
      {tab === 'countries' ? <Countries /> : tab === 'currencies' ? <Currencies /> : tab === 'rates' ? <Rates /> : <Terms />}
    </Page>
  );
}

function countryFields(c?: Country): FieldSpec[] {
  return [
    ...(c ? [] : [{ name: 'code', label: { ar: 'رمز الدولة (حرفان)', en: 'Country code (2 letters)' }, required: true } as FieldSpec]),
    { name: 'name', label: { ar: 'الاسم', en: 'Name' }, type: 'i18n', required: true, defaultValue: c?.name },
    { name: 'baseCurrency', label: { ar: 'العملة الأساسية', en: 'Base currency' }, required: true, defaultValue: c?.baseCurrency },
    { name: 'currencies', label: { ar: 'العملات المسموحة (مفصولة بفواصل)', en: 'Allowed currencies (comma separated)' }, defaultValue: c?.currencies.join(',') },
    { name: 'timezone', label: { ar: 'المنطقة الزمنية', en: 'Time zone' }, required: true, defaultValue: c?.timezone ?? 'Asia/Riyadh' },
    { name: 'defaultLanguage', label: { ar: 'اللغة الافتراضية', en: 'Default language' }, type: 'select', required: true, options: raw('ar', 'en'), defaultValue: c?.defaultLanguage ?? 'ar' },
    { name: 'phonePrefix', label: { ar: 'مفتاح الاتصال', en: 'Phone prefix' }, required: true, defaultValue: c?.phonePrefix },
    { name: 'taxSettings', label: { ar: 'إعدادات الضريبة (JSON)', en: 'Tax settings (JSON)' }, type: 'json', defaultValue: c?.taxSettings ?? {},
      help: { ar: '{"rate":"15","label":{"ar":"…","en":"…"},"pricesIncludeTax":true} — يظهر سطر الضريبة فقط إذا كانت شاملة في السعر', en: '{"rate":"15","label":{…},"pricesIncludeTax":true} — the tax line shows only for tax-inclusive prices' } },
    { name: 'invoiceSettings', label: { ar: 'بيانات المُصدر على المستندات (JSON)', en: 'Issuer details on documents (JSON)' }, type: 'json', defaultValue: c?.invoiceSettings ?? {} },
    { name: 'isActive', label: { ar: 'مفعّلة', en: 'Active' }, type: 'checkbox', defaultValue: c?.isActive ?? false },
    ...(c ? [reasonField(false)] : []),
  ];
}
const splitCurrencies = (v: Record<string, unknown>) => ({ ...v, ...(typeof v.currencies === 'string' ? { currencies: v.currencies.split(/[,\s]+/).filter(Boolean).map((x) => x.toUpperCase()) } : {}) });

function Countries() {
  const tr = useTr();
  const { data, error, isLoading } = useGet<Country[]>('/v1/admin/countries');
  if (isLoading) return <Loading />;
  return (
    <>
      <div className="page-actions" style={{ marginBottom: 12 }}>
        <ActionButton variant="primary" label={tr({ ar: 'دولة جديدة', en: 'New country' })} fields={countryFields()} run={(api, v) => api.post('/v1/admin/countries', splitCurrencies(v))} />
      </div>
      <ErrorBox error={error} />
      <DataTable rows={data ?? []} columns={[
        { key: 'code', label: { ar: 'الرمز', en: 'Code' } },
        { key: 'name', label: { ar: 'الاسم', en: 'Name' }, render: (c) => <Text value={c.name} /> },
        { key: 'baseCurrency', label: { ar: 'العملة', en: 'Currency' } },
        { key: 'currencies', label: { ar: 'العملات', en: 'Currencies' }, render: (c) => c.currencies.join(', ') },
        { key: 'timezone', label: { ar: 'المنطقة الزمنية', en: 'Time zone' } },
        { key: 'isActive', label: { ar: 'مفعّلة', en: 'Active' } },
        { key: 'edit', label: '', render: (c) => <ActionButton label={tr({ ar: 'تعديل', en: 'Edit' })} fields={countryFields(c)} run={(api, v) => api.patch(`/v1/admin/countries/${c.id}`, splitCurrencies(v))} /> },
      ]} />
    </>
  );
}

function Currencies() {
  const tr = useTr();
  const { data, error, isLoading } = useGet<Currency[]>('/v1/admin/currencies');
  if (isLoading) return <Loading />;
  return (
    <>
      <div className="page-actions" style={{ marginBottom: 12 }}>
        <ActionButton variant="primary" label={tr({ ar: 'عملة جديدة', en: 'New currency' })} fields={[
          { name: 'code', label: { ar: 'الرمز', en: 'Code' }, required: true }, { name: 'name', label: { ar: 'الاسم', en: 'Name' }, type: 'i18n', required: true },
          { name: 'symbol', label: { ar: 'الرمز المختصر', en: 'Symbol' }, required: true }, { name: 'minorUnits', label: { ar: 'عدد الخانات العشرية', en: 'Minor units' }, type: 'number', required: true, defaultValue: 2 },
        ]} run={(api, v) => api.post('/v1/admin/currencies', v)} />
      </div>
      <ErrorBox error={error} />
      <DataTable rowKey="code" rows={data ?? []} columns={[
        { key: 'code', label: { ar: 'الرمز', en: 'Code' } }, { key: 'name', label: { ar: 'الاسم', en: 'Name' }, render: (c) => <Text value={c.name} /> },
        { key: 'symbol', label: { ar: 'الرمز المختصر', en: 'Symbol' } }, { key: 'minorUnits', label: { ar: 'الخانات', en: 'Minor units' } },
        { key: 'isActive', label: { ar: 'مفعّلة', en: 'Active' } },
        { key: 'toggle', label: '', render: (c) => <ActionButton label={c.isActive ? tr({ ar: 'تعطيل', en: 'Disable' }) : tr({ ar: 'تفعيل', en: 'Enable' })} run={(api) => api.patch(`/v1/admin/currencies/${c.code}`, { isActive: !c.isActive })} /> },
      ]} />
    </>
  );
}

function Rates() {
  const tr = useTr();
  const { data, error, isLoading } = useGet<Rate[]>('/v1/admin/exchange-rates', { limit: 200 });
  if (isLoading) return <Loading />;
  return (
    <>
      <Notice>{tr({ ar: 'كل سعر سجل مؤرخ لا يُعدل؛ السعر الجديد يُضاف بتاريخ سريانه، والتقارير تستخدم السعر الساري في تاريخها.', en: 'Each rate is a dated record that is never edited; a new rate is added with its effective date and reports use the rate in force on their date.' })}</Notice>
      <div className="page-actions" style={{ marginBottom: 12 }}>
        <ActionButton variant="primary" label={tr({ ar: 'سعر جديد', en: 'New rate' })} fields={[
          { name: 'base', label: { ar: 'من عملة', en: 'Base' }, required: true }, { name: 'quote', label: { ar: 'إلى عملة', en: 'Quote' }, required: true },
          { name: 'rate', label: { ar: 'السعر', en: 'Rate' }, type: 'decimal', required: true },
          { name: 'effectiveAt', label: { ar: 'ساري من', en: 'Effective from' }, type: 'datetime' },
          { name: 'source', label: { ar: 'المصدر', en: 'Source' }, required: true },
        ]} run={(api, v) => api.post('/v1/admin/exchange-rates', { ...v, base: String(v.base).toUpperCase(), quote: String(v.quote).toUpperCase() })} />
      </div>
      <ErrorBox error={error} />
      <DataTable rows={data ?? []} columns={[
        { key: 'pair', label: { ar: 'الزوج', en: 'Pair' }, render: (r) => `${r.base}/${r.quote}` },
        { key: 'rate', label: { ar: 'السعر', en: 'Rate' }, render: (r) => <span className="num">{r.rate}</span> },
        { key: 'effectiveAt', label: { ar: 'ساري من', en: 'Effective' }, render: (r) => <DateTime value={r.effectiveAt} /> },
        { key: 'source', label: { ar: 'المصدر', en: 'Source' } },
      ]} />
    </>
  );
}

function Terms() {
  const tr = useTr();
  const countries = useCountries();
  return (
    <>
      <Notice>{tr({ ar: 'كل نسخة تُنشر كإصدار جديد ولا تُعدل النسخ المنشورة. موافقات المستخدمين مرتبطة برقم الإصدار.', en: 'Each version is published as new; published versions never change. User acceptances are tied to the version.' })}</Notice>
      <ActionButton variant="primary" label={tr({ ar: 'نشر إصدار جديد', en: 'Publish a new version' })} fields={[
        { name: 'kind', label: { ar: 'النوع', en: 'Kind' }, type: 'select', required: true, options: [
          { value: 'customer_terms', label: { ar: 'شروط العملاء', en: 'Customer terms' } }, { value: 'provider_terms', label: { ar: 'شروط أصحاب الخدمات', en: 'Provider terms' } },
          { value: 'privacy_policy', label: { ar: 'سياسة الخصوصية', en: 'Privacy policy' } }] },
        { name: 'countryId', label: { ar: 'الدولة', en: 'Country' }, type: 'select', options: countries.options },
        { name: 'version', label: { ar: 'رقم الإصدار', en: 'Version' }, required: true },
        { name: 'content', label: { ar: 'النص', en: 'Content' }, type: 'i18n', required: true },
      ]} run={(api, v) => api.post('/v1/admin/terms', v)} />
    </>
  );
}
