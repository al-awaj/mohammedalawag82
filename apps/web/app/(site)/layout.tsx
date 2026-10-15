import Link from 'next/link';
import { AtSign, Mail, MapPin, MessageCircle, Phone, Sparkles } from 'lucide-react';
import { Header, type Branding } from '@/lib/header';
import { BRAND } from '@/lib/brand';
import { currentCountry, displayCurrency, publicGet, visitor } from '@/lib/server';

type Brand = Branding & { contact: { phone?: string; whatsapp?: string; email?: string; address?: Record<string, string>; hours?: Record<string, string> }; social: Record<string, string> };
const SOCIAL: Record<string, string> = { instagram: 'Instagram', x: 'X', tiktok: 'TikTok', snapchat: 'Snapchat', facebook: 'Facebook', youtube: 'YouTube', linkedin: 'LinkedIn' };

export default async function SiteLayout({ children }: { children: React.ReactNode }) {
  const v = await visitor();
  const ar = v.lang === 'ar';
  const { list, country } = await currentCountry(v.lang, v.country);
  const [brand, currencies, display] = await Promise.all([
    publicGet<Brand>(`/v1/branding${country ? `?country=${country.code}` : ''}`, v.lang),
    publicGet<{ code: string }[]>('/v1/currencies', v.lang),
    displayCurrency(),
  ]);
  const name = brand ? brand.name[v.lang] : BRAND[v.lang];
  const c = brand?.contact ?? {};
  const color = brand && /^#[0-9a-fA-F]{6}$/.test(brand.primaryColor) ? brand.primaryColor : null;
  return (
    <>
      {color && color.toLowerCase() !== '#6d28d9' && <style>{`:root{--primary:${color};--primary-2:${color}}`}</style>}
      <Header countries={list.map((x) => ({ code: x.code, name: x.name }))} current={country?.code ?? null} brand={brand}
        currencies={(currencies ?? []).map((x) => x.code.trim())} display={display} />
      <main className="site-main">{children}</main>
      <footer className="site-footer">
        <div className="footer-inner">
          <div className="footer-brand">
            <span className="logo">{brand?.logoUrl ? <img src={`/bff${brand.logoUrl}`} alt="" className="brand-logo" /> : <span className="brand-mark"><Sparkles className="ico" aria-hidden /></span>}{name}</span>
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
          {(c.phone || c.email || c.whatsapp || c.address || Object.keys(brand?.social ?? {}).length > 0) && (
            <div className="footer-contact" data-testid="footer-contact">
              <h3>{ar ? 'تواصل معنا' : 'Contact us'}</h3>
              {c.phone && <a href={`tel:${c.phone}`} dir="ltr"><Phone className="ico" aria-hidden />{c.phone}</a>}
              {c.whatsapp && <a href={`https://wa.me/${c.whatsapp.replace(/\D/g, '')}`} target="_blank" rel="noopener noreferrer" dir="ltr"><MessageCircle className="ico" aria-hidden />{c.whatsapp}</a>}
              {c.email && <a href={`mailto:${c.email}`}><Mail className="ico" aria-hidden />{c.email}</a>}
              {c.address?.[v.lang] && <span><MapPin className="ico" aria-hidden />{c.address[v.lang]}</span>}
              {c.hours?.[v.lang] && <span className="muted small">{c.hours[v.lang]}</span>}
              <div className="row gap">
                {Object.entries(brand?.social ?? {}).map(([k, url]) => (
                  <a key={k} href={url} target="_blank" rel="noopener noreferrer" className="social-link"><AtSign className="ico" aria-hidden />{SOCIAL[k] ?? k}</a>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="footer-bottom">© {new Date().getFullYear()} {name}</div>
      </footer>
    </>
  );
}
