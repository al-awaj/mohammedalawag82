import { useState } from 'react';
import { Switch, Text, View } from 'react-native';
import { router, Stack } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { formatDateTime, localized } from '@events/shared';
import { api } from '../lib/api';
import { useAction, useGet, useSession } from '../lib/session';
import { useTr } from '../lib/i18n';
import { RequireLogin } from '../components/require-login';
import { Button, Card, Empty, ErrorText, Field, Loading, Money, Notice, P, Screen } from '../components/ui';

type Item = { id: string; serviceTitle: Record<string, string> | null; start: string; currentTotal: string | null; quotedTotal: string; upfrontAmount: string | null; currency: string; state: string; cancellationPolicy: { description: Record<string, string> } | null };

export default function CartScreen() {
  return <RequireLogin><Cart /></RequireLogin>;
}

function Cart() {
  const tr = useTr();
  const { lang } = useSession();
  const qc = useQueryClient();
  const cart = useGet<{ items: Item[]; totals: Record<string, { total: string; upfront: string }> }>('/v1/cart');
  const remove = useAction((id: string) => api.del(`/v1/cart/items/${id}`));
  const [code, setCode] = useState('');
  const [discount, setDiscount] = useState<string | null>(null);
  const [accept, setAccept] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [key] = useState(() => `m-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  if (cart.isLoading) return <Loading />;
  const items = cart.data?.items ?? [];
  const ok = items.filter((i) => i.state === 'ok');
  return (
    <Screen>
      <Stack.Screen options={{ title: tr({ ar: 'السلة', en: 'Cart' }) }} />
      <ErrorText error={cart.error ?? remove.error ?? error} />
      {!items.length ? <Empty>{tr({ ar: 'السلة فارغة', en: 'Your cart is empty' })}</Empty> : <>
        {items.map((i) => (
          <Card key={i.id}>
            <Text style={{ fontWeight: '600' }}>{localized(i.serviceTitle ?? {}, lang)}</Text>
            <P muted>{formatDateTime(i.start, lang)}</P>
            {i.state === 'ok' ? <Text>{tr({ ar: 'الإجمالي', en: 'Total' })}: <Money amount={i.currentTotal} currency={i.currency} /> · {tr({ ar: 'المطلوب الآن', en: 'Due now' })}: <Money amount={i.upfrontAmount} currency={i.currency} /></Text>
              : <Notice kind="warn">{i.state === 'unavailable' ? tr({ ar: 'الموعد لم يعد متاحًا', en: 'No longer available' }) : i.state === 'price_changed' ? tr({ ar: 'تغير السعر', en: 'The price changed' }) : tr({ ar: 'غير قابل للحجز حاليًا', en: 'Not bookable right now' })}</Notice>}
            {i.cancellationPolicy && <P muted small>{localized(i.cancellationPolicy.description, lang)}</P>}
            <Button variant="secondary" title={tr({ ar: 'إزالة', en: 'Remove' })} onPress={() => remove.mutate(i.id)} />
          </Card>
        ))}
        <Card>
          <Field label={tr({ ar: 'رمز الكوبون', en: 'Coupon code' })} value={code} onChangeText={(v) => { setCode(v); setDiscount(null); }} autoCapitalize="characters" />
          <Button variant="secondary" disabled={code.trim().length < 3} title={tr({ ar: 'تطبيق الكوبون', en: 'Apply coupon' })} onPress={async () => {
            setError(null);
            try { setDiscount((await api.post<{ totalDiscount: string }>('/v1/cart/coupon', { code, itemIds: ok.map((i) => i.id) })).totalDiscount); } catch (e) { setError(e); }
          }} />
          {discount && <Notice kind="ok">{tr({ ar: 'الخصم', en: 'Discount' })}: {discount}</Notice>}
          {Object.entries(cart.data?.totals ?? {}).map(([cur, t]) => <Text key={cur}>{tr({ ar: 'الإجمالي', en: 'Total' })}: <Money amount={t.total} currency={cur} /> · {tr({ ar: 'المطلوب الآن', en: 'Due now' })}: <Money amount={t.upfront} currency={cur} /></Text>)}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Switch testID="accept-terms" value={accept} onValueChange={setAccept} accessibilityLabel="accept-terms" />
            <Text style={{ flex: 1 }}>{tr({ ar: 'أوافق على شروط الحجز وسياسات الإلغاء', en: 'I accept the booking terms and cancellation policies' })}</Text>
          </View>
          <Button testID="checkout" disabled={!accept || !ok.length} title={tr({ ar: 'إتمام الطلب', en: 'Place order' })} onPress={async () => {
            setError(null);
            try {
              const o = await api.post<{ id: string }>('/v1/checkout', { acceptTerms: true, itemIds: ok.map((i) => i.id), ...(discount ? { couponCode: code } : {}) }, { 'idempotency-key': key });
              await qc.invalidateQueries();
              router.replace(`/order/${o.id}`);
            } catch (e) { setError(e); }
          }} />
        </Card>
      </>}
    </Screen>
  );
}
