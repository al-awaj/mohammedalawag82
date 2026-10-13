import { useEffect, useMemo, useState } from 'react';
import { Image, Pressable, Text, View } from 'react-native';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { formatDate, formatMoney, formatTime, localized } from '@events/shared';
import { api, API_URL } from '../../lib/api';
import { useGet, useSession } from '../../lib/session';
import { useTr } from '../../lib/i18n';
import { Button, Card, colors, ErrorText, H1, H2, Loading, Notice, P, Row, Screen } from '../../components/ui';

interface Service {
  id: string; title: Record<string, string>; description: Record<string, string>; city: string; basePrice: string; currency: string; requiresProviderApproval: boolean;
  typeName: Record<string, string>; bookingMode: string; capacityMode: string; providerName: string | null;
  cancellationPolicy: { description: Record<string, string>; depositRefundable: boolean } | null;
  packages: { id: string; name: Record<string, string>; price: string; currency: string; addOns: { code: string; name: Record<string, string>; price: string }[] }[];
  media: { id: string; kind: string; url: string }[]; rating: { average: string | null; count: number };
}
type Day = { date: string; available: boolean; slots?: { start: string; available: boolean }[] };
type Quote = { total: string; upfrontAmount: string; balanceDueAt: string | null; currency: string };
const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: string, n: number) => iso(new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000));

export default function ServiceScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const tr = useTr();
  const { lang, user } = useSession();
  const s = useGet<Service>(`/v1/services/${id}`);
  const [from, setFrom] = useState(addDays(iso(new Date()), 1));
  const avail = useGet<{ days: Day[]; timezone: string }>(`/v1/services/${id}/availability`, { from, to: addDays(from, 27) });
  const [day, setDay] = useState<string | null>(null);
  const [slot, setSlot] = useState<string | null>(null);
  const [packageId, setPackageId] = useState<string | null>(null);
  const [guests, setGuests] = useState<number | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [error, setError] = useState<unknown>(null);
  const svc = s.data;
  const item = useMemo(() => {
    if (!svc || !day) return null;
    const base = { serviceId: svc.id, packageId, guests, addOns: [] as string[] };
    if (svc.bookingMode === 'time_slot') return slot ? { ...base, startAt: slot } : null;
    if (svc.bookingMode === 'date_range' || svc.bookingMode === 'quantity_rental') return { ...base, startDate: day, endDate: day };
    return { ...base, date: day };
  }, [svc, day, slot, packageId, guests]);
  useEffect(() => {
    setQuote(null); setError(null);
    if (!item) return;
    api.post<Quote>('/v1/quote', item).then(setQuote).catch(setError);
  }, [item]);
  if (s.isLoading) return <Loading />;
  if (!svc) return <Screen><ErrorText error={s.error} /></Screen>;
  const days = avail.data?.days ?? [];
  const selected = days.find((d) => d.date === day);
  const image = svc.media.find((m) => m.kind === 'image');
  return (
    <Screen>
      <Stack.Screen options={{ title: localized(svc.title, lang) }} />
      {image && <Image source={{ uri: `${API_URL}${image.url}` }} style={{ width: '100%', aspectRatio: 16 / 9, borderRadius: 12 }} />}
      <H1>{localized(svc.title, lang)}</H1>
      <P muted>{localized(svc.typeName, lang)} · {svc.city}{svc.providerName ? ` · ${svc.providerName}` : ''}{svc.rating.average ? ` · ★ ${svc.rating.average}` : ''}</P>
      <P>{localized(svc.description, lang)}</P>
      <Card>
        <H2>{tr({ ar: 'سياسة الإلغاء', en: 'Cancellation policy' })}</H2>
        <P>{svc.cancellationPolicy ? localized(svc.cancellationPolicy.description, lang) : tr({ ar: 'يُراجع أي إلغاء من الإدارة.', en: 'Any cancellation is reviewed by the administration.' })}</P>
      </Card>
      {svc.packages.length > 0 && (
        <Card>
          <H2>{tr({ ar: 'الباقة', en: 'Package' })}</H2>
          <Row>
            <Button variant={packageId === null ? 'primary' : 'secondary'} title={`${tr({ ar: 'الأساسية', en: 'Base' })} ${formatMoney(svc.basePrice, svc.currency)}`} onPress={() => setPackageId(null)} />
            {svc.packages.map((p) => <Button key={p.id} variant={packageId === p.id ? 'primary' : 'secondary'} title={`${localized(p.name, lang)} ${formatMoney(p.price, p.currency)}`} onPress={() => setPackageId(p.id)} />)}
          </Row>
        </Card>
      )}
      {svc.capacityMode === 'guests' && (
        <Row>
          <Text>{tr({ ar: 'عدد الضيوف', en: 'Guests' })}: {guests ?? '—'}</Text>
          {[50, 100, 200, 300].map((g) => <Button key={g} variant={guests === g ? 'primary' : 'secondary'} title={String(g)} onPress={() => setGuests(g)} />)}
        </Row>
      )}
      <Card>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <Button variant="secondary" title="‹" onPress={() => setFrom(addDays(from, -28))} disabled={from <= iso(new Date())} />
          <Text>{formatDate(from, lang)} — {formatDate(addDays(from, 27), lang)}</Text>
          <Button variant="secondary" testID="next-days" title="›" onPress={() => setFrom(addDays(from, 28))} />
        </View>
        <ErrorText error={avail.error} />
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          {days.map((d) => (
            <Pressable key={d.date} testID={`day-${d.date}`} disabled={!d.available} onPress={() => { setDay(d.date); setSlot(null); }}
              accessibilityState={{ disabled: !d.available, selected: d.date === day }}
              style={{ width: 40, paddingVertical: 8, borderRadius: 8, alignItems: 'center', borderWidth: 1, borderColor: colors.border, opacity: d.available ? 1 : 0.3, backgroundColor: d.date === day ? colors.primary : colors.surface }}>
              <Text style={{ color: d.date === day ? '#fff' : colors.text }}>{Number(d.date.slice(8))}</Text>
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
          <Button testID="add-to-cart" title={tr({ ar: 'أضف إلى السلة', en: 'Add to cart' })} onPress={async () => {
            if (!user) { router.push('/login'); return; }
            try { await api.post('/v1/cart/items', item); router.push('/cart'); } catch (e) { setError(e); }
          }} />
        </Card>
      )}
    </Screen>
  );
}
