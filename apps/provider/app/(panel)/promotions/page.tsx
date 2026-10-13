'use client';
import { localized } from '@events/shared';
import { useApp, useGet, useTr } from '@events/web-kit/client';
import { ActionButton, DataTable, DateTime, ErrorBox, Loading, Money, Notice, Page, Text } from '@events/web-kit/ui';
import { useCurrencyOptions } from '@/lib/options';

type Promo = { id: string; code: string; name: Record<string, string>; discountType: string; discountValue: string; currency: string | null; startsAt: string; endsAt: string; isActive: boolean; timesUsed: number; discountGiven: string };

export default function Promotions() {
  const tr = useTr();
  const { lang } = useApp();
  const currencies = useCurrencyOptions();
  const services = (useGet<{ id: string; title: Record<string, string> }[]>('/v1/provider/services').data ?? []).map((s) => ({ value: s.id, label: localized(s.title, lang) }));
  const { data, error, isLoading } = useGet<Promo[]>('/v1/provider/promotions');
  return (
    <Page title={tr({ ar: 'عروضي', en: 'My promotions' })} actions={
      <ActionButton variant="primary" label={tr({ ar: 'كوبون جديد', en: 'New coupon' })} fields={[
        { name: 'code', label: { ar: 'الرمز', en: 'Code' }, required: true },
        { name: 'name', label: { ar: 'الاسم', en: 'Name' }, type: 'i18n', required: true },
        { name: 'discountType', label: { ar: 'نوع الخصم', en: 'Discount type' }, type: 'select', required: true, options: [{ value: 'percent', label: { ar: 'نسبة', en: 'Percent' } }, { value: 'fixed', label: { ar: 'مبلغ', en: 'Fixed' } }] },
        { name: 'discountValue', label: { ar: 'القيمة', en: 'Value' }, type: 'decimal', required: true },
        { name: 'currency', label: { ar: 'العملة (للمبلغ)', en: 'Currency (fixed)' }, type: 'select', options: currencies },
        { name: 'maxDiscount', label: { ar: 'أقصى خصم', en: 'Maximum discount' }, type: 'decimal' },
        { name: 'startsAt', label: { ar: 'يبدأ', en: 'Starts' }, type: 'datetime', required: true },
        { name: 'endsAt', label: { ar: 'ينتهي', en: 'Ends' }, type: 'datetime', required: true },
        { name: 'usageLimitTotal', label: { ar: 'حد الاستخدام', en: 'Usage limit' }, type: 'number' },
        { name: 'serviceIds', label: { ar: 'الخدمات', en: 'Services' }, type: 'multiselect', required: true, options: services },
      ]} run={(api, v) => api.post('/v1/provider/promotions', v)} />
    }>
      <Notice>{tr({ ar: 'خصم كوبوناتك تتحمله أنت ويُخصم من مستحقاتك عن الحجوزات التي استُخدم فيها.', en: 'Your coupons are borne by you and reduce your earnings on the bookings they are used for.' })}</Notice>
      <ErrorBox error={error} />
      {isLoading ? <Loading /> : (
        <DataTable rows={data ?? []} columns={[
          { key: 'code', label: { ar: 'الرمز', en: 'Code' }, render: (p) => <code>{p.code}</code> },
          { key: 'name', label: { ar: 'الاسم', en: 'Name' }, render: (p) => <Text value={p.name} /> },
          { key: 'discount', label: { ar: 'الخصم', en: 'Discount' }, render: (p) => (p.discountType === 'percent' ? `${p.discountValue}%` : `${p.discountValue} ${p.currency ?? ''}`) },
          { key: 'period', label: { ar: 'الفترة', en: 'Period' }, render: (p) => <><DateTime value={p.startsAt} dateOnly /> → <DateTime value={p.endsAt} dateOnly /></> },
          { key: 'timesUsed', label: { ar: 'الاستخدام', en: 'Used' } },
          { key: 'discountGiven', label: { ar: 'إجمالي الخصم', en: 'Discount given' }, render: (p) => <Money amount={p.discountGiven} currency={p.currency} /> },
          { key: 'isActive', label: { ar: 'مفعّل', en: 'Active' } },
          { key: 'off', label: '', render: (p) => p.isActive ? <ActionButton label={tr({ ar: 'إيقاف', en: 'Deactivate' })} run={(api) => api.post(`/v1/provider/promotions/${p.id}/deactivate`)} /> : null },
        ]} />
      )}
    </Page>
  );
}
