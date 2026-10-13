'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { localized, type Lang } from '@events/shared';
import { useApp, useGet, useSession, useTr } from '@events/web-kit/client';
import { LangSwitch } from '@events/web-kit/ui';
import { BRAND } from './brand';

export function Header({ countries, current }: { countries: { code: string; name: Record<string, string> }[]; current: string | null }) {
  const tr = useTr();
  const { lang } = useApp();
  const router = useRouter();
  const session = useSession().data;
  const cart = useGet<{ items: unknown[] }>(session?.kind === 'customer' ? '/v1/cart' : null).data;
  const unread = useGet<{ unread: number }>(session?.kind === 'customer' ? '/v1/me/notifications' : null, { limit: 1 }).data?.unread ?? 0;
  return (
    <header className="site-header">
      <div className="site-header-inner">
        <Link href="/" className="logo">{tr(BRAND)}</Link>
        <Link href="/search">{tr({ ar: 'تصفح الخدمات', en: 'Browse services' })}</Link>
        <div className="grow" />
        {countries.length > 1 && (
          <select aria-label="country" value={current ?? ''} style={{ width: 'auto' }} onChange={(e) => {
            document.cookie = `country=${e.target.value}; Path=/; Max-Age=31536000; SameSite=Lax`;
            router.refresh();
          }}>
            {countries.map((c) => <option key={c.code} value={c.code}>{localized(c.name, lang as Lang)}</option>)}
          </select>
        )}
        <LangSwitch />
        {session?.kind === 'customer' ? <>
          <Link href="/account/notifications">{tr({ ar: 'الإشعارات', en: 'Notifications' })}{unread ? ` (${unread})` : ''}</Link>
          <Link href="/cart">{tr({ ar: 'السلة', en: 'Cart' })}{cart?.items.length ? ` (${cart.items.length})` : ''}</Link>
          <Link href="/account/bookings" className="btn btn-secondary">{tr({ ar: 'حسابي', en: 'My account' })}</Link>
        </> : <Link href="/login" className="btn btn-primary">{tr({ ar: 'تسجيل الدخول', en: 'Sign in' })}</Link>}
      </div>
    </header>
  );
}
