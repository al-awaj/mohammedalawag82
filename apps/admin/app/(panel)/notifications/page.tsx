'use client';
import { useState } from 'react';
import { useGet, useTr } from '@events/web-kit/client';
import { ActionButton, Badge, DataTable, DateTime, ErrorBox, ListView, Loading, Notice, Page, reasonField, Tabs } from '@events/web-kit/ui';
import { opts, raw, useCountries } from '@/lib/util';

type Msg = { id: string; channel: string; target: string; templateKey: string; language: string; subject: string | null; body: string | null; status: string; attempts: number; lastError: string | null; createdAt: string; sentAt: string | null };
type Template = { id: string; key: string; channel: string; language: string; subject: string | null; body: string; isActive: boolean; updatedAt: string };
type Channel = { id: string; countryId: string | null; channel: string; driver: string; endpoint: string; secretRef: string; senderId: string | null; isActive: boolean; secretConfigured: boolean };
type Rule = { id: string; kind: string; daysBefore: number; countryId: string | null; serviceTypeId: string | null; templateKey: string; channel: string; isActive: boolean };
const CHANNELS = raw('sms', 'email', 'whatsapp', 'push', 'web');

export default function Notifications() {
  const tr = useTr();
  const [tab, setTab] = useState<'log' | 'templates' | 'channels' | 'reminders'>('log');
  return (
    <Page title={tr({ ar: 'الإشعارات', en: 'Notifications' })}>
      <Tabs value={tab} onChange={setTab} tabs={[
        { id: 'log', label: tr({ ar: 'سجل الإرسال', en: 'Delivery log' }) }, { id: 'templates', label: tr({ ar: 'القوالب', en: 'Templates' }) },
        { id: 'channels', label: tr({ ar: 'القنوات', en: 'Channels' }) }, { id: 'reminders', label: tr({ ar: 'التذكيرات', en: 'Reminders' }) },
      ]} />
      {tab === 'log' ? <Log /> : tab === 'templates' ? <Templates /> : tab === 'channels' ? <Channels /> : <Reminders />}
    </Page>
  );
}

function Log() {
  const tr = useTr();
  return (
    <ListView<Msg> path="/v1/admin/notifications"
      filters={[
        { name: 'status', label: tr({ ar: 'الحالة', en: 'Status' }), type: 'select', options: opts('notification') },
        { name: 'channel', label: tr({ ar: 'القناة', en: 'Channel' }), type: 'select', options: CHANNELS },
        { name: 'templateKey', label: tr({ ar: 'القالب', en: 'Template' }) },
      ]}
      columns={[
        { key: 'createdAt', label: { ar: 'الوقت', en: 'Time' }, render: (m) => <DateTime value={m.createdAt} /> },
        { key: 'channel', label: { ar: 'القناة', en: 'Channel' } },
        { key: 'target', label: { ar: 'المستلم', en: 'Recipient' }, render: (m) => <span dir="ltr">{m.target}</span> },
        { key: 'templateKey', label: { ar: 'القالب', en: 'Template' } },
        { key: 'body', label: { ar: 'المحتوى (رموز التحقق مخفية)', en: 'Content (codes masked)' }, render: (m) => <span className="small">{m.body ?? '—'}</span> },
        { key: 'status', label: { ar: 'الحالة', en: 'Status' }, render: (m) => <Badge group="notification" value={m.status} /> },
        { key: 'lastError', label: { ar: 'سبب الفشل', en: 'Failure' } },
        { key: 'retry', label: '', render: (m) => m.status === 'failed' ? <ActionButton label={tr({ ar: 'إعادة الإرسال', en: 'Retry' })} run={(api) => api.post(`/v1/admin/notifications/${m.id}/retry`)} /> : null },
      ]} />
  );
}

