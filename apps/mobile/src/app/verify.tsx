import { useState } from 'react';
import { router, Stack } from 'expo-router';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import { useTr } from '../lib/i18n';
import { Button, ErrorText, Field, Notice, P, Screen } from '../components/ui';

export default function Verify() {
  const tr = useTr();
  const { reloadUser } = useSession();
  const [code, setCode] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [sent, setSent] = useState(false);
  return (
    <Screen>
      <Stack.Screen options={{ title: tr({ ar: 'تأكيد رقم الجوال', en: 'Verify your mobile' }) }} />
      <P muted>{tr({ ar: 'أدخل رمز التحقق الذي وصلك.', en: 'Enter the verification code you received.' })}</P>
      {sent && <Notice kind="ok">{tr({ ar: 'تم إرسال رمز جديد', en: 'A new code was sent' })}</Notice>}
      <ErrorText error={error} />
      <Field testID="code" label={tr({ ar: 'الرمز', en: 'Code' })} value={code} onChangeText={setCode} keyboardType="number-pad" />
      <Button testID="verify-submit" title={tr({ ar: 'تأكيد', en: 'Verify' })} onPress={async () => {
        setError(null);
        try { await api.post('/v1/auth/verification/confirm', { channel: 'phone', code: code.trim() }); await reloadUser(); router.replace('/'); } catch (e) { setError(e); }
      }} />
      <Button variant="secondary" title={tr({ ar: 'إعادة إرسال الرمز', en: 'Resend code' })} onPress={async () => {
        setError(null);
        try { await api.post('/v1/auth/verification/request', { channel: 'phone' }); setSent(true); } catch (e) { setError(e); }
      }} />
    </Screen>
  );
}
