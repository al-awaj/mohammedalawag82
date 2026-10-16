import Link from 'next/link';
import { Suspense } from 'react';
import type { Metadata } from 'next';
import { toQueryString } from '@events/shared';
import { ServiceCards, type ServiceCard } from '@/lib/cards';
import { currentCountry, publicGet, visitor, displayRates } from '@/lib/server';
import { NearMe } from '@/lib/near-me';
import { CountNumber } from '@/lib/home-motion';

export const metadata: Metadata = { title: 'البحث عن خدمات' };
const KEYS = ['q', 'category', 'type', 'city', 'date', 'minPrice', 'maxPrice', 'minRating', 'sort', 'lat', 'lng', 'radiusKm'] as const;
const LIMIT = 24;

export default async function Search({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const { lang, country: code } = await visitor();
  const { country } = await currentCountry(lang, code);
  const ar = lang === 'ar';
  const offset = Math.max(0, Number(sp.offset ?? 0) || 0);
  // The API needs at least 2 characters to search text.
  const q = Object.fromEntries(KEYS.map((k) => [k, sp[k]?.trim()]).filter(([k, v]) => v && !(k === 'q' && v.length < 2))) as Record<string, string>;
  const geo = !!(q.lat && q.lng);
  if (!geo) { delete q.radiusKm; if (q.sort === 'distance') delete q.sort; }
  const res = country ? await publicGet<{ total: number; items: ServiceCard[] }>(`/v1/services${toQueryString({ ...q, country: country.code, limit: LIMIT, offset })}`, lang) : null;
  return (
    <>
      <form className="filters card" action="/search" method="get">
        <label className="filter"><span>{ar ? 'بحث' : 'Search'}</span><input name="q" defaultValue={sp.q} /></label>
        <label className="filter"><span>{ar ? 'المدينة' : 'City'}</span><input name="city" defaultValue={sp.city} /></label>
        <label className="filter"><span>{ar ? 'متاح في تاريخ' : 'Available on'}</span><input name="date" type="date" defaultValue={sp.date} /></label>
        <label className="filter"><span>{ar ? 'السعر من' : 'Min price'}</span><input name="minPrice" inputMode="decimal" defaultValue={sp.minPrice} /></label>
        <label className="filter"><span>{ar ? 'إلى' : 'Max price'}</span><input name="maxPrice" inputMode="decimal" defaultValue={sp.maxPrice} /></label>
        <label className="filter"><span>{ar ? 'أقل تقييم' : 'Min rating'}</span>
          <select name="minRating" defaultValue={sp.minRating ?? ''}><option value="">—</option>{[4, 3, 2].map((r) => <option key={r} value={r}>{r}+</option>)}</select></label>
        <label className="filter"><span>{ar ? 'الترتيب' : 'Sort'}</span>
          <select name="sort" defaultValue={sp.sort ?? 'newest'}>
            <option value="newest">{ar ? 'الأحدث' : 'Newest'}</option><option value="price_asc">{ar ? 'الأقل سعرًا' : 'Lowest price'}</option>
            <option value="price_desc">{ar ? 'الأعلى سعرًا' : 'Highest price'}</option><option value="rating">{ar ? 'الأعلى تقييمًا' : 'Top rated'}</option>
            {geo && <option value="distance">{ar ? 'الأقرب' : 'Nearest'}</option>}
          </select></label>
        {geo && <>
          <label className="filter"><span>{ar ? 'ضمن مسافة' : 'Within'}</span>
            <select name="radiusKm" defaultValue={sp.radiusKm ?? ''}><option value="">—</option>{[5, 10, 25, 50, 100].map((r) => <option key={r} value={r}>{r} km</option>)}</select></label>
          <input type="hidden" name="lat" value={q.lat} /><input type="hidden" name="lng" value={q.lng} />
        </>}
        {sp.category && <input type="hidden" name="category" value={sp.category} />}
        <button className="btn btn-primary" type="submit">{ar ? 'تطبيق' : 'Apply'}</button>
        <Suspense fallback={null}><NearMe ar={ar} /></Suspense>
      </form>
      {!res ? <div className="alert alert-error">{ar ? 'تعذر تحميل النتائج.' : 'Could not load results.'}</div> : <>
        <p className="muted"><CountNumber value={res.total} /> {ar ? 'نتيجة' : 'results'}</p>
        {res.items.length ? <ServiceCards items={res.items} lang={lang} display={await displayRates(res.items.map((x) => x.currency), lang)} /> : <div className="empty">{ar ? 'لا توجد نتائج مطابقة.' : 'No matching services.'}</div>}
        <div className="pager">
          {offset > 0 && <Link className="btn btn-ghost" href={`/search${toQueryString({ ...q, offset: Math.max(0, offset - LIMIT) })}`}>{ar ? 'السابق' : 'Previous'}</Link>}
          {offset + LIMIT < res.total && <Link className="btn btn-ghost" href={`/search${toQueryString({ ...q, offset: offset + LIMIT })}`}>{ar ? 'التالي' : 'Next'}</Link>}
        </div>
      </>}
    </>
  );
}
