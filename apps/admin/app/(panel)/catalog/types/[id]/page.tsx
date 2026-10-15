'use client';
import { use } from 'react';
import { useApp, useCan, useGet, useTr } from '@events/web-kit/client';
import { ActionButton, Card, DataTable, Detail, ErrorBox, Loading, Page, reasonField, Text, type FieldSpec } from '@events/web-kit/ui';
import { localized } from '@events/shared';
import { raw } from '@/lib/util';

interface Field { id: string; key: string; label: Record<string, string>; helpText: Record<string, string> | null; dataType: string; isRequired: boolean; validation: Record<string, unknown>; options: { value: string; label: Record<string, string> }[]; isSearchable: boolean; isReportable: boolean; isPublic: boolean; sortOrder: number; isActive: boolean }
// This endpoint returns database column names.
interface Type {
  id: string; code: string; name: Record<string, string>; booking_mode: string; capacity_mode: string; default_requires_approval: boolean; default_duration_minutes: number | null;
  buffer_before_minutes: number; buffer_after_minutes: number; pricing_units: string[]; allows_packages: boolean; min_images: number; max_images: number; allows_video: boolean;
  required_documents: string[]; deposit_required: boolean; min_deposit_percent: string | null; provider_can_create: boolean; is_active: boolean; default_cancellation_policy_id: string | null; fields: Field[];
}
const DATA_TYPES = raw('text', 'textarea', 'i18n_text', 'number', 'integer', 'boolean', 'select', 'multiselect', 'date', 'url', 'time', 'location');

const fieldSpecs = (f?: Field): FieldSpec[] => [
  ...(f ? [] : [{ name: 'key', label: { ar: 'المفتاح', en: 'Key' }, required: true, help: { ar: 'مثل: seats', en: 'e.g. seats' } } as FieldSpec]),
  { name: 'label', label: { ar: 'العنوان', en: 'Label' }, type: 'i18n', required: true, defaultValue: f?.label },
  { name: 'helpText', label: { ar: 'نص المساعدة', en: 'Help text' }, type: 'i18n', defaultValue: f?.helpText ?? undefined },
  ...(f ? [] : [{ name: 'dataType', label: { ar: 'نوع البيانات', en: 'Data type' }, type: 'select', required: true, options: DATA_TYPES } as FieldSpec]),
  { name: 'isRequired', label: { ar: 'إلزامي', en: 'Required' }, type: 'checkbox', defaultValue: f?.isRequired },
  { name: 'isSearchable', label: { ar: 'قابل للبحث', en: 'Searchable' }, type: 'checkbox', defaultValue: f?.isSearchable },
  { name: 'isReportable', label: { ar: 'يظهر في التقارير', en: 'Reportable' }, type: 'checkbox', defaultValue: f?.isReportable },
  { name: 'isPublic', label: { ar: 'يظهر للعملاء', en: 'Visible to customers' }, type: 'checkbox', defaultValue: f?.isPublic ?? true },
  { name: 'sortOrder', label: { ar: 'الترتيب', en: 'Sort order' }, type: 'number', defaultValue: f?.sortOrder ?? 0 },
  { name: 'validation', label: { ar: 'قيود التحقق (JSON)', en: 'Validation (JSON)' }, type: 'json', defaultValue: f?.validation ?? {}, help: { ar: 'min, max, minLength, maxLength, pattern, maxItems', en: 'min, max, minLength, maxLength, pattern, maxItems' } },
  { name: 'options', label: { ar: 'الخيارات (JSON)', en: 'Options (JSON)' }, type: 'json', defaultValue: f?.options ?? [], help: { ar: '[{"value":"x","label":{"ar":"…","en":"…"}}] للقوائم', en: '[{"value":"x","label":{"ar":"…","en":"…"}}] for select types' } },
];

