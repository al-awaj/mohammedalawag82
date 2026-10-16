'use client';
import { useGet, useTr } from '@events/web-kit/client';
import { ActionButton, Card, DataTable, DateTime, ErrorBox, Loading, Page, Text, type FieldSpec } from '@events/web-kit/ui';
import { useCountries } from '@/lib/util';

interface Article {
  id: string; countryId: string | null; countryCode: string | null; audience: string; topic: string; question: Record<string, string>;
  answer: Record<string, string>; sortOrder: number; isPublished: boolean; updatedAt: string;
}
const AUDIENCE = [
  { value: 'customer', label: { ar: 'العملاء', en: 'Customers' } }, { value: 'provider', label: { ar: 'أصحاب الخدمات', en: 'Providers' } },
  { value: 'all', label: { ar: 'الجميع', en: 'Everyone' } },
];

/** Help centre and FAQ shown on the website, the app and the provider panel (clause 60). Articles are unpublished, never deleted. */
export default function HelpArticles() {
  const tr = useTr();
  const countries = useCountries();
  const { data, error, isLoading } = useGet<Article[]>('/v1/admin/help-articles');
  const fields = (a?: Article): FieldSpec[] => [
    ...(a ? [] : [{ name: 'countryId', label: { ar: 'الدولة (فارغ = كل الدول)', en: 'Country (empty = every country)' }, type: 'select', options: countries.options } as FieldSpec]),
    { name: 'audience', label: { ar: 'موجه إلى', en: 'Audience' }, type: 'select', required: true, options: AUDIENCE, defaultValue: a?.audience ?? 'customer' },
    { name: 'topic', label: { ar: 'الموضوع (رمز إنجليزي مثل payments)', en: 'Topic (code such as payments)' }, required: true, defaultValue: a?.topic },
    { name: 'question', label: { ar: 'السؤال', en: 'Question' }, type: 'i18n', required: true, defaultValue: a?.question },
    { name: 'answer', label: { ar: 'الإجابة', en: 'Answer' }, type: 'i18n', required: true, defaultValue: a?.answer },
    { name: 'sortOrder', label: { ar: 'الترتيب', en: 'Order' }, type: 'number', defaultValue: a?.sortOrder ?? 0 },
    { name: 'isPublished', label: { ar: 'منشور', en: 'Published' }, type: 'checkbox', defaultValue: a?.isPublished ?? false },
  ];
  if (isLoading) return <Loading />;
  return (
    <Page title={tr({ ar: 'المساعدة والأسئلة الشائعة', en: 'Help & FAQ' })} actions={
      <ActionButton variant="primary" label={tr({ ar: 'سؤال جديد', en: 'New article' })} fields={fields()} run={(api, v) => api.post('/v1/admin/help-articles', { ...v, countryId: v.countryId ?? null })} />
    }>
      <ErrorBox error={error} />
      <Card>
        <DataTable rows={data ?? []} columns={[
          { key: 'question', label: { ar: 'السؤال', en: 'Question' }, render: (a) => <Text value={a.question} /> },
          { key: 'audience', label: { ar: 'موجه إلى', en: 'Audience' }, render: (a) => tr(AUDIENCE.find((x) => x.value === a.audience)!.label) },
          { key: 'countryCode', label: { ar: 'الدولة', en: 'Country' }, render: (a) => a.countryCode ?? tr({ ar: 'كل الدول', en: 'All' }) },
          { key: 'topic', label: { ar: 'الموضوع', en: 'Topic' } },
          { key: 'isPublished', label: { ar: 'الحالة', en: 'Status' }, render: (a) => a.isPublished ? tr({ ar: 'منشور', en: 'Published' }) : tr({ ar: 'مسودة', en: 'Draft' }) },
          { key: 'updatedAt', label: { ar: 'آخر تعديل', en: 'Updated' }, render: (a) => <DateTime value={a.updatedAt} /> },
          { key: 'edit', label: '', render: (a) => <ActionButton label={tr({ ar: 'تعديل', en: 'Edit' })} fields={fields(a)} run={(api, v) => api.patch(`/v1/admin/help-articles/${a.id}`, v)} /> },
        ]} />
      </Card>
    </Page>
  );
}
