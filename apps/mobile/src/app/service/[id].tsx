import { useEffect, useMemo, useState } from 'react';
import { Image, Pressable, ScrollView, Text, View } from 'react-native';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { formatDate, formatMoney, formatTime, localized } from '@events/shared';
import { api, API_URL } from '../../lib/api';
import { useGet, useSession } from '../../lib/session';
import { useTr } from '../../lib/i18n';
import { Button, Card, Choice, colors, ErrorText, Field, H1, H2, Loading, Notice, P, Row, Screen } from '../../components/ui';

interface Service {
  id: string; title: Record<string, string>; description: Record<string, string>; city: string; basePrice: string; currency: string; requiresProviderApproval: boolean;
  typeName: Record<string, string>; bookingMode: string; capacityMode: string; capacity: number | null; providerName: string | null; providerId: string | null; durationMinutes: number | null;
  cancellationPolicy: { description: Record<string, string>; depositRefundable: boolean } | null;
  packages: { id: string; name: Record<string, string>; description: Record<string, string> | null; price: string; currency: string; inclusions: Record<string, string>[] | null; addOns: { code: string; name: Record<string, string>; price: string }[]; durationMinutes: number | null; terms: Record<string, string> | null }[];
  rentalItems: { id: string; sku: string; name: Record<string, string>; quantityTotal: number; pricePerDay: string | null; currency: string; securityDeposit: string | null; lateFeePerDay: string | null; damageTerms: Record<string, string> | null }[];
  media: { id: string; kind: string; url: string; caption: Record<string, string> | null; isPastWork: boolean; packageId: string | null }[];
  rating: { average: string | null; count: number };
  attributes: Record<string, unknown>; fields: { key: string; label: Record<string, string>; dataType: string; options: { value: string; label: Record<string, string> }[] | null }[];
}
type Day = { date: string; available: boolean; slots?: { start: string; available: boolean }[] };
type Quote = { total: string; upfrontAmount: string; balanceDueAt: string | null; currency: string };
type Reviews = { count: number; average: string | null; items: { id: string; rating: number; comment: string | null; reviewer: string; createdAt: string }[] };
const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: string, n: number) => iso(new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000));
const RANGE_MODES = ['date_range', 'quantity_rental'];

