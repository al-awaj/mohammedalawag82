'use client';
import { useCan, useTr } from '@events/web-kit/client';
import { ActionButton, DateTime, ListView, Page, reasonField } from '@events/web-kit/ui';

type Row = {
  id: string; providerId: string; businessName: string; activityType: string; countryCode: string; changes: Record<string, unknown>;
  note: string | null; status: string; decisionReason: string | null; decidedBy: string | null; decidedAt: string | null; createdAt: string;
};
const STATUS = [
  { value: 'pending', label: { ar: 'بانتظار المراجعة', en: 'Pending' } }, { value: 'approved', label: { ar: 'معتمد', en: 'Approved' } },
  { value: 'rejected', label: { ar: 'مرفوض', en: 'Rejected' } }, { value: 'withdrawn', label: { ar: 'مسحوب', en: 'Withdrawn' } },
];
const FIELD: Record<string, { ar: string; en: string }> = {
  businessName: { ar: 'الاسم التجاري', en: 'Business name' }, activityType: { ar: 'نوع النشاط', en: 'Activity' }, payoutDetails: { ar: 'بيانات التحويل', en: 'Payout details' },
};

/** Business-name, activity and payout changes requested by approved providers (clause 7). */
export default function ProviderChanges() {
  const tr = useTr();
  const can = useCan();
  const show = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));
  return (
    <Page title={tr({ ar: 'طلبات تعديل بيانات أصحاب الخدمات', en: 'Provider profile change requests' })}>
      <ListView<Row>
        path="/v1/admin/provider-change-requests"
        select={(d) => (d as { items: Row[] } | undefined)?.items ?? []}
        filters={[{ name: 'status', label: tr({ ar: 'الحالة', en: 'Status' }), type: 'select', options: STATUS }]}
        columns={[
          { key: 'businessName', label: { ar: 'النشاط الحالي', en: 'Current business' } },
          { key: 'countryCode', label: { ar: 'الدولة', en: 'Country' } },
          { key: 'changes', label: { ar: 'التعديل المطلوب', en: 'Requested change' }, render: (r) => (
            <ul className="plain">{Object.entries(r.changes).map(([k, v]) => <li key={k}><strong>{tr(FIELD[k] ?? { ar: k, en: k })}:</strong> {show(v)}</li>)}</ul>
          ) },
          { key: 'note', label: { ar: 'ملاحظة', en: 'Note' }, render: (r) => r.note ?? '' },
          { key: 'status', label: { ar: 'الحالة', en: 'Status' }, render: (r) => tr(STATUS.find((s) => s.value === r.status)?.label ?? { ar: r.status, en: r.status }) },
          { key: 'createdAt', label: { ar: 'التاريخ', en: 'Date' }, render: (r) => <DateTime value={r.createdAt} /> },
          { key: 'actions', label: '', render: (r) => r.status === 'pending' && can('providers.manage') ? (
            <div className="row gap">
              <ActionButton variant="primary" label={tr({ ar: 'اعتماد', en: 'Approve' })}
                note={tr({ ar: 'يُطبق التعديل فورًا على الملف ولا يغير المستندات والحجوزات السابقة.', en: 'The change applies to the profile at once and never alters past documents or bookings.' })}
                run={(api) => api.post(`/v1/admin/provider-change-requests/${r.id}/approve`)} />
              <ActionButton label={tr({ ar: 'رفض', en: 'Reject' })} fields={[reasonField()]} run={(api, v) => api.post(`/v1/admin/provider-change-requests/${r.id}/reject`, v)} />
            </div>
          ) : r.decisionReason ?? '' },
        ]}
      />
    </Page>
  );
}
