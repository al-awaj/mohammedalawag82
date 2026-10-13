'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { formatDate, formatMoney, formatTime, localized } from '@events/shared';
import { useApp, useGet, useSession, useTr } from '@events/web-kit/client';
import { Button, ErrorBox, Notice } from '@events/web-kit/ui';

export interface PublicService {
  id: string; title: Record<string, string>; description: Record<string, string>; terms: Record<string, string> | null; city: string; countryCode: string;
  basePrice: string; currency: string; pricingUnit: string; durationMinutes: number | null; capacity: number | null; requiresProviderApproval: boolean;
  depositType: string; depositValue: string; typeName: Record<string, string>; bookingMode: 'time_slot' | 'full_day' | 'date_range' | 'quantity_rental'; capacityMode: string;
  providerName: string | null; attributes: Record<string, unknown>;
  fields: { key: string; label: Record<string, string>; dataType: string; options: { value: string; label: Record<string, string> }[] }[];
  cancellationPolicy: { description: Record<string, string>; tiers: { hoursBefore: number; refundPercentOfPaid: number }[]; depositRefundable: boolean } | null;
  packages: { id: string; name: Record<string, string>; description: Record<string, string> | null; price: string; currency: string; inclusions: unknown[]; addOns: { code: string; name: Record<string, string>; price: string }[]; durationMinutes: number | null; terms: Record<string, string> | null }[];
  rentalItems: { id: string; name: Record<string, string>; quantityTotal: number; pricePerDay: string; currency: string; securityDeposit: string | null }[];
  media: { id: string; kind: string; caption: Record<string, string> | null; packageId: string | null; url: string }[];
  rating: { average: string | null; count: number };
}
type Day = { date: string; open: boolean; available: boolean; slots?: { start: string; end: string; available: boolean }[] };
type Quote = { subtotal: string; total: string; upfrontAmount: string; balanceDueAt: string | null; currency: string; addOns: { code: string; price: string }[]; securityDepositAmount?: string };

const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: string, n: number) => iso(new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000));

