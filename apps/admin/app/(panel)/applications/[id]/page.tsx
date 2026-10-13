'use client';
import { use } from 'react';
import { useCan, useGet, useTr } from '@events/web-kit/client';
import { ActionButton, Badge, Card, DataTable, DateTime, Detail, ErrorBox, Json, Loading, Page, reasonField } from '@events/web-kit/ui';

interface App {
  id: string; status: string; businessName: string; activityType: string; countryCode: string; countryId: string; city: string; phone: string;
  email: string | null; address: string | null; description: string | null; payoutDetails: Record<string, unknown> | null;
  submittedAt: string | null; decidedAt: string | null; decidedBy: string | null; decisionReason: string | null;
  documents: { id: string; docType: string; originalName: string; mimeType: string; sizeBytes: number; createdAt: string }[];
  history: { from: string | null; to: string; reason: string | null; actor: string | null; at: string }[];
}

/** Which staff actions apply to each status (mirrors the API's transition table; the API is authoritative). */
const ACTIONS: Record<string, string[]> = {
  submitted: ['start_review', 'request_info', 'approve', 'reject'],
  under_review: ['request_info', 'approve', 'reject'],
  needs_info: ['reject'],
  approved: ['suspend'],
  suspended: ['reactivate'],
};
const LABELS: Record<string, { ar: string; en: string }> = {
  start_review: { ar: 'بدء المراجعة', en: 'Start review' }, request_info: { ar: 'طلب معلومات', en: 'Request information' },
  approve: { ar: 'قبول', en: 'Approve' }, reject: { ar: 'رفض', en: 'Reject' }, suspend: { ar: 'إيقاف', en: 'Suspend' }, reactivate: { ar: 'إعادة التفعيل', en: 'Reactivate' },
};
const PERM: Record<string, string> = { approve: 'provider_applications.approve', reject: 'provider_applications.reject', suspend: 'providers.manage', reactivate: 'providers.manage' };

export default function Application({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const tr = useTr();
  const can = useCan();
  const { data: a, error, isLoading } = useGet<App>(`/v1/admin/provider-applications/${id}`);
  if (isLoading) return <Loading />;
  if (error || !a) return <ErrorBox error={error} />;
  return (
    <Page title={a.businessName} actions={(ACTIONS[a.status] ?? []).filter((x) => can(PERM[x] ?? 'provider_applications.review')).map((action) => (
      <ActionButton key={action} label={tr(LABELS[action]!)} variant={action === 'approve' ? 'primary' : action === 'reject' || action === 'suspend' ? 'danger' : 'secondary'}
        fields={[reasonField(action !== 'start_review' && action !== 'approve')]}
        run={(api, v) => api.post(`/v1/admin/provider-applications/${id}/actions`, { action, ...v })} />
    ))}>
      <Card>
        <Detail items={[
          [tr({ ar: 'الحالة', en: 'Status' }), <Badge key="s" group="application" value={a.status} />],
          [tr({ ar: 'نوع النشاط', en: 'Activity' }), a.activityType],
          [tr({ ar: 'الدولة / المدينة', en: 'Country / city' }), `${a.countryCode} · ${a.city}`],
          [tr({ ar: 'الجوال', en: 'Phone' }), <span key="p" dir="ltr">{a.phone}</span>],
          [tr({ ar: 'البريد', en: 'Email' }), a.email],
          [tr({ ar: 'العنوان', en: 'Address' }), a.address],
          [tr({ ar: 'أُرسل', en: 'Submitted' }), <DateTime key="d" value={a.submittedAt} />],
          [tr({ ar: 'القرار', en: 'Decision' }), a.decidedAt ? `${a.decidedBy ?? ''} · ${a.decisionReason ?? ''}` : '—'],
        ]} />
        {a.description && <p>{a.description}</p>}
      </Card>
      <Card title={tr({ ar: 'بيانات الاستلام المالي', en: 'Payout details' })}>
        {a.payoutDetails ? <Json value={a.payoutDetails} /> : <p className="muted">{tr({ ar: 'مخفية — تتطلب صلاحية عرض البيانات الحساسة.', en: 'Hidden — requires the sensitive-data permission.' })}</p>}
      </Card>
      <Card title={tr({ ar: 'المستندات', en: 'Documents' })}>
        <DataTable rows={a.documents} columns={[
          { key: 'docType', label: { ar: 'النوع', en: 'Type' } },
          { key: 'originalName', label: { ar: 'الملف', en: 'File' }, render: (d) => <a href={`/bff/v1/provider-applications/${id}/documents/${d.id}`} target="_blank" rel="noopener noreferrer">{d.originalName}</a> },
          { key: 'mimeType', label: { ar: 'الصيغة', en: 'Format' } },
          { key: 'createdAt', label: { ar: 'رُفع', en: 'Uploaded' }, render: (d) => <DateTime value={d.createdAt} /> },
        ]} />
      </Card>
      <Card title={tr({ ar: 'السجل', en: 'History' })}>
        <DataTable rows={a.history.map((h, i) => ({ ...h, id: String(i) }))} columns={[
          { key: 'at', label: { ar: 'الوقت', en: 'Time' }, render: (h) => <DateTime value={h.at} /> },
          { key: 'from', label: { ar: 'من', en: 'From' }, render: (h) => <Badge group="application" value={h.from} /> },
          { key: 'to', label: { ar: 'إلى', en: 'To' }, render: (h) => <Badge group="application" value={h.to} /> },
          { key: 'actor', label: { ar: 'بواسطة', en: 'By' } },
          { key: 'reason', label: { ar: 'السبب', en: 'Reason' } },
        ]} />
      </Card>
    </Page>
  );
}