function Templates() {
  const tr = useTr();
  const { data, error, isLoading } = useGet<Template[]>('/v1/admin/notification-templates');
  const fields = (t?: Template) => [
    { name: 'key', label: { ar: 'الحدث', en: 'Event key' }, required: true, defaultValue: t?.key, readOnly: !!t },
    { name: 'channel', label: { ar: 'القناة', en: 'Channel' }, type: 'select' as const, required: true, options: CHANNELS, defaultValue: t?.channel, readOnly: !!t },
    { name: 'language', label: { ar: 'اللغة', en: 'Language' }, type: 'select' as const, required: true, options: raw('ar', 'en'), defaultValue: t?.language, readOnly: !!t },
    { name: 'subject', label: { ar: 'العنوان', en: 'Subject' }, defaultValue: t?.subject ?? undefined },
    { name: 'body', label: { ar: 'النص (المتغيرات بين {{ }})', en: 'Body ({{variables}})' }, type: 'textarea' as const, required: true, defaultValue: t?.body },
    { name: 'isActive', label: { ar: 'مفعّل', en: 'Active' }, type: 'checkbox' as const, defaultValue: t?.isActive ?? true },
  ];
  if (isLoading) return <Loading />;
  return (
    <>
      <div className="page-actions" style={{ marginBottom: 12 }}>
        <ActionButton variant="primary" label={tr({ ar: 'قالب جديد', en: 'New template' })} fields={fields()} run={(api, v) => api.put('/v1/admin/notification-templates', v)} />
      </div>
      <ErrorBox error={error} />
      <DataTable rows={data ?? []} columns={[
        { key: 'key', label: { ar: 'الحدث', en: 'Event' } },
        { key: 'channel', label: { ar: 'القناة', en: 'Channel' } },
        { key: 'language', label: { ar: 'اللغة', en: 'Language' } },
        { key: 'body', label: { ar: 'النص', en: 'Body' }, render: (t) => <span className="small">{t.body}</span> },
        { key: 'isActive', label: { ar: 'مفعّل', en: 'Active' } },
        { key: 'edit', label: '', render: (t) => <ActionButton label={tr({ ar: 'تعديل', en: 'Edit' })} fields={fields(t)} run={(api, v) => api.put('/v1/admin/notification-templates', v)} /> },
      ]} />
    </>
  );
}

function Channels() {
  const tr = useTr();
  const countries = useCountries();
  const { data, error, isLoading } = useGet<Channel[]>('/v1/admin/messaging-channels');
  if (isLoading) return <Loading />;
  return (
    <>
      <Notice>{tr({ ar: 'الربط عبر مشغل HTTP عام (http_json) بأي مزود أو خدمة وسيطة. المفتاح السري يُضبط كمتغير بيئة على الخادم ويُحفظ هنا اسمه فقط.', en: 'Connected through a generic HTTP driver (http_json) to any provider or relay. The secret is set as a server environment variable; only its name is stored here.' })}</Notice>
      <div className="page-actions" style={{ marginBottom: 12 }}>
        <ActionButton variant="primary" label={tr({ ar: 'قناة جديدة', en: 'New channel' })} fields={[
          { name: 'countryId', label: { ar: 'الدولة (فارغ = عامة)', en: 'Country (blank = all)' }, type: 'select', options: countries.options },
          { name: 'channel', label: { ar: 'القناة', en: 'Channel' }, type: 'select', required: true, options: raw('sms', 'email', 'whatsapp', 'push') },
          { name: 'driver', label: { ar: 'المشغل', en: 'Driver' }, type: 'select', options: raw('http_json'), defaultValue: 'http_json' },
          { name: 'endpoint', label: { ar: 'عنوان الإرسال (HTTPS)', en: 'Endpoint (HTTPS)' }, required: true },
          { name: 'secretRef', label: { ar: 'اسم متغير البيئة للمفتاح', en: 'Secret environment variable name' }, required: true },
          { name: 'senderId', label: { ar: 'معرّف المرسل', en: 'Sender id' } },
        ]} run={(api, v) => api.post('/v1/admin/messaging-channels', v)} />
      </div>
      <ErrorBox error={error} />
      <DataTable rows={data ?? []} columns={[
        { key: 'channel', label: { ar: 'القناة', en: 'Channel' } },
        { key: 'countryId', label: { ar: 'الدولة', en: 'Country' }, render: (c) => (c.countryId ? countries.code(c.countryId) : tr({ ar: 'عامة', en: 'All' })) },
        { key: 'endpoint', label: { ar: 'العنوان', en: 'Endpoint' }, render: (c) => <code className="small">{c.endpoint}</code> },
        { key: 'secretRef', label: { ar: 'متغير المفتاح', en: 'Secret variable' }, render: (c) => <code>{c.secretRef}</code> },
        { key: 'secretConfigured', label: { ar: 'المفتاح مضبوط على الخادم', en: 'Secret set on server' } },
        { key: 'isActive', label: { ar: 'مفعّلة', en: 'Active' } },
        { key: 'toggle', label: '', render: (c) => <ActionButton label={c.isActive ? tr({ ar: 'تعطيل', en: 'Disable' }) : tr({ ar: 'تفعيل', en: 'Enable' })} fields={[reasonField()]}
          run={(api, v) => api.patch(`/v1/admin/messaging-channels/${c.id}`, { isActive: !c.isActive, ...v })} /> },
      ]} />
    </>
  );
}

