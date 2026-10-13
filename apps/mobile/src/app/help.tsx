import { useState } from 'react';
import { Pressable, Text } from 'react-native';
import { router, Stack } from 'expo-router';
import { localized } from '@events/shared';
import { useGet, useSession } from '../lib/session';
import { useTr } from '../lib/i18n';
import { Button, Card, Empty, ErrorText, Loading, P, Screen } from '../components/ui';

type Article = { id: string; topic: string; question: Record<string, string>; answer: Record<string, string> };

/** Questions and answers the administration publishes for customers in the chosen country. */
export default function HelpScreen() {
  const tr = useTr();
  const { lang, country } = useSession();
  const countries = useGet<{ code: string }[]>('/v1/countries');
  const code = country ?? countries.data?.[0]?.code ?? null;
  const q = useGet<Article[]>(code ? '/v1/help' : null, { country: code ?? '', audience: 'customer' });
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Screen>
      <Stack.Screen options={{ title: tr({ ar: 'المساعدة والأسئلة الشائعة', en: 'Help & FAQ' }) }} />
      <ErrorText error={q.error} />
      {q.isLoading ? <Loading /> : !q.data?.length ? <Empty>{tr({ ar: 'لا توجد أسئلة منشورة بعد', en: 'Nothing published yet' })}</Empty> : q.data.map((a) => (
        <Card key={a.id} testID={`help-${a.id}`}>
          <Pressable accessibilityRole="button" onPress={() => setOpen(open === a.id ? null : a.id)}>
            <Text style={{ fontWeight: '700' }}>{localized(a.question, lang)}</Text>
          </Pressable>
          {open === a.id ? <P>{localized(a.answer, lang)}</P> : null}
        </Card>
      ))}
      <Button variant="secondary" title={tr({ ar: 'تواصل مع الدعم', en: 'Contact support' })} onPress={() => router.push('/disputes?new=1')} />
    </Screen>
  );
}
