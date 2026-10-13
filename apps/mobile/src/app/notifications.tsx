import { Text } from 'react-native';
import { Stack } from 'expo-router';
import { formatDateTime } from '@events/shared';
import { api } from '../lib/api';
import { useAction, useGet, useSession } from '../lib/session';
import { useTr } from '../lib/i18n';
import { RequireLogin } from '../components/require-login';
import { Button, Card, Empty, ErrorText, Loading, P, Screen } from '../components/ui';

type N = { id: string; type: string; subject: string | null; body: string | null; createdAt: string; readAt: string | null };

export default function Notifications() {
  return <RequireLogin><List /></RequireLogin>;
}
function List() {
  const tr = useTr();
  const { lang } = useSession();
  const q = useGet<{ unread: number; items: N[] }>('/v1/me/notifications', { limit: 100 });
  const read = useAction((id: string) => api.post(`/v1/me/notifications/${id}/read`));
  return (
    <Screen>
      <Stack.Screen options={{ title: tr({ ar: 'الإشعارات', en: 'Notifications' }) }} />
      <ErrorText error={q.error} />
      {q.isLoading ? <Loading /> : !q.data?.items.length ? <Empty>{tr({ ar: 'لا توجد إشعارات', en: 'No notifications' })}</Empty> : q.data.items.map((n) => (
        <Card key={n.id}>
          <Text style={{ fontWeight: n.readAt ? '400' : '700' }}>{n.subject ?? n.type}</Text>
          {n.body && <P>{n.body}</P>}
          <P muted small>{formatDateTime(n.createdAt, lang)}</P>
          {!n.readAt && <Button variant="secondary" title={tr({ ar: 'تعليم كمقروء', en: 'Mark as read' })} onPress={() => read.mutate(n.id)} />}
        </Card>
      ))}
    </Screen>
  );
}
