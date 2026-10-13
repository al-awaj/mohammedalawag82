'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { localized } from '@events/shared';
import { useApp, useGet, useT, useTr } from '../client';
import { Button, ErrorBox, Modal, Notice } from './basics';
import { Form } from './forms';
import { LangSwitch } from './shell';

type Country = { id: string; code: string; name: Record<string, string>; phonePrefix: string };

/** Sign-up for customers or providers; the account kind is fixed by the application's proxy. */
export function RegisterPanel({ title, termsKind, home = '/', loginHref = '/login' }: { title: ReactNode; termsKind: 'customer_terms' | 'provider_terms'; home?: string; loginHref?: string }) {
  const { api, lang } = useApp();
  const tr = useTr();
  const t = useT();
  const qc = useQueryClient();
  const router = useRouter();
  const countries = useGet<Country[]>('/v1/countries').data ?? [];
  const [country, setCountry] = useState('');
  const [terms, setTerms] = useState<{ content: Record<string, string>; version: string } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const showTerms = async (kind: string) => {
    if (!country) return;
    try { setTerms(await api.get(`/v1/terms/current`, { kind, country })); } catch (e) { setError(e); }
  };
  return (
    <div className="auth">
      <div className="auth-card">
        <div className="row between"><h1>{title}</h1><LangSwitch /></div>
        <ErrorBox error={error} />
        <label className="field">
          <span>{t('country')} *</span>
          <select name="countryCode" value={country} onChange={(e) => setCountry(e.target.value)}>
            <option value="">—</option>
            {countries.map((c) => <option key={c.code} value={c.code}>{localized(c.name, lang)}</option>)}
          </select>
        </label>
        {country && (
          <p className="small">
            <button type="button" className="btn btn-ghost" onClick={() => showTerms(termsKind)}>{tr({ ar: 'عرض الشروط والأحكام', en: 'View terms' })}</button>
            <button type="button" className="btn btn-ghost" onClick={() => showTerms('privacy_policy')}>{tr({ ar: 'سياسة الخصوصية', en: 'Privacy policy' })}</button>
          </p>
        )}
        <Form busy={busy} submitLabel={t('register')} fields={[
          { name: 'fullName', label: { ar: 'الاسم الكامل', en: 'Full name' }, required: true },
          { name: 'phone', label: { ar: 'رقم الجوال (بالصيغة الدولية)', en: 'Mobile (international format)' }, type: 'tel', required: true, placeholder: countries.find((c) => c.code === country)?.phonePrefix ?? '+966' },
          { name: 'email', label: { ar: 'البريد الإلكتروني', en: 'Email' }, type: 'email' },
          { name: 'password', label: { ar: 'كلمة المرور (10 أحرف على الأقل، حروف وأرقام)', en: 'Password (10+ characters, letters and digits)' }, type: 'password', required: true },
          { name: 'acceptTerms', label: { ar: 'أوافق على الشروط والأحكام وسياسة الخصوصية', en: 'I accept the terms and the privacy policy' }, type: 'checkbox', required: true },
        ]} onSubmit={async (v) => {
          if (!country) { setError(new Error(tr({ ar: 'اختر الدولة', en: 'Choose a country' }))); return; }
          if (v.acceptTerms !== true) { setError(new Error(tr({ ar: 'يجب الموافقة على الشروط', en: 'You must accept the terms' }))); return; }
          setBusy(true); setError(null);
          try {
            await api.post('/session/register', { ...v, countryCode: country, preferredLanguage: lang });
            await qc.invalidateQueries({ queryKey: ['session'] });
            router.replace(`/verify?next=${encodeURIComponent(home)}`);
          } catch (e) { setError(e); } finally { setBusy(false); }
        }} />
        <p className="small">{tr({ ar: 'لديك حساب؟', en: 'Have an account?' })} <Link href={loginHref}>{t('login')}</Link></p>
      </div>
      {terms && <Modal title={`${tr({ ar: 'الإصدار', en: 'Version' })} ${terms.version}`} onClose={() => setTerms(null)}><div style={{ whiteSpace: 'pre-wrap' }}>{localized(terms.content, lang)}</div></Modal>}
    </div>
  );
}

