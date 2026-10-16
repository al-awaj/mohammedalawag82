import Link from 'next/link';
import { ArrowLeft, ArrowRight, CalendarCheck, CalendarDays, CreditCard, MapPin, Receipt, Search, ShieldCheck, Sparkles, Store } from 'lucide-react';
import { localized } from '@events/shared';
import { ServiceCards, type ServiceCard } from '@/lib/cards';
import { categoryIcon, categoryTone } from '@/lib/icons';
import { currentCountry, publicGet, visitor, displayRates } from '@/lib/server';
import { CountNumber, HeroRays, HeroTitle, StarButton } from '@/lib/home-motion';

type Category = { id: string; slug: string; name: Record<string, string>; description: Record<string, string> | null; imageUrl: string | null; types: { id: string; code: string; name: Record<string, string> }[]; children: Category[] };

export default async function Home() {
  const { lang, country: code } = await visitor();
  const { country } = await currentCountry(lang, code);
  const ar = lang === 'ar';
  const Arrow = ar ? ArrowLeft : ArrowRight;
  if (!country) return <div className="container"><div className="empty">{ar ? 'لا توجد دول مفعّلة حاليًا.' : 'No countries are available yet.'}</div></div>;
  const [categories, latest] = await Promise.all([
    publicGet<Category[]>(`/v1/categories?country=${country.code}`, lang),
    publicGet<{ total: number; items: ServiceCard[] }>(`/v1/services?country=${country.code}&sort=newest&limit=8`, lang),
  ]);
  const cats = (categories ?? []).flatMap((c) => [c, ...c.children]);
  const providerUrl = process.env.PROVIDER_PANEL_URL;
  return (
    <>
      <section className="hero">
        <HeroRays />
        <div className="hero-glow" aria-hidden />
        <div className="container hero-inner">
          <span className="hero-eyebrow"><Sparkles className="ico" aria-hidden />{ar ? `منصة حجز خدمات المناسبات في ${localized(country.name, lang)}` : `Event services in ${localized(country.name, lang)}`}</span>
          {ar
            ? <HeroTitle text="كل ما تحتاجه لمناسبتك في مكان واحد" gradient={[3]} breakAfter={[3]} />
            : <HeroTitle text="Everything for your occasion in one place" gradient={[2, 3]} breakAfter={[3]} />}
          <p className="hero-sub">{ar ? 'قاعات، تصوير، ضيافة، تنسيق وأكثر — أسعار واضحة، توافر فوري، وسياسة إلغاء معلنة قبل الدفع.' : 'Venues, photography, catering, decor and more — clear prices, live availability and a cancellation policy shown before you pay.'}</p>
          <form className="hero-search" action="/search" method="get">
            <label className="hs-field">
              <Search className="ico" aria-hidden />
              <input name="q" placeholder={ar ? 'ما الخدمة التي تبحث عنها؟' : 'What are you looking for?'} aria-label={ar ? 'الخدمة' : 'Service'} />
            </label>
            <label className="hs-field">
              <MapPin className="ico" aria-hidden />
              <input name="city" placeholder={ar ? 'المدينة' : 'City'} aria-label={ar ? 'المدينة' : 'City'} />
            </label>
            <label className="hs-field">
              <CalendarDays className="ico" aria-hidden />
              <input name="date" type="date" aria-label={ar ? 'التاريخ' : 'Date'} />
            </label>
            <StarButton><Search className="ico" aria-hidden />{ar ? 'ابحث' : 'Search'}</StarButton>
          </form>
          {cats.length > 0 && (
            <div className="hero-chips">
              {cats.slice(0, 6).map((c) => {
                const Icon = categoryIcon(c.slug, localized(c.name, 'ar'));
                return <Link key={c.id} href={`/search?category=${c.slug}`} className="chip"><Icon className="ico" aria-hidden />{localized(c.name, lang)}</Link>;
              })}
            </div>
          )}
          <div className="hero-trust">
            <span><ShieldCheck className="ico" aria-hidden />{ar ? 'دفع آمن' : 'Secure payment'}</span>
            <span><Receipt className="ico" aria-hidden />{ar ? 'دون رسوم خفية' : 'No hidden fees'}</span>
            <span><CalendarCheck className="ico" aria-hidden />{ar ? 'توافر لحظي' : 'Live availability'}</span>
          </div>
        </div>
      </section>

      <div className="container">
        {cats.length > 0 && (
          <section className="section">
            <div className="section-head">
              <div><h2>{ar ? 'تصفّح حسب التصنيف' : 'Browse by category'}</h2><p className="muted">{ar ? 'اختر نوع الخدمة وابدأ المقارنة' : 'Pick a service type and start comparing'}</p></div>
              <Link href="/search" className="link-more">{ar ? 'كل الخدمات' : 'All services'}<Arrow className="ico" aria-hidden /></Link>
            </div>
            <div className="cat-grid">
              {cats.map((c) => {
                const Icon = categoryIcon(c.slug, localized(c.name, 'ar'), localized(c.name, 'en'));
                return (
                  <Link key={c.id} href={`/search?category=${c.slug}`} className={`cat-card ${categoryTone(c.slug)}`}>
                    {c.imageUrl ? <img src={`/bff${c.imageUrl}`} alt="" className="cat-img" loading="lazy" /> : <span className="cat-icon"><Icon aria-hidden /></span>}
                    <strong>{localized(c.name, lang)}</strong>
                    {c.types.length > 0 && <span className="muted small">{c.types.map((t) => localized(t.name, lang)).join('، ')}</span>}
                  </Link>
                );
              })}
            </div>
          </section>
        )}

        <section className="section">
          <div className="section-head">
            <div><h2>{ar ? 'أضيف حديثًا' : 'Recently added'}</h2><p className="muted">{ar ? 'أحدث الخدمات المنشورة على المنصة' : 'The latest services on the platform'}</p></div>
            {!!latest?.total && <Link href="/search" className="link-more">{ar ? 'عرض الكل' : 'View all'}<Arrow className="ico" aria-hidden /></Link>}
          </div>
          {latest?.items.length ? <ServiceCards items={latest.items} lang={lang} display={await displayRates(latest.items.map((x) => x.currency), lang)} /> : <div className="empty">{ar ? 'لا توجد خدمات منشورة بعد.' : 'No services published yet.'}</div>}
        </section>

        <section className="section">
          <div className="section-head"><div><h2>{ar ? 'كيف تعمل المنصة؟' : 'How it works'}</h2></div></div>
          <div className="steps">
            {[
              { icon: Search, t: ar ? 'ابحث وقارن' : 'Search & compare', d: ar ? 'تصفح الخدمات بالصور والأسعار والتقييمات، واطلع على سياسة الإلغاء قبل الحجز.' : 'Browse photos, prices and reviews, and read the cancellation policy before booking.' },
              { icon: CalendarCheck, t: ar ? 'اختر الموعد' : 'Pick your date', d: ar ? 'التوافر لحظي، ويُحجز موعدك مؤقتًا أثناء إتمام الدفع.' : 'Availability is live, and your slot is held while you pay.' },
              { icon: CreditCard, t: ar ? 'ادفع بأمان' : 'Pay securely', d: ar ? 'عربون أو كامل المبلغ حسب الخدمة، مع فاتورة وإيصال لكل دفعة.' : 'Deposit or full amount per service, with an invoice and receipt for every payment.' },
            ].map((s, i) => (
              <div key={i} className="step">
                <span className="step-num"><CountNumber value={i + 1} /></span>
                <span className="step-icon"><s.icon aria-hidden /></span>
                <h3>{s.t}</h3>
                <p className="muted">{s.d}</p>
              </div>
            ))}
          </div>
        </section>

        {providerUrl && (
          <section className="cta">
            <div>
              <h2>{ar ? 'هل تقدّم خدمات للمناسبات؟' : 'Do you offer event services?'}</h2>
              <p>{ar ? 'انضم كصاحب خدمة، واعرض خدماتك وأدر حجوزاتك وتقويمك ومستحقاتك من لوحة واحدة.' : 'Join as a provider and manage your services, bookings, calendar and earnings from one panel.'}</p>
            </div>
            <a href={`${providerUrl}/register`} className="btn btn-lg cta-btn"><Store className="ico" aria-hidden />{ar ? 'سجّل كصاحب خدمة' : 'Become a provider'}</a>
          </section>
        )}
      </div>
    </>
  );
}
