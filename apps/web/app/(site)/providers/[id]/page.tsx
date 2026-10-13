import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { formatDate, type Lang } from '@events/shared';
import { ServiceCards, type ServiceCard } from '@/lib/cards';
import { publicGet, visitor } from '@/lib/server';

interface PublicProvider {
  id: string; businessName: string; activityType: string; city: string; description: string | null; countryCode: string;
  memberSince: string; rating: { average: string | null; count: number }; serviceCount: number;
}

/** Only exists for providers whose identity may be shown; otherwise the API answers 404 and so does this page. */
async function load(id: string, lang: Lang) {
  return /^[0-9a-f-]{36}$/.test(id) ? publicGet<PublicProvider>(`/v1/providers/${id}`, lang) : null;
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const { lang } = await visitor();
  const p = await load(id, lang);
  return p ? { title: p.businessName, description: (p.description ?? p.activityType).slice(0, 160) } : {};
}

export default async function ProviderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { lang } = await visitor();
  const p = await load(id, lang);
  if (!p) notFound();
  const ar = lang === 'ar';
  const services = await publicGet<{ total: number; items: ServiceCard[] }>(`/v1/services?country=${p.countryCode}&provider=${p.id}&limit=50`, lang);
  return (
    <div data-testid="provider-page">
      <div className="card">
        <h1>{p.businessName}</h1>
        <p className="muted">
          {p.activityType} · {p.city}
          {p.rating.average && <> · <span className="stars">★</span> {p.rating.average} ({p.rating.count})</>}
          {' · '}{ar ? 'على المنصة منذ ' : 'On the platform since '}{formatDate(p.memberSince, lang)}
        </p>
        {p.description && <p style={{ whiteSpace: 'pre-wrap' }}>{p.description}</p>}
      </div>
      <h2>{ar ? `الخدمات (${p.serviceCount})` : `Services (${p.serviceCount})`}</h2>
      {services?.items.length ? <ServiceCards items={services.items} lang={lang} /> : <div className="empty">{ar ? 'لا توجد خدمات منشورة حاليًا.' : 'No published services right now.'}</div>}
    </div>
  );
}
