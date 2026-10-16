'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Bell, CircleHelp, Compass, Home, Menu, ShoppingBag, Sparkles, User, X } from 'lucide-react';
import { localized, type Lang } from '@events/shared';
import { useApp, useGet, useSession, useTr } from '@events/web-kit/client';
import { LangSwitch } from '@events/web-kit/ui';
import { BRAND } from './brand';

export type Branding = { name: { ar: string; en: string }; primaryColor: string; logoUrl: string | null };

export function Header({ countries, current, brand, currencies, display }: {
  countries: { code: string; name: Record<string, string> }[]; current: string | null; brand: Branding | null; currencies: string[]; display: string | null;
}) {
  const tr = useTr();
  const { lang } = useApp();
  const router = useRouter();
  const path = usePathname();
  const session = useSession().data;
  const customer = session?.kind === 'customer';
  const cart = useGet<{ items: unknown[] }>(customer ? '/v1/cart' : null).data;
  const unread = useGet<{ unread: number }>(customer ? '/v1/me/notifications' : null, { limit: 1 }).data?.unread ?? 0;
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => setOpen(false), [path]);
  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 8);
    on();
    window.addEventListener('scroll', on, { passive: true });
    return () => window.removeEventListener('scroll', on);
  }, []);
  const links = [
    { href: '/', label: tr({ ar: 'الرئيسية', en: 'Home' }), icon: Home },
    { href: '/search', label: tr({ ar: 'تصفح الخدمات', en: 'Browse services' }), icon: Compass },
    { href: '/help', label: tr({ ar: 'المساعدة', en: 'Help' }), icon: CircleHelp },
  ];
  const active = (href: string) => (href === '/' ? path === '/' : path.startsWith(href));
  const countrySelect = countries.length > 1 && (
    <select aria-label="country" className="country-select" value={current ?? ''} onChange={(e) => {
      document.cookie = `country=${e.target.value}; Path=/; Max-Age=31536000; SameSite=Lax`;
      router.refresh();
    }}>
      {countries.map((c) => <option key={c.code} value={c.code}>{localized(c.name, lang as Lang)}</option>)}
    </select>
  );
  // Prices are always charged in the service's currency; this only adds an approximate conversion for reading (clause 11).
  const currencySelect = currencies.length > 1 && (
    <select aria-label={tr({ ar: 'عملة العرض', en: 'Display currency' })} className="country-select" value={display ?? ''} data-testid="display-currency" onChange={(e) => {
      document.cookie = e.target.value ? `dcur=${e.target.value}; Path=/; Max-Age=31536000; SameSite=Lax` : 'dcur=; Path=/; Max-Age=0';
      router.refresh();
    }}>
      <option value="">{tr({ ar: 'عملة الخدمة', en: 'Service currency' })}</option>
      {currencies.map((c) => <option key={c} value={c}>≈ {c}</option>)}
    </select>
  );
  const name = brand ? tr(brand.name) : tr(BRAND);
  return (
    <header className={`site-header${scrolled ? ' scrolled' : ''}`}>
      <div className="site-header-inner">
        <button type="button" className="icon-btn only-mobile" aria-label="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? <X className="ico" aria-hidden /> : <Menu className="ico" aria-hidden />}
        </button>
        <Link href="/" className="logo">{brand?.logoUrl
          ? <img src={`/bff${brand.logoUrl}`} alt="" className="brand-logo" />
          : <span className="brand-mark"><Sparkles className="ico" aria-hidden /></span>}{name}</Link>
        <nav className="site-nav only-desktop">
          {links.map((l) => <Link key={l.href} href={l.href} className={active(l.href) ? 'active' : ''}>{l.label}</Link>)}
        </nav>
        <div className="grow" />
        <div className="only-desktop row gap">{countrySelect}{currencySelect}<LangSwitch /></div>
        {customer ? <>
          <Link href="/account/notifications" className="icon-btn" aria-label={tr({ ar: 'الإشعارات', en: 'Notifications' })}>
            <Bell className="ico" aria-hidden />{unread > 0 && <span className="dot-count">{unread > 99 ? '99+' : unread}</span>}
          </Link>
          <Link href="/cart" className="icon-btn" aria-label={tr({ ar: 'السلة', en: 'Cart' })}>
            <ShoppingBag className="ico" aria-hidden />{!!cart?.items.length && <span className="dot-count">{cart.items.length}</span>}
          </Link>
          <Link href="/account/bookings" className="btn btn-secondary account-btn"><User className="ico" aria-hidden /><span className="only-desktop">{tr({ ar: 'حسابي', en: 'My account' })}</span></Link>
        </> : <Link href="/login" className="btn btn-primary">{tr({ ar: 'تسجيل الدخول', en: 'Sign in' })}</Link>}
      </div>
      {open && (
        <div className="mobile-menu">
          {links.map((l) => <Link key={l.href} href={l.href} className={active(l.href) ? 'active' : ''}><l.icon className="ico" aria-hidden />{l.label}</Link>)}
          {customer && <Link href="/account/bookings"><User className="ico" aria-hidden />{tr({ ar: 'حسابي وحجوزاتي', en: 'My account & bookings' })}</Link>}
          <div className="row gap wrap">{countrySelect}{currencySelect}<LangSwitch /></div>
        </div>
      )}
    </header>
  );
}
