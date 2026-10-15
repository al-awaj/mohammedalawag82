'use client';
import { useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { useAction, useGet, useTr } from '../client';
import { Button, Card, ErrorBox, Notice, Page } from './basics';
import { ActionButton, Form } from './forms';

/** Own account security: password change and two-step sign-in with an authenticator app. */
export function SecurityPage() {
  const tr = useTr();
  const status = useGet<{ enabled: boolean; enabledAt: string | null; required: boolean }>('/v1/me/mfa');
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const start = useAction((api) => api.post<{ secret: string; otpauthUrl: string }>('/v1/me/mfa/setup'));
  const enable = useAction((api, code: string) => api.post('/v1/me/mfa/enable', { code }));
  const password = useAction((api, v: Record<string, unknown>) => api.post('/v1/me/password', v));
  const s = status.data;
  return (
    <Page title={tr({ ar: 'أمان الحساب', en: 'Account security' })}>
      <Card title={<><ShieldCheck className="ico" aria-hidden /> {tr({ ar: 'التحقق بخطوتين', en: 'Two-step sign-in' })}</>}>
        <ErrorBox error={status.error ?? start.error ?? enable.error} />
        {s?.enabled ? (
          <>
            <Notice kind="success">{tr({ ar: 'مفعّل: يُطلب رمز من تطبيق المصادقة عند كل دخول.', en: 'On: a code from your authenticator app is asked at every sign-in.' })}</Notice>
            {!s.required && (
              <ActionButton variant="danger" label={tr({ ar: 'إيقاف التحقق بخطوتين', en: 'Turn off' })} fields={[
                { name: 'password', label: { ar: 'كلمة المرور', en: 'Password' }, type: 'password', required: true },
                { name: 'code', label: { ar: 'رمز التحقق الحالي', en: 'Current code' }, required: true },
              ]} run={(api, v) => api.post('/v1/me/mfa/disable', v)} />
            )}
          </>
        ) : setup ? (
          <>
            <p>{tr({ ar: 'أضف الحساب في تطبيق المصادقة بهذا المفتاح (أو افتح الرابط على الجوال)، ثم أدخل الرمز الظاهر.', en: 'Add the account to your authenticator app with this key (or open the link on a phone), then enter the code shown.' })}</p>
            <p className="mono" dir="ltr" data-testid="mfa-secret" style={{ wordBreak: 'break-all' }}>{setup.secret}</p>
            <p><a href={setup.otpauthUrl}>{tr({ ar: 'فتح في تطبيق المصادقة', en: 'Open in authenticator app' })}</a></p>
            <Form busy={enable.isPending} submitLabel={tr({ ar: 'تفعيل', en: 'Turn on' })}
              fields={[{ name: 'code', label: { ar: 'رمز التحقق', en: 'Verification code' }, required: true, placeholder: '123456' }]}
              onSubmit={(v) => enable.mutate(String(v.code), { onSuccess: () => { setSetup(null); void status.refetch(); } })} />
          </>
        ) : (
          <>
            {s?.required && <Notice kind="warning">{tr({ ar: 'الإدارة تشترط التحقق بخطوتين لحسابات الموظفين.', en: 'The administration requires two-step sign-in for staff accounts.' })}</Notice>}
            <p className="muted">{tr({ ar: 'يحمي حسابك حتى لو عُرفت كلمة المرور: يُطلب رمز متغير من تطبيق على جوالك.', en: 'Protects your account even if your password leaks: a changing code from an app on your phone is required.' })}</p>
            <Button variant="primary" disabled={start.isPending} onClick={() => start.mutate(undefined, { onSuccess: (r) => setSetup(r) })}>{tr({ ar: 'إعداد التحقق بخطوتين', en: 'Set up two-step sign-in' })}</Button>
          </>
        )}
      </Card>
      <Card title={tr({ ar: 'تغيير كلمة المرور', en: 'Change password' })}>
        <ErrorBox error={password.error} />
        {password.isSuccess && <Notice kind="success">{tr({ ar: 'تم تغيير كلمة المرور.', en: 'Password changed.' })}</Notice>}
        <Form busy={password.isPending} onSubmit={(v) => password.mutate(v)} fields={[
          { name: 'currentPassword', label: { ar: 'كلمة المرور الحالية', en: 'Current password' }, type: 'password', required: true },
          { name: 'newPassword', label: { ar: 'كلمة المرور الجديدة', en: 'New password' }, type: 'password', required: true },
        ]} />
      </Card>
    </Page>
  );
}
