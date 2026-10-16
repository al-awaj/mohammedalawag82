import { useState } from 'react';
import { Text, View } from 'react-native';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { formatDate, formatDateTime, formatMoney, localized } from '@events/shared';
import { api } from '../../lib/api';
import { useAction, useGet, useSession } from '../../lib/session';
import { useTr } from '../../lib/i18n';
import { RequireLogin } from '../../components/require-login';
import { EventPicker } from '../../components/event-picker';
import { Badge, Button, Card, ErrorText, Field, H2, Loading, Money, Notice, P, Row, Screen } from '../../components/ui';

type Booking = { id: string; number: string; orderId: string; status: string; serviceTitle: Record<string, string>; startAt: string; endAt: string; total: string; paidAmount: string; remainingAmount: string; instalmentPlan: { seq: number; percent: string; amount: string; dueAt: string }[] | null; currency: string; providerName: string | null; cancellationPolicy: { description: Record<string, string> } | null; eventId: string | null };
type Preview = { mode: string; refund: string; retained: string };

export default function BookingScreen() {
  return <RequireLogin><BookingView /></RequireLogin>;
}

function BookingView() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const tr = useTr();
  const { lang } = useSession();
  const b = useGet<Booking>(`/v1/bookings/${id}`);
  const cancellable = !!b.data && ['awaiting_payment', 'confirmed'].includes(b.data.status);
  const preview = useGet<Preview>(cancellable ? `/v1/bookings/${id}/cancellation-preview` : null);
  const refunds = useGet<{ id: string; number: string; amount: string; currency: string; status: string }[]>(`/v1/bookings/${id}/refunds`);
  const [panel, setPanel] = useState<'none' | 'cancel' | 'review' | 'dispute' | 'reschedule'>('none');
  const [newDay, setNewDay] = useState('');
  const reschedules = useGet<{ id: string; newStartAt: string; status: string; deadline: string; decisionReason: string | null }[]>(`/v1/bookings/${id}/reschedule-requests`);
  const [text, setText] = useState('');
  const [rating, setRating] = useState(5);
  const [subject, setSubject] = useState('');
  const act = useAction(async (fn: () => Promise<unknown>) => fn());
  if (b.isLoading) return <Loading />;
  if (!b.data) return <Screen><ErrorText error={b.error} /></Screen>;
  const d = b.data;
  const done = () => { setPanel('none'); setText(''); setSubject(''); };
  return (
    <Screen>
      <Stack.Screen options={{ title: `${tr({ ar: 'حجز', en: 'Booking' })} ${d.number}` }} />
      <Card>
        <Text style={{ fontWeight: '700', fontSize: 17 }}>{localized(d.serviceTitle, lang)}</Text>
        <Badge group="booking" value={d.status} />
        <P muted>{formatDateTime(d.startAt, lang)} → {formatDateTime(d.endAt, lang)}</P>
        {d.providerName && <P muted>{d.providerName}</P>}
        <Text>{tr({ ar: 'الإجمالي', en: 'Total' })}: <Money amount={d.total} currency={d.currency} /></Text>
        <Text>{tr({ ar: 'المدفوع', en: 'Paid' })}: <Money amount={d.paidAmount} currency={d.currency} /></Text>
        <Text>{tr({ ar: 'المتبقي', en: 'Remaining' })}: <Money amount={d.remainingAmount} currency={d.currency} /></Text>
        {d.instalmentPlan?.map((i) => (
          <Text key={i.seq}>{tr({ ar: 'القسط', en: 'Instalment' })} {i.seq}: <Money amount={i.amount} currency={d.currency} /> · {formatDate(i.dueAt, lang)}</Text>
        ))}
      </Card>
      <EventPicker value={d.eventId} path={`/v1/bookings/${d.id}/event`} />
      {!!reschedules.data?.length && (
        <Card testID="reschedule-requests">
          <H2>{tr({ ar: 'طلبات تغيير الموعد', en: 'Date change requests' })}</H2>
          {reschedules.data.map((r) => (
            <View key={r.id} style={{ gap: 2 }}>
              <P>{formatDateTime(r.newStartAt, lang)}</P>
              <Badge group="reschedule" value={r.status} />
              {r.status === 'pending' ? <P small muted>{tr({ ar: 'بانتظار رد صاحب الخدمة حتى', en: 'Awaiting the provider until' })} {formatDateTime(r.deadline, lang)}</P>
                : r.decisionReason ? <P small muted>{r.decisionReason}</P> : null}
              {r.status === 'pending' && <Button variant="secondary" title={tr({ ar: 'سحب الطلب', en: 'Withdraw' })} onPress={() => act.mutate(() => api.post(`/v1/reschedule-requests/${r.id}/withdraw`))} />}
            </View>
          ))}
        </Card>
      )}
      {d.cancellationPolicy && <Card><H2>{tr({ ar: 'سياسة الإلغاء', en: 'Cancellation policy' })}</H2><P>{localized(d.cancellationPolicy.description, lang)}</P></Card>}
      <ErrorText error={act.error} />
      <Row>
        {['awaiting_payment', 'confirmed', 'in_progress'].includes(d.status) && <Button title={tr({ ar: 'الدفع', en: 'Payment' })} onPress={() => router.push(`/order/${d.orderId}`)} />}
        {cancellable && new Date(d.startAt).getTime() > Date.now() && !reschedules.data?.some((r) => r.status === 'pending') && <Button testID="reschedule-booking" variant="secondary" title={tr({ ar: 'تغيير الموعد', en: 'Change date' })} onPress={() => setPanel('reschedule')} />}
        {cancellable && <Button testID="cancel-booking" variant="danger" title={tr({ ar: 'إلغاء الحجز', en: 'Cancel booking' })} onPress={() => setPanel('cancel')} />}
        {d.status === 'completed' && <Button variant="secondary" title={tr({ ar: 'قيّم الخدمة', en: 'Review' })} onPress={() => setPanel('review')} />}
        {!['pending_provider_approval', 'awaiting_payment', 'expired', 'rejected'].includes(d.status) && <Button variant="secondary" title={tr({ ar: 'فتح نزاع', en: 'Open a dispute' })} onPress={() => setPanel('dispute')} />}
      </Row>
      {panel === 'reschedule' && (
        <Card testID="reschedule-panel">
          <Notice>{tr({ ar: 'تبقى المدة والسعر كما هما. يُحجز الموعد الجديد مؤقتًا حتى يرد صاحب الخدمة، ويبقى موعدك الحالي إن رُفض الطلب.', en: 'Duration and price stay the same. The new date is held until the provider answers; your current date stands if declined.' })}</Notice>
          <Field testID="reschedule-day" label={tr({ ar: 'اليوم الجديد (YYYY-MM-DD)', en: 'New day (YYYY-MM-DD)' })} value={newDay} onChangeText={setNewDay} placeholder="2027-05-20" autoCapitalize="none" />
          <Button testID="confirm-reschedule" disabled={!/^\d{4}-\d{2}-\d{2}$/.test(newDay)} title={tr({ ar: 'إرسال الطلب', en: 'Send request' })}
            // Same time of day on the new day, in the booking country's timezone (computed by the server).
            onPress={() => act.mutate(() => api.post(`/v1/bookings/${id}/reschedule`, { date: newDay }), { onSuccess: () => { done(); setNewDay(''); } })} />
        </Card>
      )}
      {panel === 'cancel' && preview.data && (
        <Card testID="cancel-panel">
          <Notice kind="warn">{preview.data.mode === 'immediate'
            ? tr({ ar: `سيُسترد ${formatMoney(preview.data.refund, d.currency)} ويُحتفظ بـ ${formatMoney(preview.data.retained, d.currency)} وفق السياسة.`, en: `${formatMoney(preview.data.refund, d.currency)} refunded, ${formatMoney(preview.data.retained, d.currency)} retained under the policy.` })
            : tr({ ar: 'سيُراجع طلب الإلغاء من الإدارة.', en: 'The cancellation will be reviewed by the administration.' })}</Notice>
          <Field testID="cancel-reason" label={tr({ ar: 'سبب الإلغاء', en: 'Reason' })} value={text} onChangeText={setText} multiline />
          <Button testID="confirm-cancel" variant="danger" disabled={text.trim().length < 3} title={tr({ ar: 'تأكيد الإلغاء', en: 'Confirm cancellation' })}
            onPress={() => act.mutate(() => api.post(`/v1/bookings/${id}/cancel`, { reason: text.trim() }), { onSuccess: done })} />
        </Card>
      )}
      {panel === 'review' && (
        <Card>
          <Row>{[1, 2, 3, 4, 5].map((n) => <Button key={n} variant={rating === n ? 'primary' : 'secondary'} title={'★'.repeat(n)} onPress={() => setRating(n)} />)}</Row>
          <Field label={tr({ ar: 'تعليقك', en: 'Your comment' })} value={text} onChangeText={setText} multiline />
          <Button title={tr({ ar: 'إرسال', en: 'Submit' })} onPress={() => act.mutate(() => api.post(`/v1/bookings/${id}/review`, { rating, ...(text.trim() ? { comment: text.trim() } : {}) }), { onSuccess: done })} />
        </Card>
      )}
      {panel === 'dispute' && (
        <Card>
          <Notice>{tr({ ar: 'يُدار النزاع عبر الإدارة؛ لا توجد محادثة مباشرة مع صاحب الخدمة.', en: 'Disputes are handled by the administration; there is no direct chat with the provider.' })}</Notice>
          <Field label={tr({ ar: 'العنوان', en: 'Subject' })} value={subject} onChangeText={setSubject} />
          <Field label={tr({ ar: 'التفاصيل (10 أحرف على الأقل)', en: 'Details (10+ characters)' })} value={text} onChangeText={setText} multiline />
          <Button title={tr({ ar: 'إرسال', en: 'Submit' })} onPress={() => act.mutate(() => api.post('/v1/disputes', { kind: 'dispute', bookingId: id, type: 'other', subject: subject.trim(), description: text.trim() }), { onSuccess: () => { done(); router.push('/disputes'); } })} />
        </Card>
      )}
      {(refunds.data ?? []).map((r) => (
        <Card key={r.id} testID={`refund-${r.number}`}>
          <Text>{tr({ ar: 'استرداد', en: 'Refund' })} {r.number}: <Money amount={r.amount} currency={r.currency} /></Text>
          <Badge group="refund" value={r.status} />
        </Card>
      ))}
    </Screen>
  );
}
