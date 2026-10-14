import Link from 'next/link';
import { Sparkles } from 'lucide-react';
import { Header } from '@/lib/header';
import { BRAND } from '@/lib/brand';
import { currentCountry, visitor } from '@/lib/server';

export default async function SiteLayout({ children }: { children: React.ReactNode }) {
  const v = await visitor();
  const ar = v.lang === 'ar';
  const { list, country } = await currentCountry(v.lang, v.country);
  return (
    <>
      <Header countries={list.map((c) => ({ code: c.code, name: c.name }))} current={country?.code ?? null} />
      <main className="site-main">{children}</main>
      <footer className="site-footer">
        <div className="footer-inner">
          <div className="footer-brand">
            <span className="logo"><span className="brand-mark"><Sparkles className="ico" aria-hidden /></span>{BRAND[v.lang]}</span>
            <p>{ar ? 'منصة لحجز خدمات المناسبات بأسعار واضحة وسياسات إلغاء معلنة. الأسعار المعروضة هي ما يدفعه العميل، دون رسوم منصة إضافية.' : 'Book event services with clear prices and published cancellation policies. Prices shown are what the customer pays, with no extra platform fee.'}</p>
          </div>
          <div>
            <h3>{ar ? 'تصفّح' : 'Explore'}</h3>
            <Link href="/search">{ar ? 'كل الخدمات' : 'All services'}</Link>
            <Link href="/account/events">{ar ? 'مناسباتي' : 'My events'}</Link>
            <Link href="/account/bookings">{ar ? 'حجوزاتي' : 'My bookings'}</Link>
          </div>
          <div>
            <h3>{ar ? 'الدعم' : 'Support'}</h3>
            <Link href="/help">{ar ? 'المساعدة' : 'Help'}</Link>
            <Link href="/terms">{ar ? 'شروط الاستخدام' : 'Terms of use'}</Link>
            <Link href="/terms?kind=privacy_policy">{ar ? 'سياسة الخصوصية' : 'Privacy policy'}</Link>
          </div>
        </div>
        <div className="footer-bottom">© {new Date().getFullYear()} {BRAND[v.lang]}</div>
      </footer>
    </>
  );
}
