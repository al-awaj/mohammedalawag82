import Link from 'next/link';
import { localized } from '@events/shared';
import { ServiceCards, type ServiceCard } from '@/lib/cards';
import { currentCountry, publicGet, visitor } from '@/lib/server';

type Category = { id: string; slug: string; name: Record<string, string>; description: Record<string, string> | null; imageUrl: string | null; types: { id: string; code: string; name: Record<string, string> }[]; children: Category[] };

export default async function Home() {
  const { lang, country: code } = await visitor();
  const { country } = await currentCountry(lang, code);
  const ar = lang === 'ar';
  if (!country) return <div className="empty">{ar ? 'لا توجد دول مفعّلة حاليًا.' : 'No countries are available yet.'}</div>;
  const [categories, latest] = await Promise.all([
    publicGet<Category[]>(`/v1/categories?country=${country.code}`, lang),
    publicGet<{ items: ServiceCard[] }>(`/v1/services?country=${country.code}&sort=newest&limit=8`, lang),
  ]);
  return (
    <>
      <section className="hero">
        <h1>{ar ? 'كل خدمات مناسبتك في مكان واحد' : 'Everything for your occasion, in one place'}</h1>
        <p className="muted">{ar ? 'قاعات، تصوير، ضيافة، تجهيزات وأكثر — بأسعار واضحة وتوافر فوري وسياسة إلغاء معلنة قبل الدفع.' : 'Venues, photography, catering, equipment and more — clear prices, live availability and a cancellation policy shown before you pay.'}</p>
        <form className="search-bar" action="/search" method="get">
          <input name="q" placeholder={ar ? 'ابحث عن خدمة…' : 'Search for a service…'} />
          <input name="city" placeholder={ar ? 'المدينة' : 'City'} />
          <input name="date" type="date" aria-label={ar ? 'التاريخ' : 'Date'} />
          <button className="btn btn-primary" type="submit">{ar ? 'بحث' : 'Search'}</button>
        </form>
      </section>
      <h2 style={{ marginBottom: 12 }}>{ar ? 'التصنيفات' : 'Categories'}</h2>
      <div className="tiles" style={{ marginBottom: 28 }}>
        {(categories ?? []).flatMap((c) => [c, ...c.children]).map((c) => (
          <Link key={c.id} href={`/search?category=${c.slug}`} className="tile">
            <strong>{localized(c.name, lang)}</strong>
            <div className="muted small">{c.types.map((t) => localized(t.name, lang)).join('، ')}</div>
          </Link>
        ))}
      </div>
      <h2 style={{ marginBottom: 12 }}>{ar ? 'أضيف حديثًا' : 'Recently added'}</h2>
      {latest?.items.length ? <ServiceCards items={latest.items} lang={lang} /> : <div className="empty">{ar ? 'لا توجد خدمات منشورة بعد.' : 'No services published yet.'}</div>}
    </>
  );
}
