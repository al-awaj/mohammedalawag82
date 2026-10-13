import { useState } from 'react';
import { Text, View } from 'react-native';
import { router } from 'expo-router';
import { formatDateTime, localized } from '@events/shared';
import { useGet, useSession } from '../../lib/session';
import { useTr } from '../../lib/i18n';
import { RequireLogin } from '../../components/require-login';
import { Badge, Button, Card, colors, Empty, ErrorText, Loading, Money, Row, Screen } from '../../components/ui';

type Booking = { id: string; number: string; status: string; serviceTitle: Record<string, string>; startAt: string; total: string; remainingAmount: string; currency: string };

export default function Bookings() {
  return <RequireLogin><List /></RequireLogin>;
}

function List() {
  const tr = useTr();
  const { lang } = useSession();
  const [when, setWhen] = useState<'upcoming' | 'past'>('upcoming');
  const q = useGet<Booking[]>('/v1/bookings', { when, limit: 50 });
  return (
    <Screen>
      <Row>
        <Button variant={when === 'upcoming' ? 'primary' : 'secondary'} title={tr({ ar: 'القادمة', en: 'Upcoming' })} onPress={() => setWhen('upcoming')} />
        <Button variant={when === 'past' ? 'primary' : 'secondary'} title={tr({ ar: 'السابقة', en: 'Past' })} onPress={() => setWhen('past')} />
        <Button variant="secondary" title={tr({ ar: 'السلة', en: 'Cart' })} onPress={() => router.push('/cart')} />
      </Row>
      <ErrorText error={q.error} />
      {q.isLoading ? <Loading /> : !q.data?.length ? <Empty>{tr({ ar: 'لا توجد حجوزات', en: 'No bookings' })}</Empty> : q.data.map((b) => (
        <Card key={b.id} testID={`booking-${b.id}`} onPress={() => router.push(`/booking/${b.id}`)}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <Text style={{ fontWeight: '600' }}>{localized(b.serviceTitle, lang)}</Text>
            <Badge group="booking" value={b.status} />
          </View>
          <Text style={{ color: colors.muted }}>{b.number} · {formatDateTime(b.startAt, lang)}</Text>
          <Money amount={b.total} currency={b.currency} />
        </Card>
      ))}
    </Screen>
  );
}
