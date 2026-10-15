import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { formatDate, formatMoney, localized, type Lang } from '@events/shared';
import { BookingWidget, type PublicService } from '@/lib/booking-widget';
import { publicGet, visitor } from '@/lib/server';

type Reviews = { count: number; average: string | null; items: { id: string; rating: number; comment: string | null; reviewer: string; createdAt: string }[] };

async function load(id: string, lang: Lang) {
  return publicGet<PublicService>(`/v1/services/${id}`, lang);
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const { lang } = await visitor();
  const s = await load(id, lang);
  if (!s) return {};
  return { title: localized(s.title, lang), description: localized(s.description, lang).slice(0, 160) };
}

export default async function ServicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { lang } = await visitor();
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const [s, reviews] = await Promise.all([load(id, lang), publicGet<Reviews>(`/v1/services/${id}/reviews?limit=20`, lang)]);
  if (!s) notFound();
  const ar = lang === 'ar';
  const images = s.media.filter((m) => m.kind === 'image' && !m.packageId);
  const policy = s.cancellationPolicy;
  return (
    <div className="layout-2">
      <div>
        <h1>{localized(s.title, lang)}</h1>
        <p className="muted">
          {localized(s.typeName, lang)} · {s.city}{s.providerName && <> · {s.providerId ? <a href={`/providers/${s.providerId}`} data-testid="provider-link">{s.providerName}</a> : s.providerName}</>}
          {s.rating.average && <> · <span className="stars">★</span> {s.rating.average} ({s.rating.count})</>}
        </p>
        {images.length > 0 && <div className="gallery">{images.map((m) => <img key={m.id} src={`/bff${m.url}`} alt={m.caption ? localized(m.caption, lang) : ''} loading="lazy" />)}</div>}
        {s.media.filter((m) => m.kind === 'video').map((m) => <video key={m.id} src={`/bff${m.url}`} controls style={{ width: '100%', borderRadius: 10, marginBottom: 12 }} />)}
        <div className="card"><p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{localized(s.description, lang)}</p></div>
        {s.fields.length > 0 && (
          <div className="card">
            <dl className="detail">
              {s.fields.filter((f) => s.attributes[f.key] !== undefined && s.attributes[f.key] !== null).map((f) => {
                const v = s.attributes[f.key];
                const opt = (x: unknown) => localized(f.options.find((o) => o.value === x)?.label ?? String(x), lang);
                return (
                  <div key={f.key} className="detail-row">
                    <dt>{localized(f.label, lang)}</dt>
                    <dd>{f.dataType === 'location' && v && typeof v === 'object'
                      ? <a href={`https://www.google.com/maps/search/?api=1&query=${(v as { lat: number }).lat},${(v as { lng: number }).lng}`} target="_blank" rel="noopener noreferrer">{ar ? 'افتح في الخرائط' : 'Open in maps'}</a>
                      : Array.isArray(v) ? v.map(opt).join('، ') : typeof v === 'boolean' ? (v ? '✓' : '✗') : typeof v === 'object' ? localized(v, lang) : opt(v)}</dd>
                  </div>
                );
              })}
            </dl>
          </div>
        )}
        {s.packages.length > 0 && (
          <div className="card">
            <h2>{ar ? 'الباقات' : 'Packages'}</h2>
            {s.packages.map((p) => (
              <div key={p.id} style={{ borderTop: '1px solid var(--border)', paddingTop: 10, marginTop: 10 }}>
                <div className="row between"><strong>{localized(p.name, lang)}</strong><span className="price num" dir="ltr">{formatMoney(p.price, p.currency)}</span></div>
                {p.description && <p className="muted small">{localized(p.description, lang)}</p>}
                {s.media.some((m) => m.packageId === p.id) && <div className="gallery">{s.media.filter((m) => m.packageId === p.id && m.kind === 'image').map((m) => <img key={m.id} src={`/bff${m.url}`} alt={m.caption ? localized(m.caption, lang) : localized(p.name, lang)} loading="lazy" />)}</div>}
                {p.durationMinutes && <p className="small muted">{ar ? `المدة: ${p.durationMinutes} دقيقة` : `Duration: ${p.durationMinutes} minutes`}</p>}
                {p.inclusions.length > 0 && <ul className="small">{p.inclusions.map((i, n) => <li key={n}>{localized(i, lang)}</li>)}</ul>}
                {p.addOns.length > 0 && <p className="small muted">{ar ? 'إضافات اختيارية: ' : 'Optional add-ons: '}{p.addOns.map((a) => `${localized(a.name, lang)} (${formatMoney(a.price, p.currency)})`).join('، ')}</p>}
                {p.terms && <p className="small muted">{ar ? 'شروط الباقة: ' : 'Package terms: '}{localized(p.terms, lang)}</p>}
              </div>
            ))}
          </div>
        )}
        {s.latitude != null && s.longitude != null && (
          <div className="card" data-testid="service-map">
            <h2>{ar ? 'الموقع' : 'Location'}</h2>
            <iframe className="map-embed" title={ar ? 'الخريطة' : 'Map'} loading="lazy" referrerPolicy="no-referrer" style={{ height: 280 }}
              src={`https://www.openstreetmap.org/export/embed.html?bbox=${s.longitude - 0.006},${s.latitude - 0.006},${s.longitude + 0.006},${s.latitude + 0.006}&layer=mapnik&marker=${s.latitude},${s.longitude}`} />
            <div className="row gap wrap" style={{ marginTop: 10, justifyContent: 'space-between', alignItems: 'center' }}>
              <span className="muted">{[s.address, s.city].filter(Boolean).join('، ')}</span>
              <a className="btn btn-secondary" href={`https://www.google.com/maps/search/?api=1&query=${s.latitude},${s.longitude}`} target="_blank" rel="noopener noreferrer">{ar ? 'افتح في الخرائط' : 'Open in maps'}</a>
            </div>
          </div>
        )}
        <div className="card">
          <h2>{ar ? 'سياسة الإلغاء' : 'Cancellation policy'}</h2>
          {policy ? <>
            <p>{localized(policy.description, lang)}</p>
            <ul className="small">
              {policy.tiers.map((t) => <li key={t.hoursBefore}>{ar ? `الإلغاء قبل ${t.hoursBefore} ساعة أو أكثر: استرداد ${t.refundPercentOfPaid}% من المدفوع` : `Cancel ${t.hoursBefore}+ hours ahead: ${t.refundPercentOfPaid}% of what you paid is refunded`}</li>)}
              <li>{policy.depositRefundable ? (ar ? 'العربون قابل للاسترداد ضمن هذه النسب.' : 'The deposit is refundable within these percentages.') : (ar ? 'العربون غير قابل للاسترداد.' : 'The deposit is not refundable.')}</li>
            </ul>
          </> : <p className="muted">{ar ? 'لا توجد سياسة إلغاء محددة؛ يُراجع أي إلغاء من الإدارة.' : 'No specific policy; any cancellation is reviewed by the administration.'}</p>}
          {s.terms && <><h3>{ar ? 'شروط الخدمة' : 'Service terms'}</h3><p className="small" style={{ whiteSpace: 'pre-wrap' }}>{localized(s.terms, lang)}</p></>}
        </div>
        <div className="card">
          <h2>{ar ? 'التقييمات' : 'Reviews'} {reviews?.average && <span className="small"><span className="stars">★</span> {reviews.average} ({reviews.count})</span>}</h2>
          {!reviews?.items.length ? <p className="muted">{ar ? 'لا توجد تقييمات بعد.' : 'No reviews yet.'}</p> : reviews.items.map((r) => (
            <div key={r.id} style={{ borderTop: '1px solid var(--border)', paddingTop: 8, marginTop: 8 }}>
              <span className="stars">{'★'.repeat(r.rating)}{'☆'.repeat(5 - r.rating)}</span> <strong>{r.reviewer}</strong> <span className="muted small">{formatDate(r.createdAt, lang)}</span>
              {r.comment && <p style={{ margin: '4px 0' }}>{r.comment}</p>}
            </div>
          ))}
        </div>
      </div>
      <aside className="sticky"><BookingWidget service={s} /></aside>
    </div>
  );
}
