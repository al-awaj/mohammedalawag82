'use client';
import { useState } from 'react';
import { LocateFixed, MapPin } from 'lucide-react';
import { useTr } from '../client';

export interface Geo { lat: number; lng: number }

/** Parses coordinates; accepts "24.7136, 46.6753" and Google/Apple/OSM map links that carry them. */
export function parseGeo(text: string): Geo | null {
  const m = /(-?\d{1,2}(?:\.\d+)?)\s*(?:,|\s|&mlon=)\s*(-?\d{1,3}(?:\.\d+)?)/.exec(decodeURIComponent(text).replace(/.*[@?&](?:q|ll|query|mlat)=|.*@/, ''));
  if (!m) return null;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
}

/** Link that opens the place in the visitor's maps app (Google Maps handles the coordinates on every platform). */
export const mapsUrl = (g: Geo) => `https://www.google.com/maps/search/?api=1&query=${g.lat},${g.lng}`;

/** OpenStreetMap view with a marker; no key and no tracking script, just an iframe. */
export function MapEmbed({ lat, lng, height = 260, label }: { lat: number; lng: number; height?: number; label?: string }) {
  const d = 0.006;
  const src = `https://www.openstreetmap.org/export/embed.html?bbox=${lng - d},${lat - d},${lng + d},${lat + d}&layer=mapnik&marker=${lat},${lng}`;
  return <iframe className="map-embed" title={label ?? 'map'} src={src} style={{ height }} loading="lazy" referrerPolicy="no-referrer" />;
}

/** Map block with an "open in maps" link, for service and event pages. */
export function LocationCard({ lat, lng, address }: { lat: number | string | null | undefined; lng: number | string | null | undefined; address?: string | null }) {
  const tr = useTr();
  if (lat === null || lat === undefined || lng === null || lng === undefined) return null;
  const g = { lat: Number(lat), lng: Number(lng) };
  return (
    <div className="location-card">
      <MapEmbed lat={g.lat} lng={g.lng} label={address ?? undefined} />
      <div className="row gap wrap" style={{ alignItems: 'center', justifyContent: 'space-between' }}>
        {address && <span className="muted"><MapPin className="ico" aria-hidden /> {address}</span>}
        <a className="btn btn-secondary" href={mapsUrl(g)} target="_blank" rel="noopener noreferrer">{tr({ ar: 'افتح في الخرائط', en: 'Open in maps' })}</a>
      </div>
    </div>
  );
}

/** Coordinates input: paste coordinates or a map link, or use the device location; previews the map. */
export function GeoInput({ id, value, onChange }: { id: string; value: Geo | null; onChange: (g: Geo | null) => void }) {
  const tr = useTr();
  const [text, setText] = useState(value ? `${value.lat}, ${value.lng}` : '');
  const [msg, setMsg] = useState<string | null>(null);
  const set = (t: string) => {
    setText(t);
    if (!t.trim()) { onChange(null); setMsg(null); return; }
    const g = parseGeo(t);
    onChange(g);
    setMsg(g ? null : tr({ ar: 'لم نتعرف على الإحداثيات. مثال: 24.7136, 46.6753', en: 'Coordinates not recognised. Example: 24.7136, 46.6753' }));
  };
  const locate = () => {
    if (!navigator.geolocation) { setMsg(tr({ ar: 'المتصفح لا يدعم تحديد الموقع', en: 'This browser cannot share its location' })); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => set(`${p.coords.latitude.toFixed(6)}, ${p.coords.longitude.toFixed(6)}`),
      () => setMsg(tr({ ar: 'تعذر الحصول على موقعك؛ تحقق من إذن الموقع', en: 'Could not get your location; check the location permission' })),
      { enableHighAccuracy: true, timeout: 10_000 });
  };
  return (
    <div className="geo-input">
      <div className="row gap">
        <input id={id} dir="ltr" placeholder="24.7136, 46.6753" value={text} onChange={(e) => set(e.target.value)} />
        <button type="button" className="btn btn-secondary" onClick={locate}><LocateFixed className="ico" aria-hidden />{tr({ ar: 'موقعي الحالي', en: 'My location' })}</button>
      </div>
      {msg && <small className="field-error">{msg}</small>}
      {value && <MapEmbed lat={value.lat} lng={value.lng} height={200} />}
    </div>
  );
}
