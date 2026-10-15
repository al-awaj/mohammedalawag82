'use client';
import { useState } from 'react';
import { useCan, useGet, useTr } from '@events/web-kit/client';
import { ActionButton, Badge, DataTable, ErrorBox, Loading, Page, Tabs, Text, type FieldSpec } from '@events/web-kit/ui';
import { raw, useCountries } from '@/lib/util';

type Category = { id: string; slug: string; parentId: string | null; name: Record<string, string>; description: Record<string, string> | null; icon: string | null; imageKey: string | null; sortOrder: number; isActive: boolean; countryIds: string[]; typeCount: number };
type Type = { id: string; code: string; name: Record<string, string>; categoryId: string; bookingMode: string; isActive: boolean; serviceCount: number };

const BOOKING_MODES = [
  { value: 'time_slot', label: { ar: 'فترات زمنية', en: 'Time slots' } }, { value: 'full_day', label: { ar: 'يوم كامل', en: 'Full day' } },
  { value: 'date_range', label: { ar: 'فترة أيام', en: 'Date range' } }, { value: 'quantity_rental', label: { ar: 'تأجير كميات', en: 'Quantity rental' } },
];
const PRICING = raw('fixed', 'per_hour', 'per_day', 'per_person', 'per_unit');

export default function Catalog() {
  const tr = useTr();
  const can = useCan();
  const [tab, setTab] = useState<'categories' | 'types'>(can('categories.manage') ? 'categories' : 'types');
  return (
    <Page title={tr({ ar: 'التصنيفات وأنواع الخدمات', en: 'Categories & service types' })}>
      <Tabs value={tab} onChange={setTab} tabs={[
        ...(can('categories.manage') ? [{ id: 'categories' as const, label: tr({ ar: 'التصنيفات', en: 'Categories' }) }] : []),
        ...(can('service_types.manage') ? [{ id: 'types' as const, label: tr({ ar: 'أنواع الخدمات', en: 'Service types' }) }] : []),
      ]} />
      {tab === 'categories' ? <Categories /> : <Types />}
    </Page>
  );
}

function categoryFields(countries: ReturnType<typeof useCountries>, c?: Category): FieldSpec[] {
  return [
    { name: 'slug', label: { ar: 'المعرّف (slug)', en: 'Slug' }, required: true, defaultValue: c?.slug, help: { ar: 'أحرف إنجليزية صغيرة وأرقام وشرطات', en: 'lowercase letters, digits, dashes' } },
    { name: 'name', label: { ar: 'الاسم', en: 'Name' }, type: 'i18n', required: true, defaultValue: c?.name },
    { name: 'description', label: { ar: 'الوصف', en: 'Description' }, type: 'i18n', defaultValue: c?.description ?? undefined },
    { name: 'icon', label: { ar: 'الأيقونة', en: 'Icon' }, defaultValue: c?.icon ?? undefined },
    { name: 'sortOrder', label: { ar: 'الترتيب', en: 'Sort order' }, type: 'number', defaultValue: c?.sortOrder ?? 0 },
    { name: 'isActive', label: { ar: 'مفعّل', en: 'Active' }, type: 'checkbox', defaultValue: c?.isActive ?? true },
    { name: 'countryIds', label: { ar: 'الدول المتاح فيها', en: 'Available in countries' }, type: 'multiselect', options: countries.options, defaultValue: c?.countryIds ?? [] },
  ];
}

function Categories() {
  const tr = useTr();
  const countries = useCountries();
  const { data, error, isLoading } = useGet<Category[]>('/v1/admin/categories');
  if (isLoading) return <Loading />;
  return (
    <>
      <ErrorBox error={error} />
      <div className="page-actions" style={{ marginBottom: 12 }}>
        <ActionButton variant="primary" label={tr({ ar: 'تصنيف جديد', en: 'New category' })} fields={categoryFields(countries)}
          run={(api, v) => api.post('/v1/admin/categories', { ...v, countryIds: v.countryIds ?? [] })} />
        <StarterImport countries={countries} />
      </div>
      <DataTable rows={data ?? []} columns={[
        { key: 'name', label: { ar: 'الاسم', en: 'Name' }, render: (c) => <Text value={c.name} /> },
        { key: 'slug', label: { ar: 'المعرّف', en: 'Slug' } },
        { key: 'countryIds', label: { ar: 'الدول', en: 'Countries' }, render: (c) => c.countryIds.map(countries.code).join('، ') || '—' },
        { key: 'typeCount', label: { ar: 'الأنواع', en: 'Types' } },
        { key: 'isActive', label: { ar: 'مفعّل', en: 'Active' } },
        { key: 'image', label: { ar: 'الصورة', en: 'Image' }, render: (c) => (
          <ActionButton label={c.imageKey ? tr({ ar: 'تغيير الصورة', en: 'Change image' }) : tr({ ar: 'رفع صورة', en: 'Upload image' })}
            note={tr({ ar: 'تظهر في الصفحة الرئيسية للموقع بدل الأيقونة. PNG أو JPG أو WEBP.', en: 'Shown on the website home page instead of the icon. PNG, JPG or WEBP.' })}
            fields={[{ name: 'file', label: { ar: 'الصورة', en: 'Image' }, type: 'file', required: true }]}
            run={(api, v) => { const f = new FormData(); f.append('file', v.file as File); return api.upload(`/v1/admin/categories/${c.id}/image`, f); }} />
        ) },
        { key: 'edit', label: '', render: (c) => (
          <ActionButton label={tr({ ar: 'تعديل', en: 'Edit' })} fields={categoryFields(countries, c)}
            run={(api, v) => api.patch(`/v1/admin/categories/${c.id}`, { ...v, countryIds: v.countryIds ?? [] })} />
        ) },
      ]} />
    </>
  );
}

