'use client';
import { useState } from 'react';
import { useApp, useGet, useTr } from '@events/web-kit/client';
import { ActionButton, Badge, DataTable, DateTime, ErrorBox, ListView, Loading, Notice, Page, reasonField, Tabs } from '@events/web-kit/ui';
import { opts, useCountries } from '@/lib/util';
import { useFunds } from '@/lib/finance';

type Integration = { id: string; providerCode: string; name: string; countryId: string; kind: string; environment: string; secretRef: string; isActive: boolean; lastTestAt: string | null; lastTestStatus: string | null; lastError: string | null; webhookUrl: string };
type Method = { id: string; countryId: string; serviceTypeId: string | null; model: string; method: string; integrationId: string | null; accountId: string | null; proofRequired: boolean; isActive: boolean };

export default function PaymentSettings() {
  const tr = useTr();
  const [tab, setTab] = useState<'integrations' | 'methods' | 'events'>('integrations');
  return (
    <Page title={tr({ ar: 'طرق ومزودو الدفع', en: 'Payment setup' })}>
      <Tabs value={tab} onChange={setTab} tabs={[
        { id: 'integrations', label: tr({ ar: 'مزودو الدفع', en: 'Payment providers' }) },
        { id: 'methods', label: tr({ ar: 'طرق الدفع لكل دولة', en: 'Methods per country' }) },
        { id: 'events', label: tr({ ar: 'إشعارات المزودين', en: 'Provider notifications' }) },
      ]} />
      {tab === 'integrations' ? <Integrations /> : tab === 'methods' ? <Methods /> : <Events />}
    </Page>
  );
}

function Integrations() {
  const tr = useTr();
  const countries = useCountries();
  const { data, error, isLoading } = useGet<Integration[]>('/v1/admin/payment-integrations');
  if (isLoading) return <Loading />;
  return (
    <>
      <Notice>{tr({ ar: 'لا تُدخل أي مفتاح سري هنا: يُحفظ اسم متغير البيئة فقط (secretRef) ويُضبط على الخادم. المتاح حاليًا: مزود تجريبي (sandbox) لا يعمل في الإنتاج.', en: 'Never enter a secret here: only the environment variable name (secretRef) is stored and set on the server. Currently available: a sandbox provider that is refused in production.' })}</Notice>
      <div className="page-actions" style={{ marginBottom: 12 }}>
        <ActionButton variant="primary" label={tr({ ar: 'ربط مزود', en: 'Add provider' })} fields={[
          { name: 'providerCode', label: { ar: 'المزود', en: 'Provider' }, type: 'select', required: true, options: [{ value: 'sandbox', label: 'sandbox' }] },
          { name: 'name', label: { ar: 'الاسم', en: 'Name' }, required: true },
          { name: 'countryId', label: { ar: 'الدولة', en: 'Country' }, type: 'select', required: true, options: countries.options },
          { name: 'kind', label: { ar: 'النوع', en: 'Kind' }, type: 'select', required: true, options: [
            { value: 'gateway', label: { ar: 'بوابة', en: 'Gateway' } }, { value: 'wallet', label: { ar: 'محفظة', en: 'Wallet' } }, { value: 'bank', label: { ar: 'بنك', en: 'Bank' } }, { value: 'transfer_service', label: { ar: 'خدمة تحويل', en: 'Transfer service' } }] },
          { name: 'environment', label: { ar: 'البيئة', en: 'Environment' }, type: 'select', required: true, options: [{ value: 'test', label: 'test' }, { value: 'production', label: 'production' }] },
          { name: 'secretRef', label: { ar: 'اسم متغير البيئة للمفتاح', en: 'Secret environment variable name' }, required: true, placeholder: 'PAY_SANDBOX_SA_SECRET' },
        ]} run={(api, v) => api.post('/v1/admin/payment-integrations', v)} />
      </div>
      <ErrorBox error={error} />
      <DataTable rows={data ?? []} columns={[
        { key: 'name', label: { ar: 'الاسم', en: 'Name' } },
        { key: 'providerCode', label: { ar: 'المزود', en: 'Provider' } },
        { key: 'countryId', label: { ar: 'الدولة', en: 'Country' }, render: (i) => countries.code(i.countryId) },
        { key: 'environment', label: { ar: 'البيئة', en: 'Environment' } },
        { key: 'secretRef', label: { ar: 'متغير المفتاح', en: 'Secret variable' }, render: (i) => <code>{i.secretRef}</code> },
        { key: 'webhookUrl', label: { ar: 'رابط الإشعارات', en: 'Webhook URL' }, render: (i) => <code className="small">{i.webhookUrl}</code> },
        { key: 'lastTestStatus', label: { ar: 'آخر اختبار', en: 'Last test' }, render: (i) => `${i.lastTestStatus ?? '—'} ${i.lastError ?? ''}` },
        { key: 'isActive', label: { ar: 'مفعّل', en: 'Active' } },
        { key: 'actions', label: '', render: (i) => (
          <div className="row gap">
            <ActionButton label={tr({ ar: 'اختبار الاتصال', en: 'Test connection' })} run={(api) => api.post(`/v1/admin/payment-integrations/${i.id}/test`)} />
            <ActionButton label={i.isActive ? tr({ ar: 'تعطيل', en: 'Disable' }) : tr({ ar: 'تفعيل', en: 'Enable' })} fields={[reasonField()]}
              run={(api, v) => api.patch(`/v1/admin/payment-integrations/${i.id}`, { isActive: !i.isActive, ...v })} />
          </div>
        ) },
      ]} />
    </>
  );
}

