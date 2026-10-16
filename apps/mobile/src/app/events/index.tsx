import { Text } from 'react-native';
import { router, Stack } from 'expo-router';
import { enumLabel, formatDate } from '@events/shared';
import { useGet, useSession } from '../../lib/session';
import { useTr } from '../../lib/i18n';
import { RequireLogin } from '../../components/require-login';
import { Badge, Button, Card, Empty, ErrorText, Loading, Money, P, Screen } from '../../components/ui';

type Ev = { id: string; name: string; eventType: string; city: string; eventDate: string; status: string; budgetAmount: string | null; budgetCurrency: string | null; bookingCount: number };

export default function EventsScreen() {
  return <RequireLogin><List /></RequireLogin>;
}

function List() {
  const tr = useTr();
  const { lang } = useSession();
  const q = useGet<Ev[]>('/v1/events');
  return (
    <Screen>
      <Stack.Screen options={{ title: tr({ ar: 'مناسباتي', en: 'My events' }) }} />
      <P muted>{tr({ ar: 'نظّم خدمات مناسبتك في مكان واحد وتابع الميزانية والمدفوع والمتبقي.', en: 'Organise your occasion in one place and follow budget, payments and balance.' })}</P>
      <Button testID="new-event" title={tr({ ar: 'مناسبة جديدة', en: 'New event' })} onPress={() => router.push('/events/form')} />
      <ErrorText error={q.error} />
      {q.isLoading ? <Loading /> : !q.data?.length ? <Empty>{tr({ ar: 'لا توجد مناسبات بعد', en: 'No events yet' })}</Empty> : q.data.map((e) => (
        <Card key={e.id} testID={`event-${e.id}`} onPress={() => router.push(`/events/${e.id}`)}>
          <Text style={{ fontWeight: '700', fontSize: 16 }}>{e.name}</Text>
          <P muted>{enumLabel('eventType', e.eventType, lang)} · {formatDate(e.eventDate, lang)} · {e.city}</P>
          <Badge group="event" value={e.status} />
          <P small>{tr({ ar: `${e.bookingCount} خدمة`, en: `${e.bookingCount} services` })}{e.budgetAmount ? ' · ' : ''}{e.budgetAmount ? <Money amount={e.budgetAmount} currency={e.budgetCurrency} /> : null}</P>
        </Card>
      ))}
    </Screen>
  );
}
