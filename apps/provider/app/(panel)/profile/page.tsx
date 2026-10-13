'use client';
import { useAction, useGet, useTr } from '@events/web-kit/client';
import { ActionButton, Card, DataTable, DateTime, Detail, ErrorBox, Form, Loading, Notice, Page } from '@events/web-kit/ui';

interface Me {
  businessName: string; activityType: string; countryCode: string; city: string; address: string | null; description: string | null;
  latitude: string | null; longitude: string | null; status: string;
}
interface ChangeRequest { id: string; changes: Record<string, unknown>; note: string | null; status: string; decisionReason: string | null; decidedAt: string | null; createdAt: string }

const STATUS = {
  pending: { ar: 'بانتظار المراجعة', en: 'Pending review' }, approved: { ar: 'معتمد', en: 'Approved' },
  rejected: { ar: 'مرفوض', en: 'Rejected' }, withdrawn: { ar: 'مسحوب', en: 'Withdrawn' },
} as const;
const FIELD = { businessName: { ar: 'الاسم التجاري', en: 'Business name' }, activityType: { ar: 'نوع النشاط', en: 'Activity' }, payoutDetails: { ar: 'بيانات التحويل', en: 'Payout details' } } as const;

/** Business profile after approval: day-to-day details are edited directly; identity and payout changes go to the administration. */
export default function ProfilePage() {
  const tr = useTr();
  const { data: me, error, isLoading } = useGet<Me>('/v1/provider/me');
  const requests = useGet<ChangeRequest[]>('/v1/provider/me/change-requests');
  const save = useAction((api, v: Record<string, unknown>) => api.patch('/v1/provider/me', v));
  if (isLoading) return <Loading />;
  if (error || !me) return <ErrorBox error={error} />;
  const pending = requests.data?.some((r) => r.status === 'pending');
  return (
    <Page title={tr({ ar: 'الملف التجاري', en: 'Business profile' })}>
      <Card title={tr({ ar: 'بيانات النشاط', en: 'Business details' })}>
        <p className="muted">{tr({ ar: 'تظهر هذه البيانات للعملاء حسب إعدادات إظهار الهوية في دولتك.', en: 'Customers see these details according to the identity-visibility setting of your country.' })}</p>
        <ErrorBox error={save.error} />
        {save.isSuccess && <Notice kind="success">{tr({ ar: 'تم الحفظ', en: 'Saved' })}</Notice>}
        <Form key={`${me.city}-${me.address}-${me.description}-${me.latitude}`} busy={save.isPending} fields={[
          { name: 'city', label: { ar: 'المدينة', en: 'City' }, required: true, defaultValue: me.city },
          { name: 'address', label: { ar: 'العنوان', en: 'Address' }, defaultValue: me.address ?? '' },
          { name: 'description', label: { ar: 'نبذة عن النشاط', en: 'About the business' }, type: 'textarea', defaultValue: me.description ?? '' },
          { name: 'latitude', label: { ar: 'خط العرض', en: 'Latitude' }, type: 'decimal', defaultValue: me.latitude ?? '' },
          { name: 'longitude', label: { ar: 'خط الطول', en: 'Longitude' }, type: 'decimal', defaultValue: me.longitude ?? '' },
        ]} onSubmit={(v) => save.mutate({
          city: v.city, address: v.address ?? null, description: v.description ?? null,
          latitude: v.latitude !== undefined ? Number(v.latitude) : null, longitude: v.longitude !== undefined ? Number(v.longitude) : null,
        })} />
      </Card>

      <Card title={tr({ ar: 'الاسم التجاري وبيانات التحويل', en: 'Business name and payout details' })} actions={!pending && me.status === 'active' &&
        <ActionButton variant="primary" label={tr({ ar: 'طلب تعديل', en: 'Request a change' })} fields={[
          { name: 'businessName', label: FIELD.businessName, defaultValue: me.businessName },
          { name: 'activityType', label: FIELD.activityType, defaultValue: me.activityType },
          { name: 'iban', label: { ar: 'رقم الآيبان الجديد (اتركه فارغًا إن لم يتغير)', en: 'New IBAN (leave empty if unchanged)' } },
          { name: 'bankName', label: { ar: 'اسم البنك', en: 'Bank name' } },
          { name: 'note', label: { ar: 'ملاحظة للإدارة', en: 'Note to the administration' }, type: 'textarea' },
        ]} run={(api, v) => {
          const changes: Record<string, unknown> = {};
          if (v.businessName && v.businessName !== me.businessName) changes.businessName = v.businessName;
          if (v.activityType && v.activityType !== me.activityType) changes.activityType = v.activityType;
          if (v.iban) changes.payoutDetails = { iban: v.iban, ...(v.bankName ? { bankName: v.bankName } : {}) };
          return api.post('/v1/provider/me/change-requests', { changes, note: v.note ?? null });
        }} />}>
        <Detail items={[[tr(FIELD.businessName), me.businessName], [tr(FIELD.activityType), me.activityType]]} />
        <Notice>{tr({ ar: 'تغيير الاسم التجاري أو نوع النشاط أو بيانات التحويل يُطبق بعد موافقة الإدارة، ولا يغير المستندات والحجوزات السابقة.', en: 'Changes to the business name, activity or payout details apply after the administration approves them, and never alter past documents or bookings.' })}</Notice>
        <ErrorBox error={requests.error} />
        <DataTable rows={requests.data ?? []} columns={[
          { key: 'createdAt', label: { ar: 'التاريخ', en: 'Date' }, render: (r) => <DateTime value={r.createdAt} /> },
          { key: 'changes', label: { ar: 'المطلوب', en: 'Requested' }, render: (r) => Object.keys(r.changes).map((k) => tr(FIELD[k as keyof typeof FIELD] ?? { ar: k, en: k })).join('، ') },
          { key: 'status', label: { ar: 'الحالة', en: 'Status' }, render: (r) => tr(STATUS[r.status as keyof typeof STATUS] ?? { ar: r.status, en: r.status }) },
          { key: 'decisionReason', label: { ar: 'السبب', en: 'Reason' }, render: (r) => r.decisionReason ?? '' },
          { key: 'actions', label: '', render: (r) => r.status === 'pending'
            ? <ActionButton label={tr({ ar: 'سحب الطلب', en: 'Withdraw' })} run={(api) => api.post(`/v1/provider/me/change-requests/${r.id}/withdraw`)} /> : null },
        ]} />
      </Card>
    </Page>
  );
}