function Types() {
  const tr = useTr();
  const cats = useGet<Category[]>('/v1/admin/categories').data ?? [];
  const { data, error, isLoading } = useGet<Type[]>('/v1/admin/service-types');
  if (isLoading) return <Loading />;
  return (
    <>
      <ErrorBox error={error} />
      <div className="page-actions" style={{ marginBottom: 12 }}>
        <ActionButton variant="primary" label={tr({ ar: 'نوع خدمة جديد', en: 'New service type' })}
          note={tr({ ar: 'الحقول الخاصة بالنوع تُضاف من صفحة النوع بعد إنشائه.', en: 'Type-specific fields are added from the type page after creating it.' })}
          fields={[
            { name: 'categoryId', label: { ar: 'التصنيف', en: 'Category' }, type: 'select', required: true, options: cats.map((c) => ({ value: c.id, label: { ar: c.name.ar ?? c.slug, en: c.name.en ?? c.slug } })) },
            { name: 'code', label: { ar: 'الرمز', en: 'Code' }, required: true, help: { ar: 'مثل: wedding_hall', en: 'e.g. wedding_hall' } },
            { name: 'name', label: { ar: 'الاسم', en: 'Name' }, type: 'i18n', required: true },
            { name: 'bookingMode', label: { ar: 'طريقة الحجز', en: 'Booking mode' }, type: 'select', required: true, options: BOOKING_MODES },
            { name: 'pricingUnits', label: { ar: 'وحدات التسعير', en: 'Pricing units' }, type: 'multiselect', required: true, options: PRICING },
            { name: 'defaultRequiresApproval', label: { ar: 'يتطلب موافقة صاحب الخدمة افتراضيًا', en: 'Provider approval by default' }, type: 'checkbox', defaultValue: true },
            { name: 'depositRequired', label: { ar: 'العربون إلزامي', en: 'Deposit required' }, type: 'checkbox' },
            { name: 'minDepositPercent', label: { ar: 'أدنى نسبة عربون %', en: 'Minimum deposit %' }, type: 'number' },
            { name: 'minImages', label: { ar: 'أقل عدد صور', en: 'Minimum images' }, type: 'number', defaultValue: 1 },
          ]}
          run={(api, v) => api.post('/v1/admin/service-types', v)} />
      </div>
      <DataTable rows={data ?? []} rowHref={(t) => `/catalog/types/${t.id}`} columns={[
        { key: 'name', label: { ar: 'الاسم', en: 'Name' }, render: (t) => <Text value={t.name} /> },
        { key: 'code', label: { ar: 'الرمز', en: 'Code' } },
        { key: 'bookingMode', label: { ar: 'طريقة الحجز', en: 'Booking mode' } },
        { key: 'serviceCount', label: { ar: 'الخدمات', en: 'Services' } },
        { key: 'isActive', label: { ar: 'الحالة', en: 'Status' }, render: (t) => <Badge group="provider" value={t.isActive ? 'active' : 'suspended'} /> },
      ]} />
    </>
  );
}

type Starter = { slug: string; name: Record<string, string>; exists: boolean; types: { code: string; name: Record<string, string>; requiredDocuments: string[]; fields: number; exists: boolean }[] };

/** One action that adds the ready-made event categories, service types and fields; existing ones are left untouched. */
function StarterImport({ countries }: { countries: ReturnType<typeof useCountries> }) {
  const tr = useTr();
  const can = useCan();
  const { data } = useGet<Starter[]>(can('categories.manage') && can('service_types.manage') ? '/v1/admin/catalog/starter' : null);
  if (!data) return null;
  const missing = data.reduce((n, c) => n + c.types.filter((t) => !t.exists).length, 0);
  if (!missing) return null;
  return (
    <ActionButton label={tr({ ar: `استيراد الكتالوج الجاهز (${missing} نوع)`, en: `Import starter catalog (${missing} types)` })}
      note={<>
        {tr({ ar: 'يضيف تصنيفات وأنواع خدمات وحقولًا جاهزة لخدمات المناسبات. لا يُنشئ أي خدمات أو أسعار، ويتجاوز ما هو موجود مسبقًا، ويمكن تعديل كل شيء لاحقًا.', en: 'Adds ready-made event categories, service types and fields. It creates no services or prices, skips what already exists, and everything stays editable.' })}
        <ul className="small">{data.map((c) => <li key={c.slug}><Text value={c.name} />: {c.types.map((t) => `${tr(t.name as { ar: string; en: string })}${t.exists ? ' ✓' : ''}`).join('، ')}</li>)}</ul>
      </>}
      fields={[
        { name: 'countryIds', label: { ar: 'الدول التي تظهر فيها التصنيفات الجديدة', en: 'Countries for the new categories' }, type: 'multiselect', required: true, options: countries.options },
        { name: 'reason', label: { ar: 'السبب', en: 'Reason' }, type: 'textarea', required: true, defaultValue: tr({ ar: 'إعداد الكتالوج الأولي', en: 'Initial catalog setup' }) },
      ]}
      run={(api, v) => api.post('/v1/admin/catalog/starter', v)} />
  );
}