const REMINDER_CHANNELS: { value: string; label: { ar: string; en: string } }[] = [
  { value: 'auto', label: { ar: 'تلقائي (رسالة نصية وإلا بريد)', en: 'Automatic (SMS, else email)' } },
  { value: 'sms', label: { ar: 'رسالة نصية', en: 'SMS' } },
  { value: 'email', label: { ar: 'بريد إلكتروني', en: 'Email' } },
  { value: 'whatsapp', label: { ar: 'واتساب', en: 'WhatsApp' } },
];

function Reminders() {
  const tr = useTr();
  const countries = useCountries();
  const { data, error, isLoading } = useGet<Rule[]>('/v1/admin/reminder-rules');
  const KINDS = [
    { value: 'before_balance_due', label: { ar: 'قبل استحقاق المتبقي', en: 'Before balance due' } },
    { value: 'balance_overdue', label: { ar: 'عند تأخر المتبقي', en: 'Balance overdue' } },
    { value: 'before_event', label: { ar: 'قبل الموعد', en: 'Before the event' } },
  ];
  if (isLoading) return <Loading />;
  return (
    <>
      <div className="page-actions" style={{ marginBottom: 12 }}>
        <ActionButton variant="primary" label={tr({ ar: 'قاعدة تذكير', en: 'New reminder' })} fields={[
          { name: 'kind', label: { ar: 'النوع', en: 'Kind' }, type: 'select', required: true, options: KINDS },
          { name: 'daysBefore', label: { ar: 'عدد الأيام', en: 'Days' }, type: 'number' },
          { name: 'countryId', label: { ar: 'الدولة', en: 'Country' }, type: 'select', options: countries.options },
          { name: 'templateKey', label: { ar: 'القالب', en: 'Template key' }, required: true },
          { name: 'channel', label: { ar: 'القناة', en: 'Channel' }, type: 'select', defaultValue: 'auto', options: REMINDER_CHANNELS },
        ]} run={(api, v) => api.post('/v1/admin/reminder-rules', v)} />
      </div>
      <ErrorBox error={error} />
      <DataTable rows={data ?? []} columns={[
        { key: 'kind', label: { ar: 'النوع', en: 'Kind' }, render: (r) => tr(KINDS.find((k) => k.value === r.kind)?.label ?? { ar: r.kind, en: r.kind }) },
        { key: 'daysBefore', label: { ar: 'الأيام', en: 'Days' } },
        { key: 'channel', label: { ar: 'القناة', en: 'Channel' }, render: (r) => tr(REMINDER_CHANNELS.find((c) => c.value === r.channel)?.label ?? { ar: r.channel, en: r.channel }) },
        { key: 'countryId', label: { ar: 'الدولة', en: 'Country' }, render: (r) => countries.code(r.countryId) },
        { key: 'templateKey', label: { ar: 'القالب', en: 'Template' } },
        { key: 'isActive', label: { ar: 'مفعّلة', en: 'Active' } },
        { key: 'toggle', label: '', render: (r) => <ActionButton label={r.isActive ? tr({ ar: 'تعطيل', en: 'Disable' }) : tr({ ar: 'تفعيل', en: 'Enable' })} fields={[reasonField()]}
          run={(api, v) => api.patch(`/v1/admin/reminder-rules/${r.id}`, { isActive: !r.isActive, ...v })} /> },
      ]} />
    </>
  );
}
