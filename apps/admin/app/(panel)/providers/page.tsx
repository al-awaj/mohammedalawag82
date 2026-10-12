'use client';
import { useCan, useGet, useTr } from '@events/web-kit/client';
import { ActionButton, Badge, DateTime, ListView, Page, reasonField } from '@events/web-kit/ui';
import { opts } from '@/lib/util';

type Row = { id: string; businessName: string; activityType: string; countryCode: string; city: string; status: string; applicationId: string; phone: string; createdAt: string };
type Type = { id: string; code: string; name: Record<string, string>; isActive: boolean };

export default function Providers() {
  const tr = useTr();
  const can = useCan();
  const types = useGet<Type[]>(can('service_types.manage') ? '/v1/admin/service-types' : null).data ?? [];
  return (
    <Page title={tr({ ar: 'أصحاب الخدمات', en: 'Providers' })}>
      <ListView<Row>
        path="/v1/admin/providers"
        select={(d) => (d as { items: Row[] } | undefined)?.items ?? []}
        filters={[
          { name: 'status', label: tr({ ar: 'الحالة', en: 'Status' }), type: 'select', options: opts('provider') },
          { name: 'q', label: tr({ ar: 'بحث', en: 'Search' }) },
        ]}
        rowHref={(r) => `/applications/${r.applicationId}`}
        columns={[
          { key: 'businessName', label: { ar: 'النشاط', en: 'Business' } },
          { key: 'countryCode', label: { ar: 'الدولة', en: 'Country' } },
          { key: 'city', label: { ar: 'المدينة', en: 'City' } },
          { key: 'status', label: { ar: 'الحالة', en: 'Status' }, render: (r) => <Badge group="provider" value={r.status} /> },
          { key: 'createdAt', label: { ar: 'منذ', en: 'Since' }, render: (r) => <DateTime value={r.createdAt} dateOnly /> },
          { key: 'actions', label: { ar: 'الإجراءات', en: 'Actions' }, render: (r) => (
            <div className="row gap">
              {can('providers.manage') && types.length > 0 && <ServiceTypes providerId={r.id} types={types} />}
              {can('settlements.approve') && (
                <ActionButton label={tr({ ar: 'التسوية المرحلية', en: 'Interim settlement' })}
                  note={tr({ ar: 'تُسمح التسوية المرحلية فقط باتفاقية موثقة ونسبة قصوى.', en: 'Interim settlement requires a documented agreement and a maximum percentage.' })}
                  fields={[
                    { name: 'eligible', label: { ar: 'مؤهل', en: 'Eligible' }, type: 'checkbox' },
                    { name: 'maxPercent', label: { ar: 'النسبة القصوى %', en: 'Maximum %' }, type: 'number' },
                    { name: 'agreementRef', label: { ar: 'مرجع الاتفاقية', en: 'Agreement reference' } },
                    reasonField(),
                  ]}
                  run={(api, v) => api.patch(`/v1/admin/providers/${r.id}/interim-settlement`, v)} />
              )}
            </div>
          ) },
        ]}
      />
    </Page>
  );
}

function ServiceTypes({ providerId, types }: { providerId: string; types: Type[] }) {
  const tr = useTr();
  const current = useGet<{ id: string }[]>(`/v1/admin/providers/${providerId}/service-types`);
  if (!current.data) return null;
  return (
    <ActionButton label={tr({ ar: 'الأنواع المسموحة', en: 'Allowed types' })}
      fields={[
        { name: 'serviceTypeIds', label: { ar: 'أنواع الخدمات', en: 'Service types' }, type: 'multiselect', defaultValue: current.data.map((t) => t.id),
          options: types.filter((t) => t.isActive).map((t) => ({ value: t.id, label: { ar: t.name.ar ?? t.code, en: t.name.en ?? t.code } })) },
        reasonField(false),
      ]}
      run={(api, v) => api.put(`/v1/admin/providers/${providerId}/service-types`, { serviceTypeIds: v.serviceTypeIds ?? [], ...(v.reason ? { reason: v.reason } : {}) })} />
  );
}
