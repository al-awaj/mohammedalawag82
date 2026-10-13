import { useState } from 'react';
import { Text } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import * as DocumentPicker from 'expo-document-picker';
import { ENUMS, formatDateTime, formatMoney } from '@events/shared';
import { api, fileForm } from '../../lib/api';
import { useAction, useGet, useSession } from '../../lib/session';
import { useTr } from '../../lib/i18n';
import { RequireLogin } from '../../components/require-login';
import { Badge, Button, Card, ErrorText, Field, H2, Loading, P, Screen } from '../../components/ui';

interface Dispute {
  id: string; number: string; kind: string; type: string; subject: string; description: string; status: string; bookingNumber: string | null;
  disputedAmount: string | null; currency: string | null; decision: { outcome?: string; rationale?: string } | null; createdAt: string; myRole: string;
  events: { action: string; actorRole: string; note: string | null; to: string | null; at: string }[];
  evidence: { id: string; partyRole: string; mimeType: string; description: string | null; createdAt: string }[];
}

export default function DisputeScreen() {
  return <RequireLogin><DisputeView /></RequireLogin>;
}

const ROLE = { complainant: { ar: 'أنت', en: 'You' }, customer: { ar: 'العميل', en: 'Customer' }, provider: { ar: 'صاحب الخدمة', en: 'Provider' }, staff: { ar: 'الإدارة', en: 'Administration' } } as Record<string, { ar: string; en: string }>;

/** A dispute or complaint: its timeline, statements to the administration and evidence files (clause 51). */
function DisputeView() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const tr = useTr();
  const { lang } = useSession();
  const q = useGet<Dispute>(`/v1/disputes/${id}`);
  const [note, setNote] = useState('');
  const say = useAction(() => api.post(`/v1/disputes/${id}/statements`, { note: note.trim() }));
  const attach = useAction(async () => {
    const r = await DocumentPicker.getDocumentAsync({ type: ['image/*', 'application/pdf'], copyToCacheDirectory: true });
    if (r.canceled || !r.assets[0]) return null;
    return api.upload(`/v1/disputes/${id}/evidence`, fileForm(r.assets[0], { description: r.assets[0].name }));
  });
  if (q.isLoading) return <Loading />;
  const d = q.data;
  if (!d) return <Screen><ErrorText error={q.error} /></Screen>;
  const open = d.status !== 'closed';
  return (
    <Screen>
      <Stack.Screen options={{ title: d.number }} />
      <Card>
        <Text style={{ fontWeight: '700', fontSize: 16 }}>{d.subject}</Text>
        <Badge group="dispute" value={d.status} />
        <P muted small>{ENUMS.disputeType?.[d.type]?.[lang] ?? d.type}{d.bookingNumber ? ` · ${d.bookingNumber}` : ''} · {formatDateTime(d.createdAt, lang)}</P>
        {d.disputedAmount && d.currency ? <P>{tr({ ar: 'المبلغ محل النزاع', en: 'Amount in dispute' })}: {formatMoney(d.disputedAmount, d.currency)}</P> : null}
        <P>{d.description}</P>
        {d.decision?.rationale ? <P>{tr({ ar: 'القرار', en: 'Decision' })}: {d.decision.rationale}</P> : null}
      </Card>
      <H2>{tr({ ar: 'سجل النزاع', en: 'Timeline' })}</H2>
      {d.events.map((e, i) => (
        <Card key={i}>
          <P small muted>{tr(ROLE[e.actorRole] ?? { ar: e.actorRole, en: e.actorRole })} · {formatDateTime(e.at, lang)}{e.to ? ` · ${ENUMS.dispute?.[e.to]?.[lang] ?? e.to}` : ''}</P>
          {e.note ? <P>{e.note}</P> : null}
        </Card>
      ))}
      {d.evidence.length > 0 && <>
        <H2>{tr({ ar: 'المرفقات', en: 'Evidence' })}</H2>
        {d.evidence.map((ev) => <P key={ev.id} small>{ev.description ?? ev.mimeType} · {formatDateTime(ev.createdAt, lang)}</P>)}
      </>}
      {open && (
        <Card>
          <H2>{tr({ ar: 'إضافة رد أو معلومات', en: 'Add a reply or information' })}</H2>
          <Field testID="dispute-note" label={tr({ ar: 'نص الرد', en: 'Your reply' })} value={note} onChangeText={setNote} multiline />
          <ErrorText error={say.error ?? attach.error} />
          <Button testID="send-note" title={tr({ ar: 'إرسال الرد', en: 'Send reply' })} disabled={note.trim().length < 3 || say.isPending}
            onPress={() => say.mutate(undefined, { onSuccess: () => setNote('') })} />
          <Button variant="secondary" title={tr({ ar: 'إرفاق صورة أو ملف PDF', en: 'Attach a photo or PDF' })} disabled={attach.isPending} onPress={() => attach.mutate(undefined)} />
        </Card>
      )}
    </Screen>
  );
}