export default function ServiceScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const tr = useTr();
  const { lang, user } = useSession();
  const s = useGet<Service>(`/v1/services/${id}`);
  const reviews = useGet<Reviews>(`/v1/services/${id}/reviews`, { limit: 5 });
  const events = useGet<{ id: string; name: string; status: string }[]>(user ? '/v1/events' : null);
  const [from, setFrom] = useState(addDays(iso(new Date()), 1));
  const avail = useGet<{ days: Day[]; timezone: string }>(`/v1/services/${id}/availability`, { from, to: addDays(from, 27) });
  const [day, setDay] = useState<string | null>(null);
  const [endDay, setEndDay] = useState<string | null>(null);
  const [slot, setSlot] = useState<string | null>(null);
  const [packageId, setPackageId] = useState<string | null>(null);
  const [addOns, setAddOns] = useState<string[]>([]);
  const [guests, setGuests] = useState('');
  const [rentalItemId, setRentalItemId] = useState<string | null>(null);
  const [units, setUnits] = useState('1');
  const [eventId, setEventId] = useState<string | null>(null);
  const [photo, setPhoto] = useState(0);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [error, setError] = useState<unknown>(null);
  const svc = s.data;
  const pkg = svc?.packages.find((p) => p.id === packageId) ?? null;
  const ranged = !!svc && RANGE_MODES.includes(svc.bookingMode);
  const item = useMemo(() => {
    if (!svc || !day) return null;
    const g = Number(guests);
    const base = {
      serviceId: svc.id, packageId, addOns: pkg ? addOns : [], guests: svc.capacityMode === 'guests' && g > 0 ? g : null,
      ...(svc.bookingMode === 'quantity_rental' ? { rentalItemId, units: Math.max(1, Number(units) || 1) } : {}),
    };
    if (svc.bookingMode === 'time_slot') return slot ? { ...base, startAt: slot } : null;
    if (ranged) return { ...base, startDate: day, endDate: endDay ?? day };
    return { ...base, date: day };
  }, [svc, day, endDay, slot, packageId, pkg, addOns, guests, rentalItemId, units, ranged]);
  useEffect(() => {
    setQuote(null); setError(null);
    if (!item) return;
    const t = setTimeout(() => { api.post<Quote>('/v1/quote', item).then(setQuote).catch(setError); }, 250);
    return () => clearTimeout(t);
  }, [item]);
  if (s.isLoading) return <Loading />;
  if (!svc) return <Screen><ErrorText error={s.error} /></Screen>;
  const days = avail.data?.days ?? [];
  const selected = days.find((d) => d.date === day);
  // The selected package's own images come first; other packages' images stay with their package.
  const images = svc.media.filter((m) => m.kind === 'image' && (!m.packageId || m.packageId === packageId))
    .sort((a, b) => Number(b.packageId === packageId && !!packageId) - Number(a.packageId === packageId && !!packageId));
  const videos = svc.media.filter((m) => m.kind === 'video');
  const facts = svc.fields.filter((f) => svc.attributes[f.key] !== undefined && svc.attributes[f.key] !== null && svc.attributes[f.key] !== '');
  const fmtAttr = (f: Service['fields'][number]) => {
    const v = svc.attributes[f.key];
    const opt = (x: unknown) => localized(f.options?.find((o) => o.value === x)?.label ?? { ar: String(x), en: String(x) }, lang);
    if (Array.isArray(v)) return v.map(opt).join('، ');
    if (typeof v === 'boolean') return v ? tr({ ar: 'نعم', en: 'Yes' }) : tr({ ar: 'لا', en: 'No' });
    return f.options ? opt(v) : String(v);
  };
  const pickDay = (d: string) => {
    setSlot(null);
    if (ranged && day && !endDay && d > day) { setEndDay(d); return; }
    setDay(d); setEndDay(null);
  };
  const inRange = (d: string) => !!day && (d === day || (!!endDay && d > day && d <= endDay));
  return (
    <Screen>
      <Stack.Screen options={{ title: localized(svc.title, lang) }} />
      {images.length > 0 && <>
        <Image testID="gallery-main" source={{ uri: `${API_URL}${images[Math.min(photo, images.length - 1)]!.url}` }} style={{ width: '100%', aspectRatio: 16 / 9, borderRadius: 12 }} />
        {images.length > 1 && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
            {images.map((m, i) => (
              <Pressable key={m.id} testID={`thumb-${i}`} onPress={() => setPhoto(i)} accessibilityLabel={`photo ${i + 1}`}>
                <Image source={{ uri: `${API_URL}${m.url}` }} style={{ width: 72, height: 48, borderRadius: 6, borderWidth: 2, borderColor: i === photo ? colors.primary : 'transparent' }} />
              </Pressable>
            ))}
          </ScrollView>
        )}
      </>}
      <H1>{localized(svc.title, lang)}</H1>
      <P muted>{localized(svc.typeName, lang)} · {svc.city}{svc.providerName ? ` · ${svc.providerName}` : ''}{svc.rating.average ? ` · ★ ${svc.rating.average} (${svc.rating.count})` : ''}</P>
      {svc.providerId && svc.providerName ? <Button variant="secondary" testID="open-provider" title={tr({ ar: `صفحة ${svc.providerName}`, en: `About ${svc.providerName}` })} onPress={() => router.push(`/provider/${svc.providerId}`)} /> : null}
      <P>{localized(svc.description, lang)}</P>
      {videos.length > 0 && <Row>{videos.map((v, i) => (
        <Button key={v.id} variant="secondary" title={`▶ ${tr({ ar: 'فيديو', en: 'Video' })} ${i + 1}`} onPress={() => void WebBrowser.openBrowserAsync(`${API_URL}${v.url}`)} />
      ))}</Row>}
      {(facts.length > 0 || svc.capacity || svc.durationMinutes) && (
        <Card>
          <H2>{tr({ ar: 'التفاصيل', en: 'Details' })}</H2>
          {svc.capacity ? <P>{tr({ ar: 'السعة', en: 'Capacity' })}: {svc.capacity}</P> : null}
          {svc.durationMinutes ? <P>{tr({ ar: 'المدة', en: 'Duration' })}: {svc.durationMinutes} {tr({ ar: 'دقيقة', en: 'min' })}</P> : null}
          {facts.map((f) => <P key={f.key}>{localized(f.label, lang)}: {fmtAttr(f)}</P>)}
        </Card>
      )}
      <Card>
        <H2>{tr({ ar: 'سياسة الإلغاء', en: 'Cancellation policy' })}</H2>
        <P>{svc.cancellationPolicy ? localized(svc.cancellationPolicy.description, lang) : tr({ ar: 'يُراجع أي إلغاء من الإدارة.', en: 'Any cancellation is reviewed by the administration.' })}</P>
      </Card>
      {svc.packages.length > 0 && (
        <Card>
          <H2>{tr({ ar: 'الباقة', en: 'Package' })}</H2>
          <Row>
            <Button variant={packageId === null ? 'primary' : 'secondary'} title={`${tr({ ar: 'الأساسية', en: 'Base' })} ${formatMoney(svc.basePrice, svc.currency)}`} onPress={() => { setPackageId(null); setAddOns([]); }} />
            {svc.packages.map((p) => <Button key={p.id} variant={packageId === p.id ? 'primary' : 'secondary'} title={`${localized(p.name, lang)} ${formatMoney(p.price, p.currency)}`} onPress={() => { setPackageId(p.id); setAddOns([]); }} />)}
          </Row>
          {pkg?.description ? <P muted>{localized(pkg.description, lang)}</P> : null}
          {pkg?.durationMinutes ? <P small>{tr({ ar: `المدة: ${pkg.durationMinutes} دقيقة`, en: `Duration: ${pkg.durationMinutes} minutes` })}</P> : null}
          {pkg?.terms ? <P small muted>{tr({ ar: 'شروط الباقة: ', en: 'Package terms: ' })}{localized(pkg.terms, lang)}</P> : null}
          {pkg?.inclusions?.length ? <P small>{tr({ ar: 'تشمل:', en: 'Includes:' })} {pkg.inclusions.map((x) => localized(x, lang)).join('، ')}</P> : null}
          {pkg && pkg.addOns.length > 0 && <>
            <P muted small>{tr({ ar: 'إضافات اختيارية', en: 'Optional add-ons' })}</P>
            <Row>{pkg.addOns.map((a) => {
              const on = addOns.includes(a.code);
              return <Button key={a.code} testID={`addon-${a.code}`} variant={on ? 'primary' : 'secondary'} title={`${on ? '✓ ' : '+ '}${localized(a.name, lang)} ${formatMoney(a.price, pkg.currency)}`}
                onPress={() => setAddOns((x) => (on ? x.filter((c) => c !== a.code) : [...x, a.code]))} />;
            })}</Row>
          </>}
        </Card>
      )}
      {svc.bookingMode === 'quantity_rental' && svc.rentalItems.length > 0 && (
        <Card>
          <H2>{tr({ ar: 'القطعة والكمية', en: 'Item and quantity' })}</H2>
          <Choice value={rentalItemId} onChange={setRentalItemId}
            options={svc.rentalItems.map((r) => ({ value: r.id, label: `${localized(r.name, lang)}${r.pricePerDay ? ` · ${formatMoney(r.pricePerDay, r.currency)}/${tr({ ar: 'يوم', en: 'day' })}` : ''}` }))} />
          {(() => {
            const r = svc.rentalItems.find((x) => x.id === rentalItemId);
            return r ? <>
              {r.securityDeposit ? <P small>{tr({ ar: 'تأمين مسترد', en: 'Refundable deposit' })}: {formatMoney(r.securityDeposit, r.currency)}</P> : null}
              {r.lateFeePerDay ? <P small>{tr({ ar: 'غرامة التأخير لكل يوم', en: 'Late fee per day' })}: {formatMoney(r.lateFeePerDay, r.currency)}</P> : null}
              {r.damageTerms ? <P small>{tr({ ar: 'شروط التلف', en: 'Damage terms' })}: {localized(r.damageTerms, lang)}</P> : null}
            </> : null;
          })()}
          <Field label={tr({ ar: 'الكمية', en: 'Quantity' })} value={units} onChangeText={setUnits} keyboardType="number-pad" />
        </Card>
      )}
      {svc.capacityMode === 'guests' && (
        <Field testID="guests" label={`${tr({ ar: 'عدد الضيوف', en: 'Guests' })}${svc.capacity ? ` (${tr({ ar: 'حتى', en: 'up to' })} ${svc.capacity})` : ''}`} value={guests} onChangeText={setGuests} keyboardType="number-pad" />
      )}
      <Card>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <Button variant="secondary" title="‹" onPress={() => setFrom(addDays(from, -28))} disabled={from <= iso(new Date())} />
          <Text>{formatDate(from, lang)} — {formatDate(addDays(from, 27), lang)}</Text>
          <Button variant="secondary" testID="next-days" title="›" onPress={() => setFrom(addDays(from, 28))} />
        </View>
        {ranged && <P muted small>{day && !endDay ? tr({ ar: 'اختر يوم النهاية، أو أكمل ليوم واحد.', en: 'Pick the last day, or continue for one day.' }) : tr({ ar: 'اختر يوم البداية ثم يوم النهاية.', en: 'Pick the first day, then the last day.' })}</P>}
        <ErrorText error={avail.error} />
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          {days.map((d) => (
            <Pressable key={d.date} testID={`day-${d.date}`} disabled={!d.available} onPress={() => pickDay(d.date)}
              accessibilityState={{ disabled: !d.available, selected: inRange(d.date) }}
              style={{ width: 40, paddingVertical: 8, borderRadius: 8, alignItems: 'center', borderWidth: 1, borderColor: colors.border, opacity: d.available ? 1 : 0.3, backgroundColor: inRange(d.date) ? colors.primary : colors.surface }}>
              <Text style={{ color: inRange(d.date) ? '#fff' : colors.text }}>{Number(d.date.slice(8))}</Text>
            </Pressable>
          ))}
        </View>
        {svc.bookingMode === 'time_slot' && selected?.slots && (
          <Row>{selected.slots.map((x) => <Button key={x.start} disabled={!x.available} variant={slot === x.start ? 'primary' : 'secondary'} title={formatTime(x.start, lang, avail.data?.timezone)} onPress={() => setSlot(x.start)} />)}</Row>
        )}
      </Card>
      <ErrorText error={error} />
      {quote && (
        <Card testID="quote">
          <Text>{tr({ ar: 'الإجمالي', en: 'Total' })}: <Text style={{ fontWeight: '700' }}>{formatMoney(quote.total, quote.currency)}</Text></Text>
          <Text>{tr({ ar: 'المطلوب عند الحجز', en: 'Due when booking' })}: {formatMoney(quote.upfrontAmount, quote.currency)}</Text>
          {quote.balanceDueAt && quote.total !== quote.upfrontAmount && <Text>{tr({ ar: 'المتبقي يُستحق في', en: 'Balance due on' })} {formatDate(quote.balanceDueAt, lang)}</Text>}
          {svc.requiresProviderApproval && <Notice kind="warn">{tr({ ar: 'يتطلب تأكيد صاحب الخدمة قبل الدفع.', en: 'Needs the provider’s confirmation before payment.' })}</Notice>}
          {(events.data ?? []).filter((e) => e.status !== 'cancelled').length > 0 && (
            <Choice label={tr({ ar: 'ضمن المناسبة (اختياري)', en: 'Part of event (optional)' })} value={eventId} onChange={setEventId}
              options={(events.data ?? []).filter((e) => e.status !== 'cancelled').map((e) => ({ value: e.id, label: e.name }))} />
          )}
          <Button testID="add-to-cart" title={tr({ ar: 'أضف إلى السلة', en: 'Add to cart' })} onPress={async () => {
            if (!user) { router.push('/login'); return; }
            try { await api.post('/v1/cart/items', { ...item, ...(eventId ? { eventId } : {}) }); router.push('/cart'); } catch (e) { setError(e); }
          }} />
        </Card>
      )}
      {(reviews.data?.items.length ?? 0) > 0 && (
        <Card>
          <H2>{tr({ ar: 'التقييمات', en: 'Reviews' })} {reviews.data?.average ? `★ ${reviews.data.average} (${reviews.data.count})` : ''}</H2>
          {reviews.data!.items.map((r) => (
            <View key={r.id} style={{ gap: 2 }}>
              <Text style={{ fontWeight: '600' }}>{'★'.repeat(r.rating)}{'☆'.repeat(5 - r.rating)} · {r.reviewer}</Text>
              {r.comment ? <P small>{r.comment}</P> : null}
            </View>
          ))}
        </Card>
      )}
    </Screen>
  );
}