/** Phone (or email) verification with a one-time code. */
export function VerifyPanel({ channel = 'phone', next = '/' }: { channel?: 'phone' | 'email'; next?: string }) {
  const { api } = useApp();
  const tr = useTr();
  const qc = useQueryClient();
  const router = useRouter();
  const [error, setError] = useState<unknown>(null);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <div className="auth">
      <div className="auth-card">
        <div className="row between"><h1>{channel === 'phone' ? tr({ ar: 'تأكيد رقم الجوال', en: 'Verify your mobile' }) : tr({ ar: 'تأكيد البريد', en: 'Verify your email' })}</h1><LangSwitch /></div>
        <p className="muted">{tr({ ar: 'أرسلنا رمز تحقق. أدخله هنا.', en: 'We sent you a verification code. Enter it here.' })}</p>
        {sent && <Notice kind="success">{tr({ ar: 'تم إرسال رمز جديد.', en: 'A new code was sent.' })}</Notice>}
        <ErrorBox error={error} />
        <Form busy={busy} submitLabel={tr({ ar: 'تأكيد', en: 'Verify' })} fields={[{ name: 'code', label: { ar: 'الرمز', en: 'Code' }, required: true }]} onSubmit={async (v) => {
          setBusy(true); setError(null);
          try {
            await api.post('/v1/auth/verification/confirm', { channel, code: v.code });
            await qc.invalidateQueries({ queryKey: ['session'] });
            router.replace(next);
          } catch (e) { setError(e); } finally { setBusy(false); }
        }} />
        <Button variant="ghost" onClick={async () => {
          setError(null);
          try { await api.post('/v1/auth/verification/request', { channel }); setSent(true); } catch (e) { setError(e); }
        }}>{tr({ ar: 'إعادة إرسال الرمز', en: 'Resend code' })}</Button>
      </div>
    </div>
  );
}

/** Forgot password: request a code, then set a new password with it. */
export function ResetPasswordPanel({ loginHref = '/login' }: { loginHref?: string }) {
  const { api } = useApp();
  const tr = useTr();
  const [identifier, setIdentifier] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<unknown>(null);
  return (
    <div className="auth">
      <div className="auth-card">
        <div className="row between"><h1>{tr({ ar: 'استعادة كلمة المرور', en: 'Reset password' })}</h1><LangSwitch /></div>
        <ErrorBox error={error} />
        {done ? <Notice kind="success">{tr({ ar: 'تم تغيير كلمة المرور.', en: 'Your password was changed.' })} <Link href={loginHref}>{tr({ ar: 'تسجيل الدخول', en: 'Sign in' })}</Link></Notice>
          : identifier === null ? (
            <Form submitLabel={tr({ ar: 'إرسال الرمز', en: 'Send code' })} fields={[{ name: 'identifier', label: { ar: 'البريد أو الجوال', en: 'Email or mobile' }, required: true }]} onSubmit={async (v) => {
              setError(null);
              try { await api.post('/v1/auth/password/forgot', v); setIdentifier(String(v.identifier)); } catch (e) { setError(e); }
            }} />
          ) : (
            <Form submitLabel={tr({ ar: 'تغيير كلمة المرور', en: 'Change password' })} fields={[
              { name: 'code', label: { ar: 'الرمز', en: 'Code' }, required: true },
              { name: 'newPassword', label: { ar: 'كلمة المرور الجديدة', en: 'New password' }, type: 'password', required: true },
            ]} onSubmit={async (v) => {
              setError(null);
              try { await api.post('/v1/auth/password/reset', { identifier, ...v }); setDone(true); } catch (e) { setError(e); }
            }} />
          )}
      </div>
    </div>
  );
}
