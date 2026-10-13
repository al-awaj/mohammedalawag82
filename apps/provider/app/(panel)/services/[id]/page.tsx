'use client';
import { use, useState } from 'react';
import { localized } from '@events/shared';
import { useAction, useApp, useGet, useTr } from '@events/web-kit/client';
import { ActionButton, Badge, Card, DataTable, ErrorBox, Form, Loading, Money, Notice, Page, Tabs, Text, type FieldSpec } from '@events/web-kit/ui';
import { attributeFields, splitAttributes } from '@/lib/fields';
import { serviceFields, type Package, type RentalItem, type Service, type ServiceType } from '@/lib/service-form';
import { useCurrencyOptions, usePolicyOptions } from '@/lib/options';

type Tab = 'details' | 'media' | 'packages' | 'rental' | 'availability';
const CONDITIONS = [
  { value: 'new', label: { ar: 'جديد', en: 'New' } }, { value: 'excellent', label: { ar: 'ممتاز', en: 'Excellent' } },
  { value: 'good', label: { ar: 'جيد', en: 'Good' } }, { value: 'fair', label: { ar: 'مقبول', en: 'Fair' } },
];
const WEEKDAYS = [
  { ar: 'الأحد', en: 'Sunday' }, { ar: 'الاثنين', en: 'Monday' }, { ar: 'الثلاثاء', en: 'Tuesday' }, { ar: 'الأربعاء', en: 'Wednesday' },
  { ar: 'الخميس', en: 'Thursday' }, { ar: 'الجمعة', en: 'Friday' }, { ar: 'السبت', en: 'Saturday' },
];

export default function ServicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const tr = useTr();
  const { lang } = useApp();
  const [tab, setTab] = useState<Tab>('details');
  const { data: s, error, isLoading } = useGet<Service>(`/v1/provider/services/${id}`);
  const types = useGet<ServiceType[]>('/v1/provider/service-types').data;
  const type = types?.find((t) => t.id === s?.serviceTypeId);
  if (isLoading) return <Loading />;
  if (error || !s) return <ErrorBox error={error} />;
  const canSubmit = ['draft', 'unpublished'].includes(s.status);
  return (
    <Page title={localized(s.title, lang)} actions={<>
      {canSubmit && <ActionButton variant="primary" label={tr({ ar: 'إرسال للمراجعة والنشر', en: 'Submit for review' })} run={(api) => api.post(`/v1/provider/services/${id}/submit`)} />}
      {s.status === 'published' && <ActionButton label={tr({ ar: 'إيقاف النشر', en: 'Unpublish' })} run={(api) => api.post(`/v1/provider/services/${id}/unpublish`)} />}
    </>}>
      <div className="row gap" style={{ marginBottom: 12 }}>
        <Badge group="service" value={s.status} />
        {s.statusReason && <span className="muted">{s.statusReason}</span>}
        <span className="muted"><Text value={s.typeName} /></span>
      </div>
      {s.status === 'published' && <Notice>{tr({ ar: 'تعديل خدمة منشورة لا يغير الحجوزات السابقة؛ كل حجز يحتفظ بالسعر والشروط وقت إنشائه.', en: 'Editing a published service never changes past bookings; each booking keeps the price and terms it was made with.' })}</Notice>}
      <Tabs value={tab} onChange={setTab} tabs={[
        { id: 'details', label: tr({ ar: 'البيانات', en: 'Details' }) },
        { id: 'media', label: tr({ ar: 'الصور والفيديو', en: 'Photos & video' }) },
        ...(type?.allowsPackages !== false ? [{ id: 'packages' as Tab, label: tr({ ar: 'الباقات', en: 'Packages' }) }] : []),
        ...(s.bookingMode === 'quantity_rental' ? [{ id: 'rental' as Tab, label: tr({ ar: 'عناصر التأجير', en: 'Rental items' }) }] : []),
        { id: 'availability', label: tr({ ar: 'أوقات العمل', en: 'Working hours' }) },
      ]} />
      {tab === 'details' && type && <Details s={s} type={type} />}
      {tab === 'media' && <Media s={s} max={type?.maxImages} video={type?.allowsVideo} />}
      {tab === 'packages' && <Packages s={s} units={type?.pricingUnits ?? ['fixed']} />}
      {tab === 'rental' && <Rental s={s} />}
      {tab === 'availability' && <Availability id={id} mode={s.bookingMode} />}
    </Page>
  );
}

