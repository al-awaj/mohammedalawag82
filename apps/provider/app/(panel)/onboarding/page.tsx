'use client';
import { useAction, useGet, useSession, useTr } from '@events/web-kit/client';
import { ActionButton, Badge, Card, DataTable, DateTime, Detail, ErrorBox, Form, Loading, Notice, Page, type FieldSpec } from '@events/web-kit/ui';
import { useProvider } from '@/lib/provider';

interface Application {
  id: string; status: string; businessName: string; activityType: string; countryCode: string; city: string; phone: string; email: string | null;
  address: string | null; description: string | null; payoutDetails: Record<string, unknown> | null; decisionReason: string | null; submittedAt: string | null;
  documents: { id: string; docType: string; originalName: string; createdAt: string }[]; history: { from: string | null; to: string; reason: string | null; at: string }[];
}
const DOC_LABELS: Record<string, { ar: string; en: string }> = {
  identity: { ar: 'إثبات الهوية', en: 'Identity document' }, commercial_registration: { ar: 'السجل التجاري', en: 'Commercial registration' },
};

const fields = (a: Application | undefined, countryCode: string, phone: string): FieldSpec[] => [
  { name: 'businessName', label: { ar: 'اسم النشاط', en: 'Business name' }, required: true, defaultValue: a?.businessName },
  { name: 'activityType', label: { ar: 'نوع النشاط', en: 'Activity type' }, required: true, defaultValue: a?.activityType, placeholder: 'قاعات، تصوير، ضيافة…' },
  { name: 'city', label: { ar: 'المدينة', en: 'City' }, required: true, defaultValue: a?.city },
  { name: 'phone', label: { ar: 'جوال النشاط', en: 'Business phone' }, type: 'tel', required: true, defaultValue: a?.phone ?? phone },
  { name: 'email', label: { ar: 'بريد النشاط', en: 'Business email' }, type: 'email', defaultValue: a?.email ?? undefined },
  { name: 'address', label: { ar: 'العنوان', en: 'Address' }, defaultValue: a?.address ?? undefined },
  { name: 'description', label: { ar: 'نبذة عن النشاط', en: 'About the business' }, type: 'textarea', defaultValue: a?.description ?? undefined },
  { name: 'payoutDetails', label: { ar: 'بيانات استلام المستحقات (JSON)', en: 'Payout details (JSON)' }, type: 'json', defaultValue: a?.payoutDetails ?? { iban: '', bankName: '', accountName: '' },
    help: { ar: 'تظهر فقط للموظفين المخولين بالبيانات الحساسة.', en: 'Visible only to staff allowed to see sensitive data.' } },
  { name: 'countryCode', label: { ar: 'الدولة', en: 'Country' }, readOnly: true, defaultValue: countryCode },
];

