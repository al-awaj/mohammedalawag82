import { useState } from 'react';
import { Text } from 'react-native';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { ENUMS, formatDateTime } from '@events/shared';
import { api } from '../lib/api';
import { useAction, useGet, useSession } from '../lib/session';
import { useTr } from '../lib/i18n';
import { RequireLogin } from '../components/require-login';
import { Badge, Button, Card, Choice, Empty, ErrorText, Field, H2, Loading, P, Screen } from '../components/ui';

type D = { id: string; number: string; kind: string; subject: string; status: string; bookingNumber: string | null; createdAt: string };
const TYPES = ['service_not_delivered', 'service_quality', 'billing', 'refund', 'damage', 'behaviour', 'other'];

export default function Disputes() {
  return <RequireLogin><List /></RequireLogin>;
}

/** Disputes and complaints; a complaint goes to the administration without another party (support). */
function List() {
  const tr = useTr();
  const { lang } = useSession();
  const params = useLocalSearchParams<{ new?: string }>();
  const q = useGet<D[]>('/v1/disputes');
  const [open, setOpen] = useState(params.new === '1');
  const [type, setType] = useState<string | null>('other');
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const create = useAction(() => api.post<{ id: string }>('/v1/disputes', { kind: 'complaint', type, subject: subject.trim(), description: description.trim() }));
  return (
    <Screen>
      <Stack.Screen options={{ title: tr({ ar: 'النزاعات والشكاوى', en: 'Disputes & complaints' }) }} />
      {!open ? <Button testID="new-complaint" title={tr({ ar: 'تواصل مع الدعم / شكوى جديدة', en: 'Contact support / new complaint' })} onPress={() => setOpen(true)} /> : (
        <Card testID="complaint-form">
          <H2>{tr({ ar: 'رسالة إلى الإدارة', en: 'Message to the administration' })}</H2>
          <P muted small>{tr({ ar: 'للاعتراض على حجز بعينه افتح نزاعًا من صفحة الحجز.', en: 'To dispute a specific booking, open a dispute from the booking page.' })}</P>
          <Choice label={tr({ ar: 'الموضوع', en: 'Topic' })} value={type} options={TYPES.map((t) => ({ value: t, label: ENUMS.disputeType?.[t]?.[lang] ?? t }))} onChange={setType} />
          <Field testID="complaint-subject" label={tr({ ar: 'العنوان', en: 'Subject' })} value={subject} onChangeText={setSubject} />
          <Field testID="complaint-description" label={tr({ ar: 'التفاصيل (10 أحرف على الأقل)', en: 'Details (at least 10 characters)' })} value={description} onChangeText={setDescription} multiline />
          <ErrorText error={create.error} />
          <Button testID="send-complaint" title={tr({ ar: 'إرسال', en: 'Send' })} disabled={!type || subject.trim().length < 3 || description.trim().length < 10 || create.isPending}
            onPress={() => create.mutate(undefined, { onSuccess: (r) => { setOpen(false); setSubject(''); setDescription(''); router.push(`/dispute/${r.id}`); } })} />
        </Card>
      )}
      <ErrorText error={q.error} />
      {q.isLoading ? <Loading /> : !q.data?.length ? <Empty>{tr({ ar: 'لا توجد نزاعات أو شكاوى', en: 'No disputes or complaints' })}</Empty> : q.data.map((d) => (
        <Card key={d.id} testID={`dispute-${d.number}`} onPress={() => router.push(`/dispute/${d.id}`)}>
          <Text style={{ fontWeight: '600' }}>{d.number} · {d.subject}</Text>
          <Badge group="dispute" value={d.status} />
          <P muted small>{d.kind === 'complaint' ? tr({ ar: 'شكوى للإدارة', en: 'Complaint' }) : d.bookingNumber ?? ''} · {formatDateTime(d.createdAt, lang)}</P>
        </Card>
      ))}
    </Screen>
  );
}
