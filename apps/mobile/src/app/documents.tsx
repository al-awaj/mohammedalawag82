import { Text } from 'react-native';
import { router, Stack } from 'expo-router';
import { enumLabel, formatDateTime } from '@events/shared';
import { useGet, useSession } from '../lib/session';
import { useTr } from '../lib/i18n';
import { RequireLogin } from '../components/require-login';
import { Card, Empty, ErrorText, Loading, Money, P, Screen } from '../components/ui';

type Doc = { id: string; number: string; kind: string; currency: string; total: string; issuedAt: string };

export default function Documents() {
  return <RequireLogin><List /></RequireLogin>;
}
function List() {
  const tr = useTr();
  const { lang } = useSession();
  const q = useGet<Doc[]>('/v1/documents', { limit: 200 });
  return (
    <Screen>
      <Stack.Screen options={{ title: tr({ ar: 'الفواتير والإيصالات', en: 'Invoices & receipts' }) }} />
      <P muted small>{tr({ ar: 'اضغط على المستند لعرضه أو طباعته أو حفظه PDF.', en: 'Tap a document to view, print or save it as PDF.' })}</P>
      <ErrorText error={q.error} />
      {q.isLoading ? <Loading /> : !q.data?.length ? <Empty>{tr({ ar: 'لا توجد مستندات', en: 'No documents' })}</Empty> : q.data.map((d) => (
        <Card key={d.id} testID={`doc-${d.number}`} onPress={() => router.push({ pathname: '/document/[id]', params: { id: d.id, title: d.number } })}>
          <Text style={{ fontWeight: '600' }}>{enumLabel('document', d.kind, lang)} · {d.number}</Text>
          <Money amount={d.total} currency={d.currency} />
          <P muted small>{formatDateTime(d.issuedAt, lang)}</P>
        </Card>
      ))}
    </Screen>
  );
}
