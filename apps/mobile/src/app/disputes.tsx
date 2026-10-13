import { Text } from 'react-native';
import { Stack } from 'expo-router';
import { formatDateTime } from '@events/shared';
import { useGet, useSession } from '../lib/session';
import { useTr } from '../lib/i18n';
import { RequireLogin } from '../components/require-login';
import { Badge, Card, Empty, ErrorText, Loading, P, Screen } from '../components/ui';

type D = { id: string; number: string; subject: string; status: string; bookingNumber: string | null; createdAt: string };

export default function Disputes() {
  return <RequireLogin><List /></RequireLogin>;
}
function List() {
  const tr = useTr();
  const { lang } = useSession();
  const q = useGet<D[]>('/v1/disputes');
  return (
    <Screen>
      <Stack.Screen options={{ title: tr({ ar: 'النزاعات والشكاوى', en: 'Disputes & complaints' }) }} />
      <ErrorText error={q.error} />
      {q.isLoading ? <Loading /> : !q.data?.length ? <Empty>{tr({ ar: 'لا توجد نزاعات', en: 'No disputes' })}</Empty> : q.data.map((d) => (
        <Card key={d.id}>
          <Text style={{ fontWeight: '600' }}>{d.number} · {d.subject}</Text>
          <Badge group="dispute" value={d.status} />
          <P muted small>{d.bookingNumber ?? ''} {formatDateTime(d.createdAt, lang)}</P>
        </Card>
      ))}
    </Screen>
  );
}
