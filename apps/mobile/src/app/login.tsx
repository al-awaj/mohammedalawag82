import { useState } from 'react';
import { router, Stack } from 'expo-router';
import { useSession } from '../lib/session';
import { useTr } from '../lib/i18n';
import { Button, ErrorText, Field, Screen } from '../components/ui';

export default function Login() {
  const tr = useTr();
  const { signIn } = useSession();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Screen>
      <Stack.Screen options={{ title: tr({ ar: 'تسجيل الدخول', en: 'Sign in' }) }} />
      <ErrorText error={error} />
      <Field label={tr({ ar: 'البريد الإلكتروني أو رقم الجوال', en: 'Email or mobile number' })} value={identifier} onChangeText={setIdentifier} autoCapitalize="none" keyboardType="email-address" testID="identifier" />
      <Field label={tr({ ar: 'كلمة المرور', en: 'Password' })} value={password} onChangeText={setPassword} secureTextEntry testID="password" />
      <Button testID="login-submit" disabled={busy} title={tr({ ar: 'دخول', en: 'Sign in' })} onPress={async () => {
        setBusy(true); setError(null);
        try { await signIn(identifier.trim(), password); router.back(); } catch (e) { setError(e); } finally { setBusy(false); }
      }} />
      <Button variant="secondary" title={tr({ ar: 'إنشاء حساب', en: 'Create an account' })} onPress={() => router.replace('/register')} />
    </Screen>
  );
}
