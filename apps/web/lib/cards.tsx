import Link from 'next/link';
import { BadgeCheck, MapPin, Star } from 'lucide-react';
import { formatMoney, localized, type Lang } from '@events/shared';
import { categoryIcon } from './icons';

export interface ServiceCard {
  id: string; title: Record<string, string>; city: string; fromPrice: string; currency: string; pricingUnit: string; typeName: Record<string, string>;
  providerName: string | null; rating: string | null; reviewCount: number; coverUrl: string | null; requiresProviderApproval: boolean; distanceKm: number | null;
}
const UNIT: Record<string, { ar: string; en: string }> = {
  fixed: { ar: '', en: '' }, per_hour: { ar: '/ساعة', en: '/hour' }, per_day: { ar: '/يوم', en: '/day' }, per_person: { ar: '/شخص', en: '/person' }, per_unit: { ar: '/وحدة', en: '/unit' },
};

export function ServiceCards({ items, lang }: { items: ServiceCard[]; lang: Lang }) {
  const ar = lang === 'ar';
  return (
    <div className="cards">
      {items.map((s) => {
        const Icon = categoryIcon(localized(s.typeName, 'en'), localized(s.typeName, 'ar'));
        return (
          <Link key={s.id} href={`/services/${s.id}`} className="svc-card">
            <div className="svc-media">
              {s.coverUrl ? <img className="svc-cover" src={`/bff${s.coverUrl}`} alt={localized(s.title, lang)} loading="lazy" />
                : <div className="svc-cover svc-cover-empty"><Icon aria-hidden /></div>}
              <span className="svc-chip"><Icon className="ico" aria-hidden />{localized(s.typeName, lang)}</span>
              {s.rating && <span className="svc-rating"><Star className="ico" aria-hidden />{s.rating}<span className="muted"> ({s.reviewCount})</span></span>}
            </div>
            <div className="svc-body">
              <span className="svc-title">{localized(s.title, lang)}</span>
              <span className="svc-meta"><MapPin className="ico" aria-hidden />{s.city}{s.distanceKm !== null ? ` · ${s.distanceKm} km` : ''}{s.providerName ? ` · ${s.providerName}` : ''}</span>
              <div className="svc-foot">
                <span>
                  <span className="muted small">{ar ? 'يبدأ من ' : 'From '}</span>
                  <span className="price num" dir="ltr">{formatMoney(s.fromPrice, s.currency)}</span>
                  <span className="muted small">{UNIT[s.pricingUnit]?.[lang]}</span>
                </span>
                {s.requiresProviderApproval
                  ? <span className="pill pill-warn">{ar ? 'بتأكيد صاحب الخدمة' : 'Provider confirms'}</span>
                  : <span className="pill pill-ok"><BadgeCheck className="ico" aria-hidden />{ar ? 'حجز فوري' : 'Instant'}</span>}
              </div>
            </div>
          </Link>
        );
      })}
    </div>
  );
}
