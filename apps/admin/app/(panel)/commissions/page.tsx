'use client';
import { useGet, useTr } from '@events/web-kit/client';
import { ActionButton, DataTable, DateTime, ErrorBox, Loading, Notice, Page, reasonField } from '@events/web-kit/ui';
import { useCountries, useCurrencies } from '@/lib/util';
import { useProviders } from '@/lib/finance';

type Rule = { id: string; scope: string; countryId: string | null; serviceTypeId: string | null; providerId: string | null; serviceId: string | null; rateType: string; rateValue: string; currency: string | null; priority: number; validFrom: string; validTo: string | null; agreementRef: string | null; isActive: boolean; bookingsApplied: number };

export default function Commissions() {
  const tr = useTr();
  const countries = useCountries();
  const currencies = useCurrencies();
  const providers = useProviders();
  const types = (useGet<{ id: string; code: string }[]>('/v1/admin/service-types').data ?? []).map((t) => ({ value: t.id, label: t.code }));
  const { data, error, isLoading } = useGet<Rule[]>('/v1/admin/commission-rules');
  return (
    <Page title={tr({ ar: 'قواعد العمولة', en: 'Commission rules' })} actions={
      <ActionButton variant="primary" label={tr({ ar: 'قاعدة جديدة', en: 'New rule' })}
        note={tr({ ar: 'العمولة المعتمدة فقط — لا رسوم منصة إضافية على العميل أو صاحب الخدمة. تُطبق القاعدة الأدق ثم الأعلى أولوية، وتُحفظ في كل حجز.', en: 'Approved commission only — no extra platform fee on customers or providers. The most specific, highest-priority rule applies and is frozen in each booking.' })}
        fields={[
          { name: 'scope', label: { ar: 'النطاق', en: 'Scope' }, type: 'select', required: true, options: [
            { value: 'global', label: { ar: 'عام', en: 'Global' } }, { value: 'country', label: { ar: 'دولة', en: 'Country' } }, { value: 'service_type', label: { ar: 'نوع خدمة', en: 'Service type' } },
            { value: 'provider', label: { ar: 'صاحب خدمة', en: 'Provider' } }, { value: 'service', label: { ar: 'خدمة', en: 'Service' } }] },
          { name: 'countryId', label: { ar: 'الدولة', en: 'Country' }, type: 'select', options: countries.options },
          { name: 'serviceTypeId', label: { ar: 'نوع الخدمة', en: 'Service type' }, type: 'select', options: types },
          { name: 'providerId', label: { ar: 'صاحب الخدمة', en: 'Provider' }, type: 'select', options: providers },
          { name: 'serviceId', label: { ar: 'معرّف الخدمة', en: 'Service id' } },
          { name: 'rateType', label: { ar: 'نوع العمولة', en: 'Rate type' }, type: 'select', required: true, options: [{ value: 'percent', label: { ar: 'نسبة %', en: 'Percent' } }, { value: 'fixed', label: { ar: 'مبلغ ثابت', en: 'Fixed amount' } }] },
          { name: 'rateValue', label: { ar: 'القيمة', en: 'Value' }, type: 'decimal', required: true },
          { name: 'currency', label: { ar: 'العملة (للمبلغ الثابت)', en: 'Currency (fixed)' }, type: 'select', options: currencies },
          { name: 'priority', label: { ar: 'الأولوية', en: 'Priority' }, type: 'number' },
          { name: 'validFrom', label: { ar: 'سارية من', en: 'Valid from' }, type: 'datetime' },
          { name: 'validTo', label: { ar: 'سارية حتى', en: 'Valid to' }, type: 'datetime' },
          { name: 'agreementRef', label: { ar: 'مرجع الاتفاقية', en: 'Agreement reference' } },
        ]}
        run={(api, v) => api.post('/v1/admin/commission-rules', v)} />
    }>
      <Notice>{tr({ ar: 'شروط القاعدة لا تُعدل بعد إنشائها؛ لتغييرها أنهِ سريانها وأنشئ قاعدة جديدة.', en: 'A rule’s terms cannot be edited; end it and create a new one.' })}</Notice>
      <ErrorBox error={error} />
      {isLoading ? <Loading /> : (
        <DataTable rows={data ?? []} columns={[
          { key: 'scope', label: { ar: 'النطاق', en: 'Scope' } },
          { key: 'countryId', label: { ar: 'الدولة', en: 'Country' }, render: (r) => countries.code(r.countryId) },
          { key: 'rate', label: { ar: 'العمولة', en: 'Rate' }, render: (r) => (r.rateType === 'percent' ? `${r.rateValue}%` : `${r.rateValue} ${r.currency ?? ''}`) },
          { key: 'priority', label: { ar: 'الأولوية', en: 'Priority' } },
          { key: 'validFrom', label: { ar: 'من', en: 'From' }, render: (r) => <DateTime value={r.validFrom} /> },
          { key: 'validTo', label: { ar: 'حتى', en: 'To' }, render: (r) => <DateTime value={r.validTo} /> },
          { key: 'bookingsApplied', label: { ar: 'حجوزات طُبقت عليها', en: 'Bookings applied' } },
          { key: 'isActive', label: { ar: 'مفعّلة', en: 'Active' } },
          { key: 'actions', label: '', render: (r) => r.isActive ? (
            <ActionButton label={tr({ ar: 'إنهاء/تعطيل', en: 'End / disable' })} fields={[
              { name: 'validTo', label: { ar: 'تنتهي في (اتركه فارغًا للتعطيل الآن)', en: 'Ends at (blank = disable now)' }, type: 'datetime' }, reasonField()]}
              run={(api, v) => api.patch(`/v1/admin/commission-rules/${r.id}`, v.validTo ? v : { ...v, isActive: false })} />
          ) : null },
        ]} />
      )}
    </Page>
  );
}
