'use client';
import { Bell, Briefcase, CalendarCheck, CalendarDays, ChartColumn, CircleHelp, ClipboardCheck, FileText, HandCoins, LayoutDashboard, MessageSquareWarning, Package, ShieldCheck, Star, TicketPercent } from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ApiError } from '@events/shared';
import { useApp, useSession, useTr } from '@events/web-kit/client';
import { ErrorBox, Loading, Notice, type NavGroup } from '@events/web-kit/ui';

export interface Provider { id: string; businessName: string; countryCode: string; city: string; status: string; statusReason: string | null; interimSettlementEligible: boolean }

/** The approved provider profile; `missing` while the account has none yet (a normal state, not an error). */
export function useProvider() {
  const { api } = useApp();
  const q = useQuery({
    queryKey: ['/v1/provider/me'],
    queryFn: async () => {
      try { return await api.get<Provider>('/v1/provider/me'); } catch (e) { if (e instanceof ApiError && e.status === 404) return null; throw e; }
    },
    staleTime: 60_000,
  });
  return { provider: q.data ?? null, missing: q.data === null, loading: q.isLoading, error: q.error };
}

export const NAV: NavGroup[] = [
  { label: { ar: 'عام', en: 'General' }, items: [
    { href: '/', label: { ar: 'لوحة المتابعة', en: 'Dashboard' }, icon: LayoutDashboard },
    { href: '/notifications', label: { ar: 'الإشعارات', en: 'Notifications' }, icon: Bell },
    { href: '/help', label: { ar: 'المساعدة', en: 'Help' }, icon: CircleHelp },
  ] },
  { label: { ar: 'خدماتي', en: 'My services' }, items: [
    { href: '/services', label: { ar: 'الخدمات والباقات', en: 'Services & packages' }, icon: Package },
    { href: '/calendar', label: { ar: 'التقويم والتوافر', en: 'Calendar & availability' }, icon: CalendarDays },
    { href: '/policies', label: { ar: 'سياسات الإلغاء', en: 'Cancellation policies' }, icon: ShieldCheck },
    { href: '/promotions', label: { ar: 'العروض', en: 'Promotions' }, icon: TicketPercent },
    { href: '/reviews', label: { ar: 'التقييمات', en: 'Reviews' }, icon: Star },
  ] },
  { label: { ar: 'الحجوزات', en: 'Bookings' }, items: [
    { href: '/bookings', label: { ar: 'الحجوزات', en: 'Bookings' }, icon: CalendarCheck },
    { href: '/disputes', label: { ar: 'النزاعات والشكاوى', en: 'Disputes & complaints' }, icon: MessageSquareWarning },
  ] },
  { label: { ar: 'المالية', en: 'Money' }, items: [
    { href: '/earnings', label: { ar: 'المستحقات والتسويات', en: 'Earnings & settlements' }, icon: HandCoins },
    { href: '/reports', label: { ar: 'التقارير', en: 'Reports' }, icon: ChartColumn },
    { href: '/documents', label: { ar: 'المستندات', en: 'Documents' }, icon: FileText },
  ] },
  { label: { ar: 'الحساب', en: 'Account' }, items: [
    { href: '/profile', label: { ar: 'الملف التجاري', en: 'Business profile' }, icon: Briefcase },
    { href: '/onboarding', label: { ar: 'طلب التسجيل', en: 'Application' }, icon: ClipboardCheck },
  ] },
];

const OPEN_PATHS = ['/onboarding', '/notifications'];

/**
 * Sends unverified accounts to phone verification and accounts without an approved provider profile
 * to the application screen; everything else needs an approved provider (the API enforces it too).
 */
export function ProviderGate({ children }: { children: ReactNode }) {
  const tr = useTr();
  const router = useRouter();
  const path = usePathname();
  const session = useSession().data;
  const { provider, missing, loading, error } = useProvider();
  const unverified = session && !session.phoneVerifiedAt;
  useEffect(() => {
    if (unverified) router.replace(`/verify?next=${encodeURIComponent(path)}`);
    else if (missing && !OPEN_PATHS.includes(path)) router.replace('/onboarding');
  }, [unverified, missing, path, router]);
  if (loading || unverified) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  if (missing && !OPEN_PATHS.includes(path)) return <Loading />;
  return (
    <>
      {provider?.status === 'suspended' && <Notice kind="warning">{tr({ ar: 'حسابك موقوف: يمكنك الاطلاع على بياناتك فقط.', en: 'Your account is suspended: you can only view your data.' })} {provider.statusReason}</Notice>}
      {children}
    </>
  );
}
