import { useState } from 'react';
import { Text } from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import * as DocumentPicker from 'expo-document-picker';
import * as WebBrowser from 'expo-web-browser';
import { enumLabel, formatDateTime, localized } from '@events/shared';
import { api, fileForm } from '../../lib/api';
import { useGet, useSession } from '../../lib/session';
import { useTr } from '../../lib/i18n';
import { RequireLogin } from '../../components/require-login';
import { Badge, Button, Card, ErrorText, Field, H2, Loading, Money, Notice, P, Screen } from '../../components/ui';

type Order = { id: string; number: string; bookings: { id: string; number: string; status: string; serviceTitle: Record<string, string>; startAt: string; total: string; paidAmount: string; currency: string; holdExpiresAt: string | null }[] };
type Option = { purpose: string; model: string; method: string; currency: string; bookingIds: string[]; amount: string; minAmount: string | null; nextInstalmentAmount: string | null };
type Payment = { id: string; number: string; method: string; amount: string; currency: string; status: string; checkoutUrl: string | null; instructions: Record<string, string> | null; proofCount: number };

export default function OrderScreen() {
  return <RequireLogin><OrderView /></RequireLogin>;
}

function OrderView() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const tr = useTr();
  const { lang } = useSession();
  const order = useGet<Order>(`/v1/orders/${id}`, undefined, { refetchInterval: 8000 });
  const options = useGet<Option[]>(`/v1/orders/${id}/payment-options`, undefined, { refetchInterval: 8000 });
  const payments = useGet<Payment[]>(`/v1/orders/${id}/payments`, undefined, { refetchInterval: 5000 });
  const [error, setError] = useState<unknown>(null);
  if (order.isLoading) return <Loading />;
  if (!order.data) return <Screen><ErrorText error={order.error} /></Screen>;
  const pay = async (o: Option, amount?: string) => {
    setError(null);
    try {
      const key = `m-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const p = await api.post<Payment>(`/v1/orders/${id}/payments`, { model: o.model, method: o.method, purpose: o.purpose, bookingIds: o.bookingIds, ...(amount && amount !== o.amount ? { amount } : {}) }, { 'idempotency-key': key });
      await payments.refetch(); await options.refetch();
      if (p.checkoutUrl && o.method !== 'bank_transfer') await WebBrowser.openBrowserAsync(p.checkoutUrl);
    } catch (e) { setError(e); }
  };
  const proof = async (p: Payment) => {
    setError(null);
    const r = await DocumentPicker.getDocumentAsync({ type: ['image/*', 'application/pdf'], copyToCacheDirectory: true });
    if (r.canceled || !r.assets[0]) return;
    try { await api.upload(`/v1/payments/${p.id}/proofs`, fileForm(r.assets[0])); await payments.refetch(); } catch (e) { setError(e); }
  };
  return (
    <Screen>
      <Stack.Screen options={{ title: `${tr({ ar: 'الطلب', en: 'Order' })} ${order.data.number}` }} />
      <ErrorText error={error ?? options.error ?? payments.error} />
      {order.data.bookings.map((b) => (
        <Card key={b.id} onPress={() => router.push(`/booking/${b.id}`)}>
          <Text style={{ fontWeight: '600' }}>{localized(b.serviceTitle, lang)}</Text>
          <Badge group="booking" value={b.status} />
          <P muted>{formatDateTime(b.startAt, lang)}</P>
          <Text><Money amount={b.paidAmount} currency={b.currency} /> / <Money amount={b.total} currency={b.currency} /></Text>
          {b.status === 'awaiting_payment' && b.holdExpiresAt && <Notice kind="warn">{tr({ ar: 'ادفع قبل', en: 'Pay before' })} {formatDateTime(b.holdExpiresAt, lang)}</Notice>}
        </Card>
      ))}
      <H2>{tr({ ar: 'الدفع', en: 'Payment' })}</H2>
      {!options.data?.length ? <P muted>{tr({ ar: 'لا يوجد مبلغ مستحق الآن.', en: 'Nothing is due right now.' })}</P> : options.data.map((o, i) => (
        <Card key={i}>
          <Text>{o.purpose === 'upfront' ? tr({ ar: 'العربون / المقدم', en: 'Deposit / upfront' }) : tr({ ar: 'المتبقي', en: 'Balance' })}: <Money amount={o.amount} currency={o.currency} /></Text>
          <P muted>{enumLabel('paymentMethod', o.method, lang)}</P>
          {o.purpose === 'balance' && (o.nextInstalmentAmount || (o.minAmount && o.minAmount !== o.amount))
            ? <PartialPay o={o} onPay={(a) => void pay(o, a)} />
            : <Button testID={`pay-${o.method}`} title={tr({ ar: 'ادفع بهذه الطريقة', en: 'Pay this way' })} onPress={() => void pay(o)} />}
        </Card>
      ))}
      {(payments.data ?? []).map((p) => (
        <Card key={p.id} testID={`payment-${p.number}`}>
          <Text>{p.number} · {enumLabel('paymentMethod', p.method, lang)} · <Money amount={p.amount} currency={p.currency} /></Text>
          <Badge group="payment" value={p.status} />
          {p.instructions && ['pending', 'awaiting_verification'].includes(p.status) && <Notice kind="warn">{localized(p.instructions, lang)}</Notice>}
          {p.status === 'pending' && p.checkoutUrl && p.method !== 'bank_transfer' && <Button variant="secondary" title={tr({ ar: 'إكمال الدفع', en: 'Complete payment' })} onPress={() => void WebBrowser.openBrowserAsync(p.checkoutUrl!)} />}
          {p.status === 'awaiting_verification' && <Button variant="secondary" title={tr({ ar: 'رفع إثبات التحويل', en: 'Upload transfer proof' })} onPress={() => void proof(p)} />}
        </Card>
      ))}
      <P muted small>{tr({ ar: 'تُعتبر الدفعة مكتملة فقط بعد تأكيدها من مزود الدفع أو فريق المالية.', en: 'A payment counts only once confirmed by the payment provider or the finance team.' })}</P>
    </Screen>
  );
}

/** Next instalment, full balance, or any amount from the admin's minimum (clauses 46-47). */
function PartialPay({ o, onPay }: { o: Option; onPay: (amount: string) => void }) {
  const tr = useTr();
  const [amount, setAmount] = useState(o.nextInstalmentAmount ?? o.amount);
  const flexible = !!o.minAmount && o.minAmount !== o.amount;
  return (
    <>
      {o.nextInstalmentAmount && <Button variant={amount === o.nextInstalmentAmount ? 'primary' : 'secondary'} title={`${tr({ ar: 'القسط التالي', en: 'Next instalment' })}: ${o.nextInstalmentAmount}`} onPress={() => setAmount(o.nextInstalmentAmount!)} />}
      <Button variant={amount === o.amount ? 'primary' : 'secondary'} title={`${tr({ ar: 'كامل المتبقي', en: 'Full balance' })}: ${o.amount}`} onPress={() => setAmount(o.amount)} />
      {flexible && <Field label={`${tr({ ar: 'أو أدخل مبلغًا (الحد الأدنى', en: 'Or enter an amount (minimum' })} ${o.minAmount})`} keyboardType="decimal-pad" value={amount} onChangeText={(t) => setAmount(t.trim())} />}
      <Button testID={`pay-${o.method}`} title={`${tr({ ar: 'ادفع', en: 'Pay' })} ${amount} ${o.currency}`} onPress={() => onPay(amount)} />
    </>
  );
}
