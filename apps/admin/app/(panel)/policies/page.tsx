'use client';
import { useGet, useTr } from '@events/web-kit/client';
import { ActionButton, DataTable, ErrorBox, Loading, Page, Text } from '@events/web-kit/ui';

type Policy = { id: string; providerId: string | null; name: Record<string, string>; description: Record<string, string>; tiers: { hoursBefore: number; refundPercentOfPaid: number }[]; depositRefundable: boolean; selfCancelAllowed: boolean; requiresManualReview: boolean; isActive: boolean };

export default function Policies() {
  const tr = useTr();
  const { data, error, isLoading } = useGet<Policy[]>('/v1/admin/cancellation-policies');
  return (
    <Page title={tr({ ar: 'سياسات الإلغاء', en: 'Cancellation policies' })} actions={
      <ActionButton variant="primary" label={tr({ ar: 'سياسة عامة جديدة', en: 'New platform policy' })}
        note={tr({ ar: 'السياسة تُنسخ في كل حجز عند إنشائه؛ تعديلها لاحقًا لا يغير الحجوزات السابقة.', en: 'A policy is copied into each booking when created; later changes never alter past bookings.' })}
        fields={[
          { name: 'name', label: { ar: 'الاسم', en: 'Name' }, type: 'i18n', required: true },
          { name: 'description', label: { ar: 'الوصف للعميل', en: 'Description for customers' }, type: 'i18n', required: true },
          { name: 'tiers', label: { ar: 'الشرائح (JSON)', en: 'Tiers (JSON)' }, type: 'json', required: true,
            defaultValue: [{ hoursBefore: 720, refundPercentOfPaid: 100 }, { hoursBefore: 168, refundPercentOfPaid: 50 }, { hoursBefore: 0, refundPercentOfPaid: 0 }],
            help: { ar: 'الإلغاء قبل hoursBefore ساعة يسترد refundPercentOfPaid% من المدفوع', en: 'Cancelling at least hoursBefore hours ahead refunds refundPercentOfPaid% of what was paid' } },
          { name: 'depositRefundable', label: { ar: 'العربون قابل للاسترداد', en: 'Deposit refundable' }, type: 'checkbox' },
          { name: 'selfCancelAllowed', label: { ar: 'يستطيع العميل الإلغاء بنفسه', en: 'Customer can cancel directly' }, type: 'checkbox', defaultValue: true },
          { name: 'requiresManualReview', label: { ar: 'يتطلب مراجعة الإدارة', en: 'Requires staff review' }, type: 'checkbox' },
        ]}
        run={(api, v) => api.post('/v1/admin/cancellation-policies', v)} />
    }>
      <ErrorBox error={error} />
      {isLoading ? <Loading /> : (
        <DataTable rows={data ?? []} columns={[
          { key: 'name', label: { ar: 'الاسم', en: 'Name' }, render: (p) => <Text value={p.name} /> },
          { key: 'owner', label: { ar: 'المالك', en: 'Owner' }, render: (p) => (p.providerId ? tr({ ar: 'صاحب خدمة', en: 'Provider' }) : tr({ ar: 'المنصة', en: 'Platform' })) },
          { key: 'tiers', label: { ar: 'الشرائح', en: 'Tiers' }, render: (p) => p.tiers.map((t) => `≥${t.hoursBefore}h → ${t.refundPercentOfPaid}%`).join(' · ') },
          { key: 'depositRefundable', label: { ar: 'العربون مسترد', en: 'Deposit refundable' } },
          { key: 'selfCancelAllowed', label: { ar: 'إلغاء ذاتي', en: 'Self-cancel' } },
          { key: 'requiresManualReview', label: { ar: 'مراجعة', en: 'Review' } },
          { key: 'isActive', label: { ar: 'مفعّلة', en: 'Active' } },
        ]} />
      )}
    </Page>
  );
}