export default function Onboarding() {
  const tr = useTr();
  const session = useSession().data;
  const { provider } = useProvider();
  const apps = useGet<Application[]>('/v1/provider-applications/mine');
  const a = apps.data?.[0];
  const reqs = useGet<{ requiredDocuments: string[] }>(session?.countryCode ? '/v1/provider-applications/requirements' : null, { country: session?.countryCode ?? '' });
  const create = useAction((api, v: Record<string, unknown>) => api.post('/v1/provider-applications', v));
  const update = useAction((api, v: Record<string, unknown>) => api.patch(`/v1/provider-applications/${a!.id}`, v));
  if (apps.isLoading || !session) return <Loading />;
  const editable = !a || ['draft', 'needs_info'].includes(a.status);
  const startNew = !a || ['rejected', 'cancelled'].includes(a.status);
  const missing = (reqs.data?.requiredDocuments ?? []).filter((d) => !a?.documents.some((x) => x.docType === d));
  const label = (d: string) => tr(DOC_LABELS[d] ?? { ar: d, en: d });
  return (
    <Page title={tr({ ar: 'طلب التسجيل كصاحب خدمة', en: 'Provider application' })}>
      {provider && <Notice kind="success">{tr({ ar: 'تم اعتماد حسابك. يمكنك إضافة خدماتك من قائمة الخدمات.', en: 'Your account is approved. Add your services from the Services menu.' })}</Notice>}
      <ErrorBox error={apps.error ?? create.error ?? update.error} />
      {a && (
        <Card title={tr({ ar: 'حالة الطلب', en: 'Application status' })}>
          <Detail items={[
            [tr({ ar: 'الحالة', en: 'Status' }), <Badge key="s" group="application" value={a.status} />],
            [tr({ ar: 'أُرسل', en: 'Submitted' }), <DateTime key="d" value={a.submittedAt} />],
            [tr({ ar: 'ملاحظة الإدارة', en: 'Note from the administration' }), a.decisionReason],
          ]} />
          {a.status === 'needs_info' && <Notice kind="warning">{tr({ ar: 'طلبت الإدارة معلومات إضافية؛ عدّل الطلب ثم أعد إرساله.', en: 'The administration asked for more information; update the application and submit it again.' })}</Notice>}
        </Card>
      )}
      {(editable || startNew) && (
        <Card title={startNew ? tr({ ar: 'بيانات النشاط', en: 'Business details' }) : tr({ ar: 'تعديل البيانات', en: 'Edit details' })}>
          <Form key={a?.id ?? 'new'} fields={fields(startNew ? undefined : a, session.countryCode ?? '', session.phone ?? '')} busy={create.isPending || update.isPending}
            onSubmit={(v) => (startNew ? create.mutate(v) : update.mutate(Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'countryCode'))))} />
        </Card>
      )}
      {a && editable && (
        <Card title={tr({ ar: 'الوثائق', en: 'Documents' })}>
          <p className="muted">{tr({ ar: 'الوثائق المطلوبة', en: 'Required documents' })}: {(reqs.data?.requiredDocuments ?? []).map(label).join('، ')}</p>
          <DataTable rows={a.documents} columns={[
            { key: 'docType', label: { ar: 'النوع', en: 'Type' }, render: (d) => label(d.docType) },
            { key: 'originalName', label: { ar: 'الملف', en: 'File' }, render: (d) => <a href={`/bff/v1/provider-applications/${a.id}/documents/${d.id}`} target="_blank" rel="noopener noreferrer">{d.originalName}</a> },
            { key: 'createdAt', label: { ar: 'رُفع', en: 'Uploaded' }, render: (d) => <DateTime value={d.createdAt} /> },
          ]} />
          <div className="row gap" style={{ marginTop: 12 }}>
            <ActionButton label={tr({ ar: 'رفع وثيقة', en: 'Upload document' })} fields={[
              { name: 'docType', label: { ar: 'النوع', en: 'Type' }, type: 'select', required: true, options: [...new Set([...(reqs.data?.requiredDocuments ?? []), 'other'])].map((d) => ({ value: d, label: DOC_LABELS[d] ?? { ar: 'أخرى', en: 'Other' } })) },
              { name: 'file', label: { ar: 'الملف (PDF أو صورة)', en: 'File (PDF or image)' }, type: 'file', required: true },
            ]} run={(api, v) => { const f = new FormData(); f.append('docType', String(v.docType)); f.append('file', v.file as File); return api.upload(`/v1/provider-applications/${a.id}/documents`, f); }} />
            <ActionButton variant="primary" label={tr({ ar: 'إرسال الطلب للمراجعة', en: 'Submit for review' })} disabled={missing.length > 0}
              fields={[{ name: 'acceptTerms', label: { ar: 'أوافق على شروط أصحاب الخدمات', en: 'I accept the provider terms' }, type: 'checkbox', required: true }]}
              run={(api, v) => api.post(`/v1/provider-applications/${a.id}/submit`, { acceptTerms: v.acceptTerms === true })} />
          </div>
          {missing.length > 0 && <Notice kind="warning">{tr({ ar: 'ناقص', en: 'Missing' })}: {missing.map(label).join('، ')}</Notice>}
        </Card>
      )}
      {a && ['draft', 'submitted', 'needs_info'].includes(a.status) && (
        <ActionButton variant="danger" label={tr({ ar: 'إلغاء الطلب', en: 'Cancel application' })} run={(api) => api.post(`/v1/provider-applications/${a.id}/cancel`)} />
      )}
      {a && a.history.length > 0 && (
        <Card title={tr({ ar: 'السجل', en: 'History' })}>
          <DataTable rows={a.history.map((h, i) => ({ ...h, id: String(i) }))} columns={[
            { key: 'at', label: { ar: 'الوقت', en: 'Time' }, render: (h) => <DateTime value={h.at} /> },
            { key: 'to', label: { ar: 'الحالة', en: 'Status' }, render: (h) => <Badge group="application" value={h.to} /> },
            { key: 'reason', label: { ar: 'الملاحظة', en: 'Note' } },
          ]} />
        </Card>
      )}
    </Page>
  );
}