export default function TypePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const tr = useTr();
  const { lang } = useApp();
  const can = useCan();
  const { data: t, error, isLoading } = useGet<Type>(`/v1/admin/service-types/${id}`);
  const policies = (useGet<{ id: string; name: Record<string, string>; isActive: boolean }[]>(can('services.manage') ? '/v1/admin/cancellation-policies' : null).data ?? [])
    .filter((p) => p.isActive).map((p) => ({ value: p.id, label: { ar: p.name.ar ?? p.name.en ?? '', en: p.name.en ?? p.name.ar ?? '' } }));
  if (isLoading) return <Loading />;
  if (error || !t) return <ErrorBox error={error} />;
  return (
    <Page title={localized(t.name, lang)} actions={
      <ActionButton label={tr({ ar: 'تعديل الإعدادات', en: 'Edit settings' })} fields={[
        { name: 'name', label: { ar: 'الاسم', en: 'Name' }, type: 'i18n', required: true, defaultValue: t.name },
        { name: 'pricingUnits', label: { ar: 'وحدات التسعير', en: 'Pricing units' }, type: 'multiselect', options: raw('fixed', 'per_hour', 'per_day', 'per_person', 'per_unit'), defaultValue: t.pricing_units },
        { name: 'defaultRequiresApproval', label: { ar: 'يتطلب موافقة صاحب الخدمة افتراضيًا', en: 'Provider approval by default' }, type: 'checkbox', defaultValue: t.default_requires_approval },
        { name: 'depositRequired', label: { ar: 'العربون إلزامي', en: 'Deposit required' }, type: 'checkbox', defaultValue: t.deposit_required },
        { name: 'minImages', label: { ar: 'أقل عدد صور', en: 'Minimum images' }, type: 'number', defaultValue: t.min_images },
        { name: 'maxImages', label: { ar: 'أكثر عدد صور', en: 'Maximum images' }, type: 'number', defaultValue: t.max_images },
        { name: 'allowsVideo', label: { ar: 'يسمح بالفيديو', en: 'Allows video' }, type: 'checkbox', defaultValue: t.allows_video },
        { name: 'allowsPackages', label: { ar: 'يسمح بالباقات', en: 'Allows packages' }, type: 'checkbox', defaultValue: t.allows_packages },
        { name: 'providerCanCreate', label: { ar: 'يستطيع صاحب الخدمة الإنشاء', en: 'Providers can create' }, type: 'checkbox', defaultValue: t.provider_can_create },
        { name: 'isActive', label: { ar: 'مفعّل', en: 'Active' }, type: 'checkbox', defaultValue: t.is_active },
        { name: 'requiredDocuments', label: { ar: 'الوثائق المطلوبة لكل خدمة', en: 'Documents required per service' }, defaultValue: t.required_documents.join(', '),
          help: { ar: 'رموز مفصولة بفواصل، مثل: commercial_license, civil_defense_permit. يرفعها صاحب الخدمة قبل إرسالها للمراجعة.', en: 'Comma-separated codes, e.g. commercial_license, civil_defense_permit. Providers upload them before submitting a service.' } },
        ...(policies.length ? [{ name: 'defaultCancellationPolicyId', label: { ar: 'سياسة الإلغاء الافتراضية', en: 'Default cancellation policy' }, type: 'select', options: policies,
          defaultValue: t.default_cancellation_policy_id ?? undefined, help: { ar: 'تُطبق على خدمات هذا النوع التي لا يختار لها صاحبها سياسة.', en: 'Applies to services of this type whose provider picks none.' } } as FieldSpec] : []),
        reasonField(false),
      ]} run={(api, v) => api.patch(`/v1/admin/service-types/${id}`, {
        ...v, requiredDocuments: String(v.requiredDocuments ?? '').split(/[,،\s]+/).map((x) => x.trim()).filter(Boolean),
        ...(policies.length ? { defaultCancellationPolicyId: v.defaultCancellationPolicyId ?? null } : {}),
      })} />
    }>
      <Card>
        <Detail items={[
          [tr({ ar: 'الرمز', en: 'Code' }), t.code],
          [tr({ ar: 'طريقة الحجز', en: 'Booking mode' }), t.booking_mode],
          [tr({ ar: 'السعة', en: 'Capacity' }), t.capacity_mode],
          [tr({ ar: 'وحدات التسعير', en: 'Pricing units' }), t.pricing_units.join(', ')],
          [tr({ ar: 'العربون', en: 'Deposit' }), t.deposit_required ? `✓ ≥ ${t.min_deposit_percent ?? 0}%` : '✗'],
          [tr({ ar: 'الوثائق المطلوبة', en: 'Required documents' }), t.required_documents.join('، ') || '—'],
          [tr({ ar: 'الصور', en: 'Images' }), `${t.min_images} – ${t.max_images}`],
          [tr({ ar: 'المستندات المطلوبة', en: 'Required documents' }), t.required_documents.join(', ') || '—'],
          [tr({ ar: 'مفعّل', en: 'Active' }), t.is_active ? '✓' : '✗'],
        ]} />
      </Card>
      <Card title={tr({ ar: 'الحقول الخاصة بالنوع', en: 'Type-specific fields' })} actions={
        <ActionButton variant="primary" label={tr({ ar: 'حقل جديد', en: 'New field' })} fields={fieldSpecs()} run={(api, v) => api.post(`/v1/admin/service-types/${id}/fields`, v)} />
      }>
        <DataTable rows={t.fields} columns={[
          { key: 'label', label: { ar: 'العنوان', en: 'Label' }, render: (f) => <Text value={f.label} /> },
          { key: 'key', label: { ar: 'المفتاح', en: 'Key' } },
          { key: 'dataType', label: { ar: 'النوع', en: 'Type' } },
          { key: 'isRequired', label: { ar: 'إلزامي', en: 'Required' } },
          { key: 'isPublic', label: { ar: 'للعملاء', en: 'Public' } },
          { key: 'isActive', label: { ar: 'مفعّل', en: 'Active' } },
          { key: 'edit', label: '', render: (f) => (
            <div className="row gap">
              <ActionButton label={tr({ ar: 'تعديل', en: 'Edit' })} fields={fieldSpecs(f)} run={(api, v) => api.patch(`/v1/admin/service-types/${id}/fields/${f.id}`, v)} />
              <ActionButton label={f.isActive ? tr({ ar: 'تعطيل', en: 'Deactivate' }) : tr({ ar: 'تفعيل', en: 'Activate' })}
                note={tr({ ar: 'لا يُحذف الحقل حتى لا تضيع بيانات الخدمات السابقة.', en: 'Fields are never deleted so existing service data is kept.' })}
                run={(api) => api.patch(`/v1/admin/service-types/${id}/fields/${f.id}`, { isActive: !f.isActive })} />
            </div>
          ) },
        ]} />
      </Card>
    </Page>
  );
}
