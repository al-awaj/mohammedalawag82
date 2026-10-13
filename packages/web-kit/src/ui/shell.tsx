'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useApp, useSession, useT, type SessionUser } from '../client';
import { Button, ErrorBox, Loading } from './basics';
import { Form, type FieldSpec } from './forms';

type L = { ar: string; en: string };
export interface NavItem { href: string; label: L; perm?: string | string[] }
export interface NavGroup { label: L; items: NavItem[] }

export function LangSwitch() {
  const { lang, setLang } = useApp();
  const t = useT();
  return <Button variant="ghost" onClick={() => setLang(lang === 'ar' ? 'en' : 'ar')}>{t('switchLang')}</Button>;
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
        <div className="brand">{brand}</div>
        <nav>
          {groups.map((g) => (
            <div key={g.label.en} className="nav-group">
              <div className="nav-group-label">{g.label[lang]}</div>
              {g.items.map((i) => (
                <Link key={i.href} href={i.href} className={path === i.href || (i.href !== '/' && path.startsWith(`${i.href}/`)) ? 'nav-link active' : 'nav-link'}>{i.label[lang]}</Link>
              ))}
            </div>
          ))}
        </nav>
      </aside>
      <div className="main">
        <header className="topbar">
          <button type="button" className="icon-btn menu-btn" aria-label="menu" onClick={() => setOpen(!open)}>☰</button>
          <div className="grow" />
          <span className="muted">{user.fullName}</span>
          <LangSwitch />
          <Button variant="ghost" onClick={logout}>{t('logout')}</Button>
        </header>
        <main className="content">{children}</main>
        {footer}
      </div>
    </div>
  );
}

export function LoginPanel({ title, home = '/', extra }: { title: ReactNode; home?: string; extra?: ReactNode }) {
  const { api } = useApp();
  const t = useT();
  const qc = useQueryClient();
  const router = useRouter();
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const fields: FieldSpec[] = [
    { name: 'identifier', label: { ar: 'البريد الإلكتروني أو رقم الجوال', en: 'Email or mobile number' }, type: 'text', required: true },
    { name: 'password', label: { ar: 'كلمة المرور', en: 'Password' }, type: 'password', required: true },
  ];
  return (
    <div className="auth">
      <div className="auth-card">
        <div className="row between"><h1>{title}</h1><LangSwitch /></div>
        <ErrorBox error={error} />
        <Form fields={fields} busy={busy} submitLabel={t('login')} onSubmit={async (v) => {
          setBusy(true); setError(null);
          try {
            await api.post('/session/login', v);
            await qc.invalidateQueries({ queryKey: ['session'] });
            const next = new URLSearchParams(window.location.search).get('next');
            router.replace(next && next.startsWith('/') && !next.startsWith('//') ? next : home);
          } catch (e) { setError(e); } finally { setBusy(false); }
        }} />
        {extra}
      </div>
    </div>
  );
}
