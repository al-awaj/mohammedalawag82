import { useState } from 'react';
import { router, Stack } from 'expo-router';
import { api } from '../lib/api';
import { useTr } from '../lib/i18n';
import { Button, ErrorText, Field, Notice, P, Screen } from '../components/ui';

/** Password recovery: a code is sent to the phone or email, then a new password is set. */
export default function ForgotScreen() {
  const tr = useTr();
  const [identifier, setIdentifier] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [step, setStep] = useState<'ask' | 'reset' | 'done'>('ask');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const run = async (fn: () => Promise<unknown>, then: () => void) => {
    setBusy(true); setError(null);
    try { await fn(); then(); } catch (e) { setError(e); } finally { setBusy(false); }
  };
  return (
    <Screen>
      <Stack.Screen options={{ title: tr({ ar: 'استعادة كلمة المرور', en: 'Reset password' }) }} />
      <Field label={tr({ ar: 'الجوال أو البريد الإلكتروني', en: 'Phone or email' })} value={identifier} onChangeText={setIdentifier} autoCapitalize="none" editable={step === 'ask'} />
      {step === 'ask' && <Button title={tr({ ar: 'إرسال رمز', en: 'Send a code' })} disabled={busy || identifier.trim().length < 5}
        onPress={() => run(() => api.post('/v1/auth/password/forgot', { identifier: identifier.trim() }), () => setStep('reset'))} />}
      {step === 'reset' && <>
        <P muted>{tr({ ar: 'إذا كان الحساب موجودًا فقد أُرسل رمز من 6 أرقام.', en: 'If the account exists, a 6-digit code was sent.' })}</P>
        <Field label={tr({ ar: 'الرمز', en: 'Code' })} value={code} onChangeText={setCode} keyboardType="number-pad" maxLength={6} />
        <Field label={tr({ ar: 'كلمة المرور الجديدة (8 أحرف على الأقل)', en: 'New password (at least 8 characters)' })} value={password} onChangeText={setPassword} secureTextEntry />
        <Button title={tr({ ar: 'تعيين كلمة المرور', en: 'Set password' })} disabled={busy || code.length !== 6 || password.length < 8}
          onPress={() => run(() => api.post('/v1/auth/password/reset', { identifier: identifier.trim(), code, newPassword: password }), () => setStep('done'))} />
      </>}
      {step === 'done' && <>
        <Notice kind="ok">{tr({ ar: 'تغيرت كلمة المرور. سجّل الدخول بها الآن.', en: 'Password changed. Sign in with it now.' })}</Notice>
        <Button title={tr({ ar: 'تسجيل الدخول', en: 'Sign in' })} onPress={() => router.replace('/login')} />
      </>}
      <ErrorText error={error} />
    </Screen>
  );
}
