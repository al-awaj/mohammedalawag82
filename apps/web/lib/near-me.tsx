'use client';
import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { LocateFixed, X } from 'lucide-react';

/** Sorts results by distance from the visitor's location; the location is only sent with this search, never stored. */
export function NearMe({ ar }: { ar: boolean }) {
  const router = useRouter();
  const sp = useSearchParams();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const active = sp.has('lat') && sp.has('lng');
  const go = (next: URLSearchParams) => router.push(`/search?${next.toString()}`);
  const locate = () => {
    if (!navigator.geolocation) { setMsg(ar ? 'المتصفح لا يدعم تحديد الموقع' : 'This browser cannot share its location'); return; }
    setBusy(true); setMsg(null);
    navigator.geolocation.getCurrentPosition((p) => {
      const next = new URLSearchParams(sp.toString());
      next.set('lat', p.coords.latitude.toFixed(5)); next.set('lng', p.coords.longitude.toFixed(5)); next.set('sort', 'distance'); next.delete('offset');
      setBusy(false); go(next);
    }, () => { setBusy(false); setMsg(ar ? 'تعذر الحصول على موقعك؛ تحقق من إذن الموقع' : 'Could not get your location; check the location permission'); }, { timeout: 10_000 });
  };
  const clear = () => {
    const next = new URLSearchParams(sp.toString());
    ['lat', 'lng', 'radiusKm', 'offset'].forEach((k) => next.delete(k));
    if (next.get('sort') === 'distance') next.delete('sort');
    go(next);
  };
  return (
    <div className="near-me">
      {active
        ? <button type="button" className="btn btn-secondary" onClick={clear}><X className="ico" aria-hidden />{ar ? 'إلغاء البحث القريب' : 'Clear nearby search'}</button>
        : <button type="button" className="btn btn-secondary" onClick={locate} disabled={busy} data-testid="near-me"><LocateFixed className="ico" aria-hidden />{busy ? (ar ? 'جارٍ تحديد موقعك…' : 'Locating…') : (ar ? 'الأقرب إليّ' : 'Near me')}</button>}
      {msg && <small className="field-error">{msg}</small>}
    </div>
  );
}
