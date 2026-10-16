'use client';
import { useGet, useTr } from '@events/web-kit/client';
import { ActionButton, DataTable, DateTime, ErrorBox, Loading, Money, Notice, Page, reasonField, Text } from '@events/web-kit/ui';
import { useCountries, useCurrencies } from '@/lib/util';

type Promo = { id: string; code: string; name: Record<string, string>; discountType: string; discountValue: string; currency: string | null; maxDiscount: string | null; minBookingTotal: string | null; startsAt: string; endsAt: string; usageLimitTotal: number | null; usageLimitPerCustomer: number | null; countryId: string | null; countryIds: string[] | null; providerId: string | null; costBearer: string; providerSharePercent: string | null; isActive: boolean; timesUsed: number; discountGiven: string };

const BEARER: Record<string, { ar: string; en: string }> = { platform: { ar: 'المنصة', en: 'Platform' }, provider: { ar: 'صاحب الخدمة', en: 'Provider' }, shared: { ar: 'مشترك', en: 'Shared' } };

export default function Promotions() {
  const tr = useTr();
  const countries = useCountries();
  const currencies = useCurrencies();
  const { data, error, isLoading } = useGet<Promo[]>('/v1/admin/promotions');
  return (
    <Page title={tr({ ar: 'العروض والكوبونات', en: 'Promotions & coupons' })} actions={
      <ActionButton variant="primary" label={tr({ ar: 'كوبون جديد', en: 'New coupon' })}
        note={tr({ ar: 'يجب تحديد من يتحمل الخصم. خصم المنصة لا يُنقص مستحقات صاحب الخدمة ويُسجل مصروفًا على المنصة.', en: 'Who bears the discount must be set. A platform-borne discount never reduces provider earnings; it is a platform expense.' })}
        fields={[
          { name: 'code', label: { ar: 'الرمز', en: 'Code' }, required: true },
          { name: 'name', label: { ar: 'الاسم', en: 'Name' }, type: 'i18n', required: true },
          { name: 'terms', label: { ar: 'الشروط', en: 'Terms' }, type: 'i18n' },
          { name: 'discountType', label: { ar: 'نوع الخصم', en: 'Discount type' }, type: 'select', required: true, options: [{ value: 'percent', label: { ar: 'نسبة', en: 'Percent' } }, { value: 'fixed', label: { ar: 'مبلغ', en: 'Fixed' } }] },
          { name: 'discountValue', label: { ar: 'القيمة', en: 'Value' }, type: 'decimal', required: true },
          { name: 'currency', label: { ar: 'العملة', en: 'Currency' }, type: 'select', options: currencies },
          { name: 'maxDiscount', label: { ar: 'أقصى خصم', en: 'Maximum discount' }, type: 'decimal' },
          { name: 'minBookingTotal', label: { ar: 'أقل قيمة حجز', en: 'Minimum booking total' }, type: 'decimal' },
          { name: 'startsAt', label: { ar: 'يبدأ', en: 'Starts' }, type: 'datetime', required: true },
          { name: 'endsAt', label: { ar: 'ينتهي', en: 'Ends' }, type: 'datetime', required: true },
          { name: 'usageLimitTotal', label: { ar: 'حد الاستخدام الإجمالي', en: 'Total usage limit' }, type: 'number' },
          { name: 'usageLimitPerCustomer', label: { ar: 'حد الاستخدام لكل عميل', en: 'Per-customer limit' }, type: 'number' },
          { name: 'countryIds', label: { ar: 'الدول (اتركها فارغة لكل الدول)', en: 'Countries (empty = all countries)' }, type: 'multiselect', options: countries.options },
          { name: 'costBearer', label: { ar: 'من يتحمل الخصم', en: 'Who bears the discount' }, type: 'select', required: true, options: Object.entries(BEARER).map(([value, label]) => ({ value, label })) },
          { name: 'providerSharePercent', label: { ar: 'حصة صاحب الخدمة % (للمشترك)', en: 'Provider share % (shared)' }, type: 'number' },
        ]}
        run={(api, v) => {
          const { countryIds, ...rest } = v;
          const ids = (countryIds as string[] | undefined) ?? [];
          return api.post('/v1/admin/promotions', { ...rest, ...(ids.length === 1 ? { countryId: ids[0] } : ids.length > 1 ? { countryIds: ids } : {}) });
        }} />
    }>
      <Notice>{tr({ ar: 'العروض تقلل ما يدفعه العميل فقط، ولا توجد رسوم منصة إضافية.', en: 'Promotions only reduce what the customer pays; there is no extra platform fee.' })}</Notice>
      <ErrorBox error={error} />
      {isLoading ? <Loading /> : (
        <DataTable rows={data ?? []} columns={[
          { key: 'code', label: { ar: 'الرمز', en: 'Code' }, render: (p) => <code>{p.code}</code> },
          { key: 'name', label: { ar: 'الاسم', en: 'Name' }, render: (p) => <Text value={p.name} /> },
          { key: 'discount', label: { ar: 'الخصم', en: 'Discount' }, render: (p) => (p.discountType === 'percent' ? `${p.discountValue}%` : `${p.discountValue} ${p.currency ?? ''}`) },
          { key: 'costBearer', label: { ar: 'يتحمله', en: 'Borne by' }, render: (p) => tr(BEARER[p.costBearer] ?? { ar: p.costBearer, en: p.costBearer }) },
          { key: 'period', label: { ar: 'الفترة', en: 'Period' }, render: (p) => <><DateTime value={p.startsAt} dateOnly /> → <DateTime value={p.endsAt} dateOnly /></> },
          { key: 'countries', label: { ar: 'الدول', en: 'Countries' }, render: (p) => (p.countryIds ?? (p.countryId ? [p.countryId] : [])).map(countries.code).join('، ') || tr({ ar: 'الكل', en: 'All' }) },
          { key: 'timesUsed', label: { ar: 'مرات الاستخدام', en: 'Used' } },
          { key: 'discountGiven', label: { ar: 'إجمالي الخصم', en: 'Discount given' }, render: (p) => <Money amount={p.discountGiven} currency={p.currency} /> },
          { key: 'isActive', label: { ar: 'مفعّل', en: 'Active' } },
          { key: 'actions', label: '', render: (p) => (
            <ActionButton label={tr({ ar: 'تعديل', en: 'Edit' })} fields={[
              { name: 'isActive', label: { ar: 'مفعّل', en: 'Active' }, type: 'checkbox', defaultValue: p.isActive },
              { name: 'endsAt', label: { ar: 'ينتهي', en: 'Ends' }, type: 'datetime', defaultValue: p.endsAt },
              { name: 'usageLimitTotal', label: { ar: 'حد الاستخدام', en: 'Usage limit' }, type: 'number', defaultValue: p.usageLimitTotal ?? undefined },
              reasonField(),
            ]} run={(api, v) => api.patch(`/v1/admin/promotions/${p.id}`, v)} />
          ) },
        ]} />
      )}
    </Page>
  );
}