/** Date/slot picker with a live quote; adding to the cart holds nothing until checkout. */
export function BookingWidget({ service: s }: { service: PublicService }) {
  const tr = useTr();
  const { api, lang } = useApp();
  const router = useRouter();
  const qc = useQueryClient();
  const session = useSession().data;
  const today = iso(new Date());
  const [from, setFrom] = useState(addDays(today, 1));
  const [day, setDay] = useState<string | null>(null);
  const [endDay, setEndDay] = useState<string | null>(null);
  const [slot, setSlot] = useState<string | null>(null);
  const [packageId, setPackageId] = useState('');
  const [rentalItemId, setRentalItemId] = useState(s.rentalItems[0]?.id ?? '');
  const [addOns, setAddOns] = useState<string[]>([]);
  const [guests, setGuests] = useState('');
  const [units, setUnits] = useState('1');
  const [quote, setQuote] = useState<Quote | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const range = s.bookingMode === 'date_range' || s.bookingMode === 'quantity_rental';
  const avail = useGet<{ days: Day[]; timezone: string }>(`/v1/services/${s.id}/availability`, { from, to: addDays(from, 27), ...(s.bookingMode === 'quantity_rental' && rentalItemId ? { rentalItemId } : {}) });
  const pkg = s.packages.find((p) => p.id === packageId);

  const item = useMemo(() => {
    if (!day) return null;
    const base = { serviceId: s.id, packageId: packageId || null, rentalItemId: s.bookingMode === 'quantity_rental' ? rentalItemId || null : null, addOns,
      guests: guests ? Number(guests) : null, units: Number(units) || 1 };
    if (s.bookingMode === 'time_slot') return slot ? { ...base, startAt: slot } : null;
    if (range) return { ...base, startDate: day, endDate: endDay ?? day };
    return { ...base, date: day };
  }, [day, endDay, slot, packageId, rentalItemId, addOns, guests, units, s, range]);

  useEffect(() => {
    setQuote(null); setError(null);
    if (!item) return;
    let live = true;
    api.post<Quote>('/v1/quote', item).then((q) => live && setQuote(q)).catch((e) => live && setError(e));
    return () => { live = false; };
  }, [item, api]);

  const pick = (d: Day) => {
    setSlot(null);
    if (range && day && !endDay && d.date >= day) { setEndDay(d.date); return; }
    setDay(d.date); setEndDay(null);
  };
  const add = async () => {
    if (!session) { router.push(`/login?next=${encodeURIComponent(`/services/${s.id}`)}`); return; }
    setBusy(true); setError(null);
    try { await api.post('/v1/cart/items', item); await qc.invalidateQueries(); router.push('/cart'); } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const days = avail.data?.days ?? [];
  const selectedDay = days.find((d) => d.date === day);
  return (
    <div className="card">
      <div className="row between">
        <span><span className="muted small">{tr({ ar: 'يبدأ من', en: 'From' })} </span><span className="price num" dir="ltr">{formatMoney(s.basePrice, s.currency)}</span></span>
        {s.requiresProviderApproval && <span className="badge badge-warn">{tr({ ar: 'يتطلب تأكيد صاحب الخدمة', en: 'Needs provider confirmation' })}</span>}
      </div>
      {s.packages.length > 0 && (
        <label className="field" style={{ marginTop: 10 }}><span>{tr({ ar: 'الباقة', en: 'Package' })}</span>
          <select name="packageId" value={packageId} onChange={(e) => { setPackageId(e.target.value); setAddOns([]); }}>
            <option value="">{tr({ ar: 'الخدمة الأساسية', en: 'Base service' })}</option>
            {s.packages.map((p) => <option key={p.id} value={p.id}>{localized(p.name, lang)} — {formatMoney(p.price, p.currency)}</option>)}
          </select>
        </label>
      )}
      {pkg && pkg.addOns.length > 0 && (
        <div className="checks" style={{ margin: '8px 0' }}>
          {pkg.addOns.map((a) => (
            <label key={a.code} className="check"><input type="checkbox" checked={addOns.includes(a.code)} onChange={(e) => setAddOns(e.target.checked ? [...addOns, a.code] : addOns.filter((x) => x !== a.code))} />
              {localized(a.name, lang)} (+{formatMoney(a.price, pkg.currency)})</label>
          ))}
        </div>
      )}
      {s.bookingMode === 'quantity_rental' && s.rentalItems.length > 0 && <>
        <label className="field"><span>{tr({ ar: 'العنصر', en: 'Item' })}</span>
          <select value={rentalItemId} onChange={(e) => setRentalItemId(e.target.value)}>{s.rentalItems.map((r) => <option key={r.id} value={r.id}>{localized(r.name, lang)} — {formatMoney(r.pricePerDay, r.currency)}/{tr({ ar: 'يوم', en: 'day' })}</option>)}</select>
        </label>
        <label className="field"><span>{tr({ ar: 'الكمية', en: 'Quantity' })}</span><input type="number" min={1} value={units} onChange={(e) => setUnits(e.target.value)} /></label>
      </>}
      {s.capacityMode === 'guests' && (
        <label className="field"><span>{tr({ ar: 'عدد الضيوف', en: 'Guests' })}</span><input name="guests" type="number" min={1} max={s.capacity ?? undefined} value={guests} onChange={(e) => setGuests(e.target.value)} /></label>
      )}
      <div className="row between" style={{ margin: '12px 0 6px' }}>
        <Button variant="ghost" disabled={from <= today} onClick={() => setFrom(addDays(from, -28))}>‹</Button>
        <strong className="small">{formatDate(from, lang)} — {formatDate(addDays(from, 27), lang)}</strong>
        <Button variant="ghost" onClick={() => setFrom(addDays(from, 28))}>›</Button>
      </div>
      <ErrorBox error={avail.error} />
      <div className="days" aria-label={tr({ ar: 'الأيام المتاحة', en: 'Available days' })}>
        {days.map((d) => {
          const inRange = day && endDay && d.date >= day && d.date <= endDay;
          return <button key={d.date} type="button" className={`day ${d.date === day || inRange ? 'selected' : ''}`} disabled={!d.available} data-date={d.date} onClick={() => pick(d)}>{Number(d.date.slice(8))}</button>;
        })}
      </div>
      {range && day && <p className="small muted">{endDay ? `${formatDate(day, lang)} → ${formatDate(endDay, lang)}` : tr({ ar: 'اختر يوم النهاية (أو اترك يومًا واحدًا)', en: 'Pick the end day (or keep one day)' })}</p>}
      {s.bookingMode === 'time_slot' && selectedDay?.slots && (
        <div className="slots" style={{ marginTop: 10 }}>
          {selectedDay.slots.map((x) => <button key={x.start} type="button" className={`btn ${slot === x.start ? 'btn-primary' : 'btn-secondary'}`} disabled={!x.available} onClick={() => setSlot(x.start)}>{formatTime(x.start, lang, avail.data?.timezone)}</button>)}
        </div>
      )}
      <ErrorBox error={error} />
      {quote && (
        <div style={{ marginTop: 12 }}>
          <dl className="detail" style={{ gridTemplateColumns: '1fr' }}>
            <div className="detail-row"><dt>{tr({ ar: 'الإجمالي', en: 'Total' })}</dt><dd className="price num" dir="ltr">{formatMoney(quote.total, quote.currency)}</dd></div>
            <div className="detail-row"><dt>{tr({ ar: 'المطلوب عند الحجز', en: 'Due when booking' })}</dt><dd className="num" dir="ltr">{formatMoney(quote.upfrontAmount, quote.currency)}</dd></div>
            {quote.balanceDueAt && quote.upfrontAmount !== quote.total && <div className="detail-row"><dt>{tr({ ar: 'المتبقي يُستحق في', en: 'Balance due on' })}</dt><dd>{formatDate(quote.balanceDueAt, lang)}</dd></div>}
          </dl>
          <Notice>{tr({ ar: 'لا رسوم إضافية. يُحجز الموعد مؤقتًا عند إتمام الطلب حتى تدفع.', en: 'No extra fees. The slot is held temporarily when you place the order, until you pay.' })}</Notice>
          <Button variant="primary" disabled={busy} onClick={add}>{tr({ ar: 'أضف إلى السلة', en: 'Add to cart' })}</Button>
        </div>
      )}
    </div>
  );
}
