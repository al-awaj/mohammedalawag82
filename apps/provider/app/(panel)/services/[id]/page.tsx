'use client';
import { use, useState } from 'react';
import { localized } from '@events/shared';
import { useAction, useApp, useGet, useTr } from '@events/web-kit/client';
import { ActionButton, Badge, Card, DataTable, ErrorBox, Form, Loading, Money, Notice, Page, Tabs, Text } from '@events/web-kit/ui';
import { attributeFields, splitAttributes } from '@/lib/fields';
import { serviceFields, type Service, type ServiceType } from '@/lib/service-form';
import { useCurrencyOptions, usePolicyOptions } from '@/lib/options';

type Tab = 'details' | 'media' | 'packages' | 'rental' | 'availability';
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
  return (
    <Card actions={
      <ActionButton variant="primary" label={tr({ ar: 'رفع صورة أو فيديو', en: 'Upload photo or video' })} fields={[
        { name: 'isPastWork', label: { ar: 'من أعمال سابقة', en: 'Past work' }, type: 'checkbox' },
        { name: 'file', label: video ? { ar: 'صورة (PNG/JPEG/WebP) أو فيديو MP4', en: 'Image (PNG/JPEG/WebP) or MP4 video' } : { ar: 'صورة (PNG/JPEG/WebP)', en: 'Image (PNG/JPEG/WebP)' }, type: 'file', required: true },
      ]} run={(api, v) => { const f = new FormData(); f.append('isPastWork', v.isPastWork ? 'true' : 'false'); f.append('file', v.file as File); return api.upload(`/v1/provider/services/${s.id}/media`, f); }} />
    }>
      <p className="muted">{tr({ ar: `الحد الأقصى ${max ?? '—'} صورة.`, en: `Up to ${max ?? '—'} images.` })}</p>
      <ErrorBox error={remove.error} />
      <div className="grid">
        {s.media.map((m) => (
          <div key={m.id} className="card">
            {m.kind === 'image' ? <img src={`/bff/v1/media/${m.id}`} alt="" style={{ width: '100%', height: 150, objectFit: 'cover', borderRadius: 8 }} />
              : <video src={`/bff/v1/media/${m.id}`} controls style={{ width: '100%', maxHeight: 150 }} />}
            <div className="row between small">
              <span>{m.isPastWork ? tr({ ar: 'أعمال سابقة', en: 'Past work' }) : ''}</span>
              <div className="row gap">
                <ActionButton variant="ghost" label={tr({ ar: 'تعديل', en: 'Edit' })} fields={[
                  { name: 'caption', label: { ar: 'الوصف', en: 'Caption' }, type: 'i18n', defaultValue: m.caption ?? undefined },
                  { name: 'isPastWork', label: { ar: 'من أعمال سابقة', en: 'Past work' }, type: 'checkbox', defaultValue: m.isPastWork },
                  { name: 'sortOrder', label: { ar: 'الترتيب', en: 'Order' }, type: 'number', defaultValue: m.sortOrder },
                ]} run={(api, v) => api.patch(`/v1/provider/media/${m.id}`, v)} />
                <button type="button" className="btn btn-ghost" onClick={() => remove.mutate(m.id)}>{tr({ ar: 'حذف', en: 'Delete' })}</button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

function packageFields(units: string[], p?: Service['packages'][number]) {
  return [
    { name: 'name', label: { ar: 'اسم الباقة', en: 'Package name' }, type: 'i18n' as const, required: true, defaultValue: p?.name },
    { name: 'description', label: { ar: 'الوصف', en: 'Description' }, type: 'i18n' as const, defaultValue: p?.description ?? undefined },
    { name: 'price', label: { ar: 'السعر', en: 'Price' }, type: 'decimal' as const, required: true, defaultValue: p?.price },
    { name: 'currency', label: { ar: 'العملة', en: 'Currency' }, required: true, defaultValue: p?.currency ?? 'SAR' },
    { name: 'pricingUnit', label: { ar: 'طريقة التسعير', en: 'Pricing unit' }, type: 'select' as const, required: true, options: units.map((u) => ({ value: u, label: u })), defaultValue: p?.pricingUnit ?? units[0] },
    { name: 'inclusions', label: { ar: 'ما تشمله (JSON: قائمة نصوص ثنائية اللغة)', en: 'Inclusions (JSON list of {ar,en})' }, type: 'json' as const, defaultValue: p?.inclusions ?? [] },
    { name: 'addOns', label: { ar: 'الإضافات (JSON)', en: 'Add-ons (JSON)' }, type: 'json' as const, defaultValue: p?.addOns ?? [], help: { ar: '[{"code":"dj","name":{"ar":"دي جي","en":"DJ"},"price":"1500"}]', en: '[{"code":"dj","name":{"ar":"…","en":"DJ"},"price":"1500"}]' } },
    { name: 'status', label: { ar: 'الحالة', en: 'Status' }, type: 'select' as const, options: [{ value: 'active', label: { ar: 'مفعّلة', en: 'Active' } }, { value: 'inactive', label: { ar: 'موقوفة', en: 'Inactive' } }], defaultValue: p?.status ?? 'active' },
  ];
}

function Packages({ s, units }: { s: Service; units: string[] }) {
  const tr = useTr();
  return (
    <Card actions={<ActionButton variant="primary" label={tr({ ar: 'باقة جديدة', en: 'New package' })} fields={packageFields(units)} run={(api, v) => api.post(`/v1/provider/services/${s.id}/packages`, v)} />}>
      <DataTable rows={s.packages} columns={[
        { key: 'name', label: { ar: 'الباقة', en: 'Package' }, render: (p) => <Text value={p.name} /> },
        { key: 'price', label: { ar: 'السعر', en: 'Price' }, render: (p) => <Money amount={p.price} currency={p.currency} /> },
        { key: 'addOns', label: { ar: 'الإضافات', en: 'Add-ons' }, render: (p) => p.addOns.length },
        { key: 'status', label: { ar: 'الحالة', en: 'Status' } },
        { key: 'edit', label: '', render: (p) => <ActionButton label={tr({ ar: 'تعديل', en: 'Edit' })} fields={packageFields(units, p)} run={(api, v) => api.patch(`/v1/provider/packages/${p.id}`, v)} /> },
      ]} />
    </Card>
  );
}

function Rental({ s }: { s: Service }) {
  const tr = useTr();
  const fields = (r?: Service['rentalItems'][number]) => [
    ...(r ? [] : [{ name: 'sku', label: { ar: 'رمز العنصر', en: 'SKU' }, required: true }]),
    { name: 'name', label: { ar: 'الاسم', en: 'Name' }, type: 'i18n' as const, required: true, defaultValue: r?.name },
    { name: 'quantityTotal', label: { ar: 'الكمية المتاحة', en: 'Quantity' }, type: 'number' as const, required: true, defaultValue: r?.quantityTotal },
    { name: 'pricePerDay', label: { ar: 'السعر اليومي', en: 'Price per day' }, type: 'decimal' as const, required: true, defaultValue: r?.pricePerDay },
    { name: 'currency', label: { ar: 'العملة', en: 'Currency' }, required: true, defaultValue: r?.currency ?? 'SAR' },
    { name: 'securityDeposit', label: { ar: 'التأمين المسترد', en: 'Security deposit' }, type: 'decimal' as const, defaultValue: r?.securityDeposit ?? undefined },
    { name: 'condition', label: { ar: 'الحالة', en: 'Condition' }, type: 'select' as const, options: ['new', 'excellent', 'good', 'fair'].map((v) => ({ value: v, label: v })), defaultValue: r?.condition ?? 'good' },
  ];
  return (
    <Card actions={<ActionButton variant="primary" label={tr({ ar: 'عنصر جديد', en: 'New item' })} fields={fields()} run={(api, v) => api.post(`/v1/provider/services/${s.id}/rental-items`, v)} />}>
      <DataTable rows={s.rentalItems} columns={[
        { key: 'name', label: { ar: 'العنصر', en: 'Item' }, render: (r) => <Text value={r.name} /> },
        { key: 'sku', label: 'SKU' },
        { key: 'quantityTotal', label: { ar: 'الكمية', en: 'Quantity' } },
        { key: 'pricePerDay', label: { ar: 'اليومي', en: 'Per day' }, render: (r) => <Money amount={r.pricePerDay} currency={r.currency} /> },
        { key: 'status', label: { ar: 'الحالة', en: 'Status' } },
        { key: 'edit', label: '', render: (r) => <ActionButton label={tr({ ar: 'تعديل', en: 'Edit' })} fields={fields(r)} run={(api, v) => api.patch(`/v1/provider/rental-items/${r.id}`, v)} /> },
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