function Details({ s, type }: { s: Service; type: ServiceType }) {
  const tr = useTr();
  const currencies = useCurrencyOptions();
  const policies = usePolicyOptions();
  const save = useAction((api, v: Record<string, unknown>) => api.patch(`/v1/provider/services/${s.id}`, v));
  return (
    <Card>
      <ErrorBox error={save.error} />
      {save.isSuccess && <Notice kind="success">{tr({ ar: 'تم الحفظ', en: 'Saved' })}</Notice>}
      <Form key={s.id} busy={save.isPending} fields={[...serviceFields(type, s, currencies, policies), ...attributeFields(type.fields, s.attributes)]}
        onSubmit={(v) => save.mutate(splitAttributes(v))} />
    </Card>
  );
}

function Media({ s, max, video }: { s: Service; max?: number; video?: boolean }) {
  const tr = useTr();
  const remove = useAction((api, mid: string) => api.del(`/v1/provider/media/${mid}`));
  const packages = s.packages.map((p) => ({ value: p.id, label: { ar: p.name.ar ?? p.name.en ?? '', en: p.name.en ?? p.name.ar ?? '' } }));
  return (
    <Card actions={
      <ActionButton variant="primary" label={tr({ ar: 'رفع صورة أو فيديو', en: 'Upload photo or video' })} fields={[
        { name: 'isPastWork', label: { ar: 'من أعمال سابقة', en: 'Past work' }, type: 'checkbox' },
        ...(packages.length ? [{ name: 'packageId', label: { ar: 'خاصة بباقة (اختياري)', en: 'For a package (optional)' }, type: 'select', options: packages } as FieldSpec] : []),
        { name: 'file', label: video ? { ar: 'صورة (PNG/JPEG/WebP) أو فيديو MP4', en: 'Image (PNG/JPEG/WebP) or MP4 video' } : { ar: 'صورة (PNG/JPEG/WebP)', en: 'Image (PNG/JPEG/WebP)' }, type: 'file', required: true },
      ]} run={(api, v) => { const f = new FormData(); f.append('isPastWork', v.isPastWork ? 'true' : 'false'); if (v.packageId) f.append('packageId', String(v.packageId)); f.append('file', v.file as File); return api.upload(`/v1/provider/services/${s.id}/media`, f); }} />
    }>
      <p className="muted">{tr({ ar: `الحد الأقصى ${max ?? '—'} صورة.`, en: `Up to ${max ?? '—'} images.` })}</p>
      <ErrorBox error={remove.error} />
      <div className="grid">
        {s.media.map((m) => (
          <div key={m.id} className="card">
            {m.kind === 'image' ? <img src={`/bff/v1/media/${m.id}`} alt="" style={{ width: '100%', height: 150, objectFit: 'cover', borderRadius: 8 }} />
              : <video src={`/bff/v1/media/${m.id}`} controls style={{ width: '100%', maxHeight: 150 }} />}
            <div className="row between small">
              <span>{m.isPastWork ? tr({ ar: 'أعمال سابقة', en: 'Past work' }) : ''} {m.packageId && <Text value={s.packages.find((p) => p.id === m.packageId)?.name} />}</span>
              <div className="row gap">
                <ActionButton variant="ghost" label={tr({ ar: 'تعديل', en: 'Edit' })} fields={[
                  { name: 'caption', label: { ar: 'الوصف', en: 'Caption' }, type: 'i18n', defaultValue: m.caption ?? undefined },
                  { name: 'isPastWork', label: { ar: 'من أعمال سابقة', en: 'Past work' }, type: 'checkbox', defaultValue: m.isPastWork },
                  { name: 'sortOrder', label: { ar: 'الترتيب', en: 'Order' }, type: 'number', defaultValue: m.sortOrder },
                  ...(packages.length ? [{ name: 'packageId', label: { ar: 'خاصة بباقة', en: 'For a package' }, type: 'select', options: packages, defaultValue: m.packageId ?? '' } as FieldSpec] : []),
                ]} run={(api, v) => api.patch(`/v1/provider/media/${m.id}`, packages.length ? { ...v, packageId: v.packageId ?? null } : v)} />
                <button type="button" className="btn btn-ghost" onClick={() => remove.mutate(m.id)}>{tr({ ar: 'حذف', en: 'Delete' })}</button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

const lines = (v: unknown) => String(v ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
const DEPOSIT_TYPES = [
  { value: 'none', label: { ar: 'بدون عربون', en: 'No deposit' } }, { value: 'fixed', label: { ar: 'مبلغ ثابت', en: 'Fixed amount' } },
  { value: 'percent', label: { ar: 'نسبة من السعر', en: 'Percent of price' } },
];

/** Package form: inclusions one per line, add-ons as "code | Arabic name | English name | price" lines. */
function packageFields(units: string[], p?: Package): FieldSpec[] {
  return [
    { name: 'name', label: { ar: 'اسم الباقة', en: 'Package name' }, type: 'i18n', required: true, defaultValue: p?.name },
    { name: 'description', label: { ar: 'الوصف', en: 'Description' }, type: 'i18n', defaultValue: p?.description ?? undefined },
    { name: 'price', label: { ar: 'السعر', en: 'Price' }, type: 'decimal', required: true, defaultValue: p?.price },
    { name: 'currency', label: { ar: 'العملة', en: 'Currency' }, required: true, defaultValue: p?.currency ?? 'SAR' },
    { name: 'pricingUnit', label: { ar: 'طريقة التسعير', en: 'Pricing unit' }, type: 'select', required: true, options: units.map((u) => ({ value: u, label: u })), defaultValue: p?.pricingUnit ?? units[0] },
    { name: 'durationMinutes', label: { ar: 'المدة بالدقائق (اختياري)', en: 'Duration in minutes (optional)' }, type: 'number', defaultValue: p?.durationMinutes ?? undefined },
    { name: 'inclusionsAr', label: { ar: 'ما تشمله الباقة بالعربية (سطر لكل بند)', en: 'Inclusions in Arabic (one per line)' }, type: 'textarea', defaultValue: p?.inclusions.map((i) => i.ar ?? '').join('\n') },
    { name: 'inclusionsEn', label: { ar: 'ما تشمله الباقة بالإنجليزية (بنفس الترتيب)', en: 'Inclusions in English (same order)' }, type: 'textarea', defaultValue: p?.inclusions.map((i) => i.en ?? '').join('\n') },
    { name: 'addOns', label: { ar: 'الإضافات: سطر لكل إضافة', en: 'Add-ons: one per line' }, type: 'textarea',
      help: { ar: 'الرمز | الاسم بالعربية | الاسم بالإنجليزية | السعر — مثال: dj | دي جي | DJ | 1500', en: 'code | Arabic name | English name | price — e.g. dj | دي جي | DJ | 1500' },
      defaultValue: p?.addOns.map((a) => [a.code, a.name.ar ?? '', a.name.en ?? '', a.price].join(' | ')).join('\n') },
    { name: 'terms', label: { ar: 'شروط الباقة', en: 'Package terms' }, type: 'i18n', defaultValue: p?.terms ?? undefined },
    { name: 'availableWeekdays', label: { ar: 'الأيام المتاحة', en: 'Available days' }, type: 'multiselect',
      options: WEEKDAYS.map((d, i) => ({ value: String(i), label: d })), defaultValue: (p?.availableWeekdays ?? [0, 1, 2, 3, 4, 5, 6]).map(String) },
    { name: 'maxBookingsPerSlot', label: { ar: 'أقصى عدد حجوزات في نفس الموعد', en: 'Max bookings per slot' }, type: 'number', defaultValue: p?.maxBookingsPerSlot ?? 1 },
    { name: 'depositType', label: { ar: 'العربون', en: 'Deposit' }, type: 'select', options: DEPOSIT_TYPES, defaultValue: p?.depositType ?? 'none' },
    { name: 'depositValue', label: { ar: 'قيمة العربون (مبلغ أو نسبة)', en: 'Deposit value (amount or percent)' }, type: 'decimal', defaultValue: p?.depositValue ?? '0' },
    { name: 'balanceDueDaysBefore', label: { ar: 'استحقاق المتبقي قبل الموعد بـ (أيام)', en: 'Balance due (days before)' }, type: 'number', defaultValue: p?.balanceDueDaysBefore ?? 0 },
    { name: 'validFrom', label: { ar: 'متاحة من تاريخ', en: 'Valid from' }, type: 'date', defaultValue: p?.validFrom?.slice(0, 10) ?? undefined },
    { name: 'validTo', label: { ar: 'متاحة حتى تاريخ', en: 'Valid to' }, type: 'date', defaultValue: p?.validTo?.slice(0, 10) ?? undefined },
    { name: 'sortOrder', label: { ar: 'ترتيب العرض', en: 'Display order' }, type: 'number', defaultValue: p?.sortOrder ?? 0 },
    { name: 'status', label: { ar: 'الحالة', en: 'Status' }, type: 'select', options: [{ value: 'active', label: { ar: 'مفعّلة', en: 'Active' } }, { value: 'inactive', label: { ar: 'موقوفة', en: 'Inactive' } }], defaultValue: p?.status ?? 'active' },
  ];
}

/** Turns the package form into the API body; a malformed add-on line is reported instead of being dropped. */
function packageBody(v: Record<string, unknown>) {
  const { inclusionsAr, inclusionsEn, addOns, availableWeekdays, ...rest } = v;
  const ar = lines(inclusionsAr);
  const en = lines(inclusionsEn);
  const inclusions = Array.from({ length: Math.max(ar.length, en.length) }, (_, i) => ({ ...(ar[i] ? { ar: ar[i] } : {}), ...(en[i] ? { en: en[i] } : {}) }));
  const parsed = lines(addOns).map((l) => {
    const [code, nameAr, nameEn, price] = l.split('|').map((x) => x.trim());
    if (!code || !price || !(nameAr || nameEn)) throw new Error(`Add-on line not understood: "${l}"`);
    return { code, name: { ...(nameAr ? { ar: nameAr } : {}), ...(nameEn ? { en: nameEn } : {}) }, price };
  });
  return {
    ...rest, inclusions, addOns: parsed,
    durationMinutes: rest.durationMinutes ?? null, terms: rest.terms ?? null, description: rest.description ?? null,
    validFrom: rest.validFrom ?? null, validTo: rest.validTo ?? null,
    availableWeekdays: ((availableWeekdays as string[] | undefined) ?? []).map(Number),
  };
}

function Packages({ s, units }: { s: Service; units: string[] }) {
  const tr = useTr();
  return (
    <Card actions={<ActionButton variant="primary" label={tr({ ar: 'باقة جديدة', en: 'New package' })} fields={packageFields(units)} run={(api, v) => api.post(`/v1/provider/services/${s.id}/packages`, packageBody(v))} />}>
      <DataTable rows={s.packages} columns={[
        { key: 'name', label: { ar: 'الباقة', en: 'Package' }, render: (p) => <Text value={p.name} /> },
        { key: 'price', label: { ar: 'السعر', en: 'Price' }, render: (p) => <Money amount={p.price} currency={p.currency} /> },
        { key: 'days', label: { ar: 'الأيام', en: 'Days' }, render: (p) => p.availableWeekdays.length === 7 ? tr({ ar: 'كل الأيام', en: 'Every day' }) : p.availableWeekdays.map((d) => tr(WEEKDAYS[d]!)).join('، ') },
        { key: 'addOns', label: { ar: 'الإضافات', en: 'Add-ons' }, render: (p) => p.addOns.length },
        { key: 'images', label: { ar: 'الصور', en: 'Images' }, render: (p) => s.media.filter((m) => m.packageId === p.id).length },
        { key: 'status', label: { ar: 'الحالة', en: 'Status' } },
        { key: 'edit', label: '', render: (p) => <ActionButton label={tr({ ar: 'تعديل', en: 'Edit' })} fields={packageFields(units, p)} run={(api, v) => api.patch(`/v1/provider/packages/${p.id}`, packageBody(v))} /> },
      ]} />
    </Card>
  );
}

function Rental({ s }: { s: Service }) {
  const tr = useTr();
  const fields = (r?: RentalItem): FieldSpec[] => [
    ...(r ? [] : [{ name: 'sku', label: { ar: 'رمز العنصر', en: 'SKU' }, required: true } as FieldSpec]),
    { name: 'name', label: { ar: 'الاسم', en: 'Name' }, type: 'i18n', required: true, defaultValue: r?.name },
    { name: 'quantityTotal', label: { ar: 'الكمية المتاحة', en: 'Quantity' }, type: 'number', required: true, defaultValue: r?.quantityTotal },
    { name: 'pricePerDay', label: { ar: 'السعر اليومي', en: 'Price per day' }, type: 'decimal', required: true, defaultValue: r?.pricePerDay },
    { name: 'pricePerPeriod', label: { ar: 'سعر الفترة (اختياري)', en: 'Price per period (optional)' }, type: 'decimal', defaultValue: r?.pricePerPeriod ?? undefined },
    { name: 'periodDays', label: { ar: 'طول الفترة بالأيام', en: 'Period length in days' }, type: 'number', defaultValue: r?.periodDays ?? undefined },
    { name: 'currency', label: { ar: 'العملة', en: 'Currency' }, required: true, defaultValue: r?.currency ?? 'SAR' },
    { name: 'securityDeposit', label: { ar: 'التأمين المسترد', en: 'Security deposit' }, type: 'decimal', defaultValue: r?.securityDeposit ?? '0' },
    { name: 'lateFeePerDay', label: { ar: 'غرامة التأخير لكل يوم', en: 'Late fee per day' }, type: 'decimal', defaultValue: r?.lateFeePerDay ?? '0' },
    { name: 'damageTerms', label: { ar: 'شروط التلف والفقد', en: 'Damage and loss terms' }, type: 'i18n', defaultValue: r?.damageTerms ?? undefined },
    { name: 'condition', label: { ar: 'الحالة', en: 'Condition' }, type: 'select', options: CONDITIONS, defaultValue: r?.condition ?? 'good' },
    { name: 'attributes', label: { ar: 'المواصفات: سطر لكل صفة', en: 'Specifications: one per line' }, type: 'textarea',
      help: { ar: 'المفتاح = القيمة — مثال: color = أبيض', en: 'key = value — e.g. color = white' },
      defaultValue: Object.entries(r?.attributes ?? {}).map(([k, x]) => `${k} = ${x}`).join('\n') },
    { name: 'status', label: { ar: 'متاح للحجز', en: 'Bookable' }, type: 'select', options: [{ value: 'active', label: { ar: 'مفعّل', en: 'Active' } }, { value: 'inactive', label: { ar: 'موقوف', en: 'Inactive' } }], defaultValue: r?.status ?? 'active' },
  ];
  const body = (v: Record<string, unknown>) => ({
    ...v,
    pricePerPeriod: v.pricePerPeriod ?? null, periodDays: v.periodDays ?? null, damageTerms: v.damageTerms ?? null,
    attributes: Object.fromEntries(lines(v.attributes).map((l) => {
      const at = l.indexOf('=');
      if (at < 1) throw new Error(`Specification line not understood: "${l}"`);
      const key = l.slice(0, at).trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_');
      const raw = l.slice(at + 1).trim();
      return [key, /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw];
    })),
  });
  return (
    <Card actions={<ActionButton variant="primary" label={tr({ ar: 'عنصر جديد', en: 'New item' })} fields={fields()} run={(api, v) => api.post(`/v1/provider/services/${s.id}/rental-items`, body(v))} />}>
      <DataTable rows={s.rentalItems} columns={[
        { key: 'name', label: { ar: 'العنصر', en: 'Item' }, render: (r) => <Text value={r.name} /> },
        { key: 'sku', label: 'SKU' },
        { key: 'quantityTotal', label: { ar: 'الكمية', en: 'Quantity' } },
        { key: 'pricePerDay', label: { ar: 'اليومي', en: 'Per day' }, render: (r) => <Money amount={r.pricePerDay} currency={r.currency} /> },
        { key: 'condition', label: { ar: 'الحالة الفنية', en: 'Condition' }, render: (r) => tr(CONDITIONS.find((c) => c.value === r.condition)?.label ?? { ar: r.condition, en: r.condition }) },
        { key: 'status', label: { ar: 'الحالة', en: 'Status' } },
        { key: 'edit', label: '', render: (r) => <ActionButton label={tr({ ar: 'تعديل', en: 'Edit' })} fields={fields(r)} run={(api, v) => api.patch(`/v1/provider/rental-items/${r.id}`, body(v))} /> },
      ]} />
    </Card>
  );
}

type Rule = { weekday: number; start: string; end: string };
function Availability({ id, mode }: { id: string; mode: string }) {
  const tr = useTr();
  const { lang } = useApp();
  const { data, error, isLoading } = useGet<Rule[]>(`/v1/provider/services/${id}/availability-rules`);
  const [rules, setRules] = useState<Rule[] | null>(null);
  const save = useAction((api, r: Rule[]) => api.put(`/v1/provider/services/${id}/availability-rules`, { rules: r }));
  if (isLoading) return <Loading />;
  const list = rules ?? data ?? [];
  const set = (i: number, patch: Partial<Rule>) => setRules(list.map((r, j) => (i === j ? { ...r, ...patch } : r)));
  return (
    <Card title={tr({ ar: 'أوقات العمل الأسبوعية', en: 'Weekly working hours' })}>
      <Notice>{mode === 'time_slot'
        ? tr({ ar: 'تُعرض المواعيد المتاحة للعملاء داخل هذه الأوقات فقط.', en: 'Customers see available slots within these hours only.' })
        : tr({ ar: 'بدون قواعد تكون كل الأيام متاحة ما لم تُغلق من التقويم.', en: 'With no rules every day is open unless closed in the calendar.' })}</Notice>
      <ErrorBox error={error ?? save.error} />
      {save.isSuccess && <Notice kind="success">{tr({ ar: 'تم الحفظ', en: 'Saved' })}</Notice>}
      <table className="table">
        <thead><tr><th>{tr({ ar: 'اليوم', en: 'Day' })}</th><th>{tr({ ar: 'من', en: 'From' })}</th><th>{tr({ ar: 'إلى', en: 'To' })}</th><th /></tr></thead>
        <tbody>
          {list.map((r, i) => (
            <tr key={i}>
              <td><select value={r.weekday} onChange={(e) => set(i, { weekday: Number(e.target.value) })}>{WEEKDAYS.map((d, n) => <option key={n} value={n}>{d[lang]}</option>)}</select></td>
              <td><input type="time" value={r.start.slice(0, 5)} onChange={(e) => set(i, { start: e.target.value })} /></td>
              <td><input type="time" value={r.end.slice(0, 5)} onChange={(e) => set(i, { end: e.target.value })} /></td>
              <td><button type="button" className="btn btn-ghost" onClick={() => setRules(list.filter((_, j) => j !== i))}>×</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row gap" style={{ marginTop: 12 }}>
        <button type="button" className="btn btn-secondary" onClick={() => setRules([...list, { weekday: 4, start: '16:00', end: '23:59' }])}>{tr({ ar: 'إضافة فترة', en: 'Add period' })}</button>
        <button type="button" className="btn btn-primary" disabled={save.isPending} onClick={() => save.mutate(list.map((r) => ({ ...r, start: r.start.slice(0, 5), end: r.end.slice(0, 5) })))}>{tr({ ar: 'حفظ', en: 'Save' })}</button>
      </div>
    </Card>
  );
}
