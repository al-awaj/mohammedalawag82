'use client';
import { useAction, useApp, useGet, useSession, useTr } from '@events/web-kit/client';
import { ApiLink, Badge, Card, DataTable, DateTime, ErrorBox, Form, Money, Notice, Page } from '@events/web-kit/ui';

type History = { payments: { number: string; method: string; status: string; amount: string; verifiedAmount: string | null; currency: string; createdAt: string; bookings: string[] | null }[] };

export default function Profile() {
  const tr = useTr();
  const { lang, setLang } = useApp();
  const s = useSession().data;
  const save = useAction((api, v: Record<string, unknown>) => api.patch('/v1/me', v));
  const pwd = useAction((api, v: Record<string, unknown>) => api.post('/v1/me/password', v));
  const history = useGet<History>('/v1/me/payment-history');
  if (!s) return null;
  return (
    <Page title={tr({ ar: 'الملف الشخصي', en: 'Profile' })}>
      <Card title={tr({ ar: 'بياناتي', en: 'My details' })}>
        <p className="muted"><span dir="ltr">{s.phone}</span> · {s.email ?? '—'} · {s.countryCode}</p>
        <ErrorBox error={save.error} />
        {save.isSuccess && <Notice kind="success">{tr({ ar: 'تم الحفظ', en: 'Saved' })}</Notice>}
        <Form fields={[
          { name: 'fullName', label: { ar: 'الاسم', en: 'Name' }, required: true, defaultValue: s.fullName },
          { name: 'preferredLanguage', label: { ar: 'لغة الرسائل', en: 'Message language' }, type: 'select', options: [{ value: 'ar', label: 'العربية' }, { value: 'en', label: 'English' }], defaultValue: s.preferredLanguage },
        ]} onSubmit={(v) => save.mutate(v, { onSuccess: () => { if (v.preferredLanguage && v.preferredLanguage !== lang) setLang(v.preferredLanguage as 'ar' | 'en'); } })} />
      </Card>
      <Card title={tr({ ar: 'تغيير كلمة المرور', en: 'Change password' })}>
        <ErrorBox error={pwd.error} />
        {pwd.isSuccess && <Notice kind="success">{tr({ ar: 'تم تغيير كلمة المرور', en: 'Password changed' })}</Notice>}
        <Form fields={[
          { name: 'currentPassword', label: { ar: 'كلمة المرور الحالية', en: 'Current password' }, type: 'password', required: true },
          { name: 'newPassword', label: { ar: 'كلمة المرور الجديدة', en: 'New password' }, type: 'password', required: true },
        ]} onSubmit={(v) => pwd.mutate(v)} />
      </Card>
      <Card title={tr({ ar: 'سجل المدفوعات', en: 'Payment history' })} actions={<ApiLink path={`/v1/me/payment-history?format=html&lang=${lang}`}>{tr({ ar: 'طباعة', en: 'Print' })}</ApiLink>}>
        <DataTable rowKey="number" rows={history.data?.payments ?? []} columns={[
          { key: 'number', label: { ar: 'الرقم', en: 'Number' } },
          { key: 'bookings', label: { ar: 'الحجوزات', en: 'Bookings' }, render: (p) => (p.bookings ?? []).join('، ') },
          { key: 'method', label: { ar: 'الطريقة', en: 'Method' }, render: (p) => <Badge group="paymentMethod" value={p.method} /> },
          { key: 'amount', label: { ar: 'المبلغ', en: 'Amount' }, render: (p) => <Money amount={p.verifiedAmount ?? p.amount} currency={p.currency} /> },
          { key: 'status', label: { ar: 'الحالة', en: 'Status' }, render: (p) => <Badge group="payment" value={p.status} /> },
          { key: 'createdAt', label: { ar: 'التاريخ', en: 'Date' }, render: (p) => <DateTime value={p.createdAt} /> },
        ]} />
      </Card>
    </Page>
  );
}
