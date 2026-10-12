'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { useSession, useTr } from '@events/web-kit/client';
import { ErrorBox, Loading, useLogout } from '@events/web-kit/ui';

/** Signed-in customer area: sends visitors to sign in and unverified accounts to phone verification. */
export function RequireCustomer({ children }: { children: ReactNode }) {
  const { data: s, isLoading, error } = useSession();
  const router = useRouter();
  const path = usePathname();
  useEffect(() => {
    if (isLoading || error) return;
    if (!s || s.kind !== 'customer') router.replace(`/login?next=${encodeURIComponent(path)}`);
    else if (!s.phoneVerifiedAt) router.replace(`/verify?next=${encodeURIComponent(path)}`);
  }, [s, isLoading, error, router, path]);
  if (error) return <ErrorBox error={error} />;
  if (isLoading || !s || s.kind !== 'customer' || !s.phoneVerifiedAt) return <Loading />;
  return <>{children}</>;
}

const LINKS = [
  { href: '/account/bookings', label: { ar: 'حجوزاتي', en: 'My bookings' } },
  { href: '/account/events', label: { ar: 'مناسباتي', en: 'My events' } },
  { href: '/account/documents', label: { ar: 'الفواتير والإيصالات', en: 'Invoices & receipts' } },
  { href: '/account/disputes', label: { ar: 'النزاعات والشكاوى', en: 'Disputes & complaints' } },
  { href: '/account/notifications', label: { ar: 'الإشعارات', en: 'Notifications' } },
  { href: '/account/profile', label: { ar: 'الملف الشخصي', en: 'Profile' } },
];

export function AccountNav() {
  const tr = useTr();
  const path = usePathname();
  const logout = useLogout('/');
  return (
    <nav className="account-nav">
      {LINKS.map((l) => <Link key={l.href} href={l.href} className={`btn ${path.startsWith(l.href) ? 'btn-primary' : 'btn-secondary'}`}>{tr(l.label)}</Link>)}
      <button type="button" className="btn btn-ghost" onClick={logout}>{tr({ ar: 'تسجيل الخروج', en: 'Sign out' })}</button>
    </nav>
  );
}
