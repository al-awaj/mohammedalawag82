'use client';
import { useGet, useTr } from '@events/web-kit/client';
import { ActionButton, DataTable, DateTime, ErrorBox, Loading, Notice, Page, Text } from '@events/web-kit/ui';
import { useCountries } from '@/lib/util';

type Template = { id: string; countryId: string | null; countryCode: string | null; version: number; title: Record<string, string>; body: Record<string, string>; createdAt: string; createdBy: string; bookings: number };

/** Starting draft only; it must be reviewed by a lawyer for each country before use. */
const DRAFT_AR = `عقد حجز خدمة رقم {{bookingNumber}}

أُبرم هذا العقد بتاريخ {{bookingDate}} عبر منصة {{platformName}} بين العميل {{customerName}} وصاحب الخدمة {{providerName}}.

موضوع العقد: تقديم خدمة «{{service}}» {{package}} من {{startAt}} إلى {{endAt}}.

المقابل المالي: {{total}}، يُدفع منه عند الحجز {{upfrontAmount}}، ويُستحق المتبقي في {{balanceDueAt}}.
{{instalments}}

سياسة الإلغاء والاسترداد:
{{cancellationPolicy}}

شروط الخدمة:
{{serviceTerms}}
{{packageTerms}}`;
const DRAFT_EN = `Service booking contract no. {{bookingNumber}}

Made on {{bookingDate}} through {{platformName}} between the customer {{customerName}} and the provider {{providerName}}.

Subject: the service "{{service}}" {{package}} from {{startAt}} to {{endAt}}.

Price: {{total}}; {{upfrontAmount}} is paid when booking and the balance is due on {{balanceDueAt}}.
{{instalments}}

Cancellation and refunds:
{{cancellationPolicy}}

Service terms:
{{serviceTerms}}
{{packageTerms}}`;

/** Booking contract template (clause 65). Saving adds a version; bookings keep the version they were made under. */
export default function Contracts() {
  const tr = useTr();
  const countries = useCountries();
  const { data, error, isLoading } = useGet<{ placeholders: string[]; templates: Template[] }>('/v1/admin/contract-templates');
  if (isLoading) return <Loading />;
  const latest = data?.templates[0];
  const vars = (data?.placeholders ?? []).map((p) => `{{${p}}}`).join(' ');
  return (
    <Page title={tr({ ar: 'قالب عقد الحجز', en: 'Booking contract template' })} actions={
      <ActionButton variant="primary" label={tr({ ar: 'إصدار نسخة جديدة', en: 'New version' })}
        note={tr({ ar: 'تُطبق النسخة الجديدة على الحجوزات القادمة فقط. النص المقترح مسودة يجب مراجعتها قانونيًا قبل الاعتماد.', en: 'The new version applies to future bookings only. The suggested text is a draft that needs legal review before use.' })}
        fields={[
          { name: 'countryId', label: { ar: 'الدولة (فارغ = كل الدول)', en: 'Country (empty = all countries)' }, type: 'select', options: countries.options },
          { name: 'titleAr', label: { ar: 'العنوان بالعربية', en: 'Title (Arabic)' }, required: true, defaultValue: latest?.title.ar ?? 'عقد حجز خدمة' },
          { name: 'titleEn', label: { ar: 'العنوان بالإنجليزية', en: 'Title (English)' }, defaultValue: latest?.title.en ?? 'Service booking contract' },
          { name: 'bodyAr', label: { ar: 'نص العقد بالعربية', en: 'Contract text (Arabic)' }, type: 'textarea', required: true, defaultValue: latest?.body.ar ?? DRAFT_AR,
            help: { ar: `المتغيرات المتاحة: ${vars}`, en: `Placeholders: ${vars}` } },
          { name: 'bodyEn', label: { ar: 'نص العقد بالإنجليزية', en: 'Contract text (English)' }, type: 'textarea', defaultValue: latest?.body.en ?? DRAFT_EN },
          { name: 'reason', label: { ar: 'سبب الإصدار', en: 'Reason' }, type: 'textarea', required: true },
        ]}
        run={(api, v) => api.post('/v1/admin/contract-templates', {
          countryId: v.countryId ?? null, reason: v.reason,
          title: { ar: v.titleAr, ...(v.titleEn ? { en: v.titleEn } : {}) }, body: { ar: v.bodyAr, ...(v.bodyEn ? { en: v.bodyEn } : {}) },
        })} />
    }>
      <ErrorBox error={error} />
      {!data?.templates.length && <Notice kind="warning">{tr({ ar: 'لا يوجد قالب بعد؛ لن يظهر عقد للحجوزات حتى تصدر النسخة الأولى.', en: 'No template yet; bookings get no contract until the first version is issued.' })}</Notice>}
      <DataTable rows={data?.templates ?? []} columns={[
        { key: 'countryCode', label: { ar: 'الدولة', en: 'Country' }, render: (t) => t.countryCode ?? tr({ ar: 'كل الدول', en: 'All countries' }) },
        { key: 'version', label: { ar: 'النسخة', en: 'Version' } },
        { key: 'title', label: { ar: 'العنوان', en: 'Title' }, render: (t) => <Text value={t.title} /> },
        { key: 'bookings', label: { ar: 'حجوزات بهذه النسخة', en: 'Bookings on it' } },
        { key: 'createdBy', label: { ar: 'أصدرها', en: 'Issued by' } },
        { key: 'createdAt', label: { ar: 'التاريخ', en: 'Date' }, render: (t) => <DateTime value={t.createdAt} /> },
      ]} />
    </Page>
  );
}
