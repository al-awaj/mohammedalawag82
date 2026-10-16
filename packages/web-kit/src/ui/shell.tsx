'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ComponentType, type ReactNode } from 'react';
import { Languages, LogOut, Menu, Sparkles } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useApp, useSession, useT, useTr, type SessionUser } from '../client';
import { Button, ErrorBox, Loading, Notice } from './basics';
import { Form, type FieldSpec } from './forms';

type L = { ar: string; en: string };
export interface NavItem { href: string; label: L; perm?: string | string[]; icon?: ComponentType<{ className?: string; 'aria-hidden'?: boolean }> }
export interface NavGroup { label: L; items: NavItem[] }

export function LangSwitch() {
  const { lang, setLang } = useApp();
  const t = useT();
  return <Button variant="ghost" onClick={() => setLang(lang === 'ar' ? 'en' : 'ar')}><Languages className="ico" aria-hidden />{t('switchLang')}</Button>;
}

export function useLogout(to = '/login') {
  const { api } = useApp();
  const qc = useQueryClient();
  const router = useRouter();
  return async () => {
    await api.post('/session/logout').catch(() => undefined);
    qc.clear();
    router.replace(to);
  };
}

const allowed = (user: SessionUser, perm?: string | string[]) => !perm || (Array.isArray(perm) ? perm : [perm]).some((p) => user.permissions.includes(p));

/** Signed-in layout with permission-filtered navigation. Pages still rely on the API for access control. */
export function Shell({ brand, nav, kinds, children, footer }: { brand: ReactNode; nav: NavGroup[]; kinds: SessionUser['kind'][]; children: ReactNode; footer?: ReactNode }) {
  const { lang } = useApp();
  const t = useT();
  const { data: user, isLoading, error } = useSession();
  const router = useRouter();
  const path = usePathname();
  const logout = useLogout();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!isLoading && !error && (!user || !kinds.includes(user.kind))) router.replace(`/login?next=${encodeURIComponent(path)}`);
  }, [user, isLoading, error, kinds, router, path]);
  useEffect(() => setOpen(false), [path]);
  if (isLoading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  if (!user || !kinds.includes(user.kind)) return <Loading />;
  const groups = nav.map((g) => ({ ...g, items: g.items.filter((i) => allowed(user, i.perm)) })).filter((g) => g.items.length);
  return (
    <div className={`shell ${open ? 'nav-open' : ''}`}>
      <aside className="sidebar" aria-label="navigation">
        <div className="brand"><span className="brand-mark"><Sparkles className="ico" aria-hidden /></span>{brand}</div>
        <nav>
          {groups.map((g) => (
            <div key={g.label.en} className="nav-group">
              <div className="nav-group-label">{g.label[lang]}</div>
              {g.items.map((i) => (
                <Link key={i.href} href={i.href} className={path === i.href || (i.href !== '/' && path.startsWith(`${i.href}/`)) ? 'nav-link active' : 'nav-link'}>
                  {i.icon && <i.icon className="ico" aria-hidden />}{i.label[lang]}
                </Link>
              ))}
            </div>
          ))}
        </nav>
      </aside>
      <div className="nav-backdrop" onClick={() => setOpen(false)} aria-hidden />
      <div className="main">
        <header className="topbar">
          <button type="button" className="icon-btn menu-btn" aria-label="menu" onClick={() => setOpen(!open)}><Menu className="ico" aria-hidden /></button>
          <div className="grow" />
          <LangSwitch />
          <span className="user-chip"><span className="avatar" aria-hidden>{user.fullName.trim().charAt(0)}</span><span className="user-name">{user.fullName}</span></span>
          <Button variant="ghost" onClick={logout}><LogOut className="ico" aria-hidden />{t('logout')}</Button>
        </header>
        <main className="content">{children}</main>
        {footer}
      </div>
    </div>
  );
}

/** Second sign-in step: the 6-digit code from an authenticator app, with first-time setup when required. */
function MfaStep({ mfa, busy, onCode }: { mfa: { setup: { secret: string; otpauthUrl: string } | null }; busy: boolean; onCode: (code: string) => void }) {
  const tr = useTr();
  return (
    <>
      {mfa.setup ? (
        <Notice kind="warning">
          {tr({ ar: 'التحقق بخطوتين مطلوب لحسابك. أضف الحساب في تطبيق مصادقة (Google Authenticator أو Microsoft Authenticator) بالمفتاح التالي، ثم أدخل الرمز الظاهر.', en: 'Two-step sign-in is required for your account. Add it to an authenticator app (Google or Microsoft Authenticator) with this key, then enter the code shown.' })}
          <div className="mono" dir="ltr" data-testid="mfa-secret" style={{ marginTop: 8, wordBreak: 'break-all' }}>{mfa.setup.secret}</div>
          <a href={mfa.setup.otpauthUrl}>{tr({ ar: 'فتح في تطبيق المصادقة (على الجوال)', en: 'Open in the authenticator app (on a phone)' })}</a>
        </Notice>
      ) : <p className="muted">{tr({ ar: 'أدخل الرمز المكوّن من 6 أرقام من تطبيق المصادقة.', en: 'Enter the 6-digit code from your authenticator app.' })}</p>}
      <Form busy={busy} submitLabel={tr({ ar: 'تحقق', en: 'Verify' })} onSubmit={(v) => onCode(String(v.code))}
        fields={[{ name: 'code', label: { ar: 'رمز التحقق', en: 'Verification code' }, required: true, placeholder: '123456' }]} />
    </>
  );
}

export function LoginPanel({ title, home = '/', extra }: { title: ReactNode; home?: string; extra?: ReactNode }) {
  const { api } = useApp();
  const t = useT();
  const qc = useQueryClient();
  const router = useRouter();
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [mfa, setMfa] = useState<{ token: string; setup: { secret: string; otpauthUrl: string } | null } | null>(null);
  const done = async () => {
    await qc.invalidateQueries({ queryKey: ['session'] });
    const next = new URLSearchParams(window.location.search).get('next');
    router.replace(next && next.startsWith('/') && !next.startsWith('//') ? next : home);
  };
  const fields: FieldSpec[] = [
    { name: 'identifier', label: { ar: 'البريد الإلكتروني أو رقم الجوال', en: 'Email or mobile number' }, type: 'text', required: true },
    { name: 'password', label: { ar: 'كلمة المرور', en: 'Password' }, type: 'password', required: true },
  ];
  return (
    <div className="auth">
      <div className="auth-card">
        <div className="row between"><span className="brand-mark"><Sparkles className="ico" aria-hidden /></span><LangSwitch /></div>
        <h1>{title}</h1>
        <ErrorBox error={error} />
        {mfa ? <MfaStep mfa={mfa} busy={busy} onCode={async (code) => {
          setBusy(true); setError(null);
          try { await api.post('/session/mfa', { mfaToken: mfa.token, code }); await done(); } catch (e) { setError(e); } finally { setBusy(false); }
        }} /> : (
        <Form fields={fields} busy={busy} submitLabel={t('login')} onSubmit={async (v) => {
          setBusy(true); setError(null);
          try {
            const r = await api.post<{ mfaToken?: string; mfaSetupRequired?: boolean }>('/session/login', v);
            if (r?.mfaToken) {
              const setup = r.mfaSetupRequired ? await api.post<{ secret: string; otpauthUrl: string }>('/session/mfa-setup', { mfaToken: r.mfaToken }) : null;
              setMfa({ token: r.mfaToken, setup });
              return;
            }
            await done();
          } catch (e) { setError(e); } finally { setBusy(false); }
        }} />)}
        {extra}
      </div>
    </div>
  );
}
