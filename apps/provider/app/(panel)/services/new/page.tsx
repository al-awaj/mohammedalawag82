'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { localized } from '@events/shared';
import { useAction, useApp, useGet, useTr } from '@events/web-kit/client';
import { Card, Empty, ErrorBox, Form, Loading, Notice, Page } from '@events/web-kit/ui';
import { attributeFields, splitAttributes } from '@/lib/fields';
import { serviceFields, type ServiceType } from '@/lib/service-form';
import { useCurrencyOptions, usePolicyOptions } from '@/lib/options';

export default function NewService() {
  const tr = useTr();
  const { lang } = useApp();
  const router = useRouter();
  const types = useGet<ServiceType[]>('/v1/provider/service-types');
  const currencies = useCurrencyOptions();
  const policies = usePolicyOptions();
  const [typeId, setTypeId] = useState('');
  const type = types.data?.find((t) => t.id === typeId);
  const create = useAction((api, v: Record<string, unknown>) => api.post<{ id: string }>('/v1/provider/services', v));
  if (types.isLoading) return <Loading />;
  return (
    <Page title={tr({ ar: 'خدمة جديدة', en: 'New service' })}>
      <ErrorBox error={types.error ?? create.error} />
      {!types.data?.length ? <Empty>{tr({ ar: 'لا توجد أنواع خدمات مسموحة لحسابك بعد. تواصل مع الإدارة.', en: 'No service types are enabled for your account yet. Contact the administration.' })}</Empty> : (
        <>
          <div className="filters">
            <label className="filter"><span>{tr({ ar: 'نوع الخدمة', en: 'Service type' })}</span>
              <select name="serviceTypeId" value={typeId} onChange={(e) => setTypeId(e.target.value)}>
                <option value="">—</option>
                {types.data.map((t) => <option key={t.id} value={t.id}>{localized(t.name, lang)}</option>)}
              </select>
            </label>
          </div>
          {type && (
            <Card>
              <Notice>{tr({ ar: `تُحفظ الخدمة كمسودة. أضف ${type.minImages} صورة على الأقل ثم أرسلها للمراجعة.`, en: `The service is saved as a draft. Add at least ${type.minImages} image(s), then submit it for review.` })}</Notice>
              <Form key={type.id} busy={create.isPending} submitLabel={tr({ ar: 'حفظ كمسودة', en: 'Save draft' })}
                fields={[...serviceFields(type, undefined, currencies, policies), ...attributeFields(type.fields)]}
                onSubmit={(v) => create.mutate({ ...splitAttributes(v), serviceTypeId: type.id }, { onSuccess: (r) => router.push(`/services/${r.id}`) })} />
            </Card>
          )}
        </>
      )}
    </Page>
  );
}
