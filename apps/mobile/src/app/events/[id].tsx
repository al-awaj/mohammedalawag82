import { Text, View } from 'react-native';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { enumLabel, formatDate, formatDateTime, localized } from '@events/shared';
import { api } from '../../lib/api';
import { useAction, useGet, useSession } from '../../lib/session';
import { useTr } from '../../lib/i18n';
import { RequireLogin } from '../../components/require-login';
import { Badge, Button, Card, colors, Empty, ErrorText, H2, Loading, Money, Notice, P, Row, Screen } from '../../components/ui';

interface EventDetail {
  id: string; name: string; eventType: string; city: string; location: string | null; eventDate: string; startsAt: string | null; endsAt: string | null;
  expectedGuests: number | null; notes: string | null; status: string;
  bookings: { id: string; number: string; status: string; serviceTitle: Record<string, string>; startAt: string; total: string; paidAmount: string; remainingAmount: string; currency: string }[];
  totals: Record<string, { committedTotal: string; upfrontTotal: string; paidTotal: string; remainingTotal: string; bookings: number }>;
  budget: { amount: string; currency: string; committed: string; remaining: string; overBudget: boolean; otherCurrencies: string[] } | null;
}
type MyBooking = { id: string; number: string; status: string; serviceTitle: Record<string, string>; startAt: string; eventId: string | null };
const ENDED = ['expired', 'rejected', 'cancelled_by_customer', 'cancelled_by_provider', 'cancelled_by_admin'];

export default function EventScreen() {
  return <RequireLogin><EventView /></RequireLogin>;
}

function EventView() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const tr = useTr();
  const { lang } = useSession();
  const q = useGet<EventDetail>(`/v1/events/${id}`);
  const mine = useGet<MyBooking[]>('/v1/bookings', { when: 'all', limit: 200 });
  const link = useAction(({ bookingId, eventId }: { bookingId: string; eventId: string | null }) => api.put(`/v1/bookings/${bookingId}/event`, { eventId }));
  if (q.isLoading) return <Loading />;
  const e = q.data;
  if (!e) return <Screen><ErrorText error={q.error} /></Screen>;
  const linkable = (mine.data ?? []).filter((b) => !b.eventId && !ENDED.includes(b.status));
  const pct = e.budget ? Math.min(100, Math.round((Number(e.budget.committed) / Math.max(Number(e.budget.amount), 0.0001)) * 100)) : 0;
  return (
    <Screen>
      <Stack.Screen options={{ title: e.name }} />
      <Card>
        <Text style={{ fontWeight: '700', fontSize: 18 }}>{e.name}</Text>
        <Badge group="event" value={e.status} />
        <P muted>{enumLabel('eventType', e.eventType, lang)} · {formatDate(e.eventDate, lang)}{e.startsAt ? ` · ${formatDateTime(e.startsAt, lang)}` : ''}</P>
        <P muted>{[e.city, e.location].filter(Boolean).join(' · ')}{e.expectedGuests ? ` · ${e.expectedGuests} ${tr({ ar: 'ضيف', en: 'guests' })}` : ''}</P>
        {e.notes ? <P>{e.notes}</P> : null}
        <Button variant="secondary" testID="edit-event" title={tr({ ar: 'تعديل المناسبة', en: 'Edit event' })} onPress={() => router.push(`/events/form?id=${e.id}`)} />
      </Card>

      <Card testID="event-budget-card">
        <H2>{tr({ ar: 'الميزانية', en: 'Budget' })}</H2>
        {!e.budget ? <P muted>{tr({ ar: 'لم تُحدَّد ميزانية.', en: 'No budget set.' })}</P> : <>
          <Text>{tr({ ar: 'الميزانية', en: 'Budget' })}: <Money amount={e.budget.amount} currency={e.budget.currency} /></Text>
          <Text>{tr({ ar: 'المحجوز', en: 'Committed' })}: <Money amount={e.budget.committed} currency={e.budget.currency} /></Text>
          <Text>{tr({ ar: 'المتبقي من الميزانية', en: 'Left in budget' })}: <Money amount={e.budget.remaining} currency={e.budget.currency} /></Text>
          <View accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: pct }} style={{ height: 10, borderRadius: 999, backgroundColor: colors.border, overflow: 'hidden' }}>
            <View style={{ width: `${pct}%`, height: '100%', backgroundColor: e.budget.overBudget ? colors.bad : colors.primary }} />
          </View>
          {e.budget.overBudget && <Notice kind="warn">{tr({ ar: 'تجاوزت الحجوزات الميزانية.', en: 'Bookings have gone over the budget.' })}</Notice>}
          {e.budget.otherCurrencies.length > 0 && <P muted small>{tr({ ar: 'حجوزات بعملات أخرى لا تدخل في المقارنة:', en: 'Bookings in other currencies are not compared:' })} {e.budget.otherCurrencies.join(', ')}</P>}
        </>}
        {Object.entries(e.totals).map(([cur, t]) => (
          <P key={cur} small>{cur}: {tr({ ar: 'الإجمالي', en: 'total' })} <Money amount={t.committedTotal} currency={cur} /> · {tr({ ar: 'المدفوع', en: 'paid' })} <Money amount={t.paidTotal} currency={cur} /> · {tr({ ar: 'المتبقي', en: 'remaining' })} <Money amount={t.remainingTotal} currency={cur} /></P>
        ))}
      </Card>

      <H2>{tr({ ar: 'خدمات المناسبة', en: 'Services for this event' })}</H2>
      <ErrorText error={link.error} />
      {!e.bookings.length ? <Empty>{tr({ ar: 'لا توجد خدمات مرتبطة بعد.', en: 'No services linked yet.' })}</Empty> : e.bookings.map((b) => (
        <Card key={b.id} testID={`event-booking-${b.number}`}>
          <Text style={{ fontWeight: '600' }} onPress={() => router.push(`/booking/${b.id}`)}>{localized(b.serviceTitle, lang)} · {b.number}</Text>
          <Badge group="booking" value={b.status} />
          <P muted small>{formatDateTime(b.startAt, lang)}</P>
          <Text><Money amount={b.total} currency={b.currency} /> · {tr({ ar: 'المتبقي', en: 'Remaining' })} <Money amount={b.remainingAmount} currency={b.currency} /></Text>
          <Button variant="secondary" title={tr({ ar: 'إزالة من المناسبة', en: 'Remove from event' })} disabled={link.isPending} onPress={() => link.mutate({ bookingId: b.id, eventId: null })} />
        </Card>
      ))}

      {e.status !== 'cancelled' && linkable.length > 0 && (
        <Card>
          <H2>{tr({ ar: 'إضافة حجز موجود', en: 'Add an existing booking' })}</H2>
          <Row>{linkable.map((b) => (
            <Button key={b.id} testID={`link-${b.number}`} variant="secondary" title={`${b.number} · ${localized(b.serviceTitle, lang)}`} disabled={link.isPending}
              onPress={() => link.mutate({ bookingId: b.id, eventId: e.id })} />
          ))}</Row>
        </Card>
      )}
      <Button variant="secondary" title={tr({ ar: 'أضف خدمة جديدة', en: 'Find a service' })} onPress={() => router.push('/search')} />
    </Screen>
  );
}
