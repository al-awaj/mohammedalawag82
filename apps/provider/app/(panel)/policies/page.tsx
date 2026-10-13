'use client';
import { useGet, useTr } from '@events/web-kit/client';
import { ActionButton, DataTable, ErrorBox, Loading, Notice, Page, Text } from '@events/web-kit/ui';

type Policy = { id: string; providerId: string | null; name: Record<string, string>; tiers: { hoursBefore: number; refundPercentOfPaid: number }[]; depositRefundable: boolean; selfCancelAllowed: boolean; requiresManualReview: boolean; isActive: boolean };

export default function Policies() {
  const tr = useTr();
  const { data, error, isLoading } = useGet<Policy[]>('/v1/provider/cancellation-policies');
  return (
    <Page title={tr({ ar: 'سياسات الإلغاء', en: 'Cancellation policies' })} actions={
      <ActionButton variant="primary" label={tr({ ar: 'سياسة جديدة', en: 'New policy' })} fields={[
        { name: 'name', label: { ar: 'الاسم', en: 'Name' }, type: 'i18n', required: true },
        { name: 'description', label: { ar: 'الوصف الذي يراه العميل', en: 'Description shown to customers' }, type: 'i18n', required: true },
        { name: 'tiers', label: { ar: 'الشرائح (JSON)', en: 'Tiers (JSON)' }, type: 'json', required: true,
          defaultValue: [{ hoursBefore: 720, refundPercentOfPaid: 100 }, { hoursBefore: 168, refundPercentOfPaid: 50 }, { hoursBefore: 0, refundPercentOfPaid: 0 }],
          help: { ar: 'الإلغاء قبل hoursBefore ساعة على الأقل يسترد refundPercentOfPaid% من المدفوع (عدا العربون غير المسترد).', en: 'Cancelling at least hoursBefore hours ahead refunds refundPercentOfPaid% of what was paid (non-refundable deposit aside).' } },
        { name: 'depositRefundable', label: { ar: 'العربون قابل للاسترداد', en: 'Deposit refundable' }, type: 'checkbox' },
        { name: 'selfCancelAllowed', label: { ar: 'يستطيع العميل الإلغاء بنفسه', en: 'Customer can cancel directly' }, type: 'checkbox', defaultValue: true },
      ]} run={(api, v) => api.post('/v1/provider/cancellation-policies', v)} />
    }>
      <Notice>{tr({ ar: 'السياسة تُحفظ في الحجز وقت إنشائه؛ تغييرها لاحقًا لا يمس الحجوزات السابقة.', en: 'The policy is frozen into each booking when it is made; later changes never affect past bookings.' })}</Notice>
      <ErrorBox error={error} />
      {isLoading ? <Loading /> : (
        <DataTable rows={data ?? []} columns={[
          { key: 'name', label: { ar: 'الاسم', en: 'Name' }, render: (p) => <Text value={p.name} /> },
          { key: 'tiers', label: { ar: 'الشرائح', en: 'Tiers' }, render: (p) => p.tiers.map((t) => `≥${t.hoursBefore}h → ${t.refundPercentOfPaid}%`).join(' · ') },
          { key: 'depositRefundable', label: { ar: 'العربون مسترد', en: 'Deposit refundable' } },
          { key: 'selfCancelAllowed', label: { ar: 'إلغاء ذاتي', en: 'Self-cancel' } },
          { key: 'owner', label: { ar: 'المالك', en: 'Owner' }, render: (p) => (p.providerId ? tr({ ar: 'أنت', en: 'You' }) : tr({ ar: 'المنصة', en: 'Platform' })) },
        ]} />
      )}
    </Page>
  );
}
