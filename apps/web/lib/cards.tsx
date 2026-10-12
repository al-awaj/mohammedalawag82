import Link from 'next/link';
import { formatMoney, localized, type Lang } from '@events/shared';

export interface ServiceCard {
  id: string; title: Record<string, string>; city: string; fromPrice: string; currency: string; pricingUnit: string; typeName: Record<string, string>;
  providerName: string | null; rating: string | null; reviewCount: number; coverUrl: string | null; requiresProviderApproval: boolean; distanceKm: number | null;
}
const UNIT: Record<string, { ar: string; en: string }> = {
  fixed: { ar: '', en: '' }, per_hour: { ar: '/ساعة', en: '/hour' }, per_day: { ar: '/يوم', en: '/day' }, per_person: { ar: '/شخص', en: '/person' }, per_unit: { ar: '/وحدة', en: '/unit' },
};

export function ServiceCards({ items, lang }: { items: ServiceCard[]; lang: Lang }) {
  return (
    <div className="cards">
      {items.map((s) => (
        <Link key={s.id} href={`/services/${s.id}`} className="svc-card">
          {s.coverUrl ? <img className="svc-cover" src={`/bff${s.coverUrl}`} alt={localized(s.title, lang)} loading="lazy" /> : <div className="svc-cover" />}
          <div className="svc-body">
            <span className="muted small">{localized(s.typeName, lang)} · {s.city}{s.distanceKm !== null ? ` · ${s.distanceKm} km` : ''}</span>
            <span className="svc-title">{localized(s.title, lang)}</span>
            {s.providerName && <span className="muted small">{s.providerName}</span>}
            <span>
              <span className="muted small">{lang === 'ar' ? 'يبدأ من ' : 'From '}</span>
              <span className="price num" dir="ltr">{formatMoney(s.fromPrice, s.currency)}</span>
              <span className="muted small">{UNIT[s.pricingUnit]?.[lang]}</span>
            </span>
            <span className="small">
              {s.rating ? <><span className="stars">★</span> {s.rating} ({s.reviewCount})</> : <span className="muted">{lang === 'ar' ? 'لا تقييمات بعد' : 'No reviews yet'}</span>}
              {s.requiresProviderApproval && <span className="muted"> · {lang === 'ar' ? 'يتطلب تأكيد صاحب الخدمة' : 'Needs provider confirmation'}</span>}
            </span>
          </div>
        </Link>
      ))}
    </div>
  );
}