function Methods() {
  const tr = useTr();
  const { lang } = useApp();
  const countries = useCountries();
  const funds = useFunds(lang);
  const integrations = (useGet<Integration[]>('/v1/admin/payment-integrations').data ?? []).map((i) => ({ value: i.id, label: i.name }));
  const { data, error, isLoading } = useGet<Method[]>('/v1/admin/payment-methods');
  if (isLoading) return <Loading />;
  return (
    <>
      <Notice>{tr({ ar: 'الدفع المباشر لصاحب الخدمة يعمل فقط إذا فُعّل إعداد payments.direct_enabled للدولة.', en: 'Direct payment to providers works only when the payments.direct_enabled setting is on for the country.' })}</Notice>
      <div className="page-actions" style={{ marginBottom: 12 }}>
        <ActionButton variant="primary" label={tr({ ar: 'طريقة دفع جديدة', en: 'New method' })} fields={[
          { name: 'countryId', label: { ar: 'الدولة', en: 'Country' }, type: 'select', required: true, options: countries.options },
          { name: 'model', label: { ar: 'النموذج', en: 'Model' }, type: 'select', required: true, options: opts('paymentModel') },
          { name: 'method', label: { ar: 'الطريقة', en: 'Method' }, type: 'select', required: true, options: opts('paymentMethod').filter((o) => o.value !== 'original_gateway') },
          { name: 'integrationId', label: { ar: 'مزود الدفع (للبطاقات والمحافظ)', en: 'Payment provider (cards, wallets)' }, type: 'select', options: integrations },
          { name: 'accountId', label: { ar: 'الصندوق المستلم (عبر المنصة)', en: 'Receiving fund (platform model)' }, type: 'select', options: funds },
          { name: 'proofRequired', label: { ar: 'يتطلب إثبات دفع', en: 'Proof required' }, type: 'checkbox' },
        ]} run={(api, v) => api.post('/v1/admin/payment-methods', v)} />
      </div>
      <ErrorBox error={error} />
      <DataTable rows={data ?? []} columns={[
        { key: 'countryId', label: { ar: 'الدولة', en: 'Country' }, render: (m) => countries.code(m.countryId) },
        { key: 'model', label: { ar: 'النموذج', en: 'Model' }, render: (m) => <Badge group="paymentModel" value={m.model} /> },
        { key: 'method', label: { ar: 'الطريقة', en: 'Method' }, render: (m) => <Badge group="paymentMethod" value={m.method} /> },
        { key: 'proofRequired', label: { ar: 'إثبات', en: 'Proof' } },
        { key: 'isActive', label: { ar: 'مفعّلة', en: 'Active' } },
        { key: 'actions', label: '', render: (m) => (
          <ActionButton label={m.isActive ? tr({ ar: 'تعطيل', en: 'Disable' }) : tr({ ar: 'تفعيل', en: 'Enable' })} fields={[reasonField()]}
            run={(api, v) => api.patch(`/v1/admin/payment-methods/${m.id}`, { isActive: !m.isActive, ...v })} />
        ) },
      ]} />
    </>
  );
}

function Events() {
  const tr = useTr();
  type Ev = { id: string; integrationId: string; externalEventId: string; eventType: string; externalRef: string | null; signatureValid: boolean; result: string; error: string | null; receivedAt: string };
  return (
    <ListView<Ev> path="/v1/admin/payment-events"
      filters={[{ name: 'result', label: tr({ ar: 'النتيجة', en: 'Result' }), type: 'select', options: ['processed', 'duplicate', 'rejected', 'ignored', 'error'].map((v) => ({ value: v, label: v })) }]}
      columns={[
        { key: 'receivedAt', label: { ar: 'الوقت', en: 'Received' }, render: (e) => <DateTime value={e.receivedAt} /> },
        { key: 'eventType', label: { ar: 'الحدث', en: 'Event' } },
        { key: 'externalRef', label: { ar: 'المرجع', en: 'Reference' } },
        { key: 'signatureValid', label: { ar: 'التوقيع صحيح', en: 'Signature valid' } },
        { key: 'result', label: { ar: 'النتيجة', en: 'Result' } },
        { key: 'error', label: { ar: 'الخطأ', en: 'Error' } },
      ]} />
  );
}
