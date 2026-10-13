import { useState } from 'react';
import { Pressable, Switch, Text, View } from 'react-native';
import { router, Stack } from 'expo-router';
import { localized } from '@events/shared';
import { api } from '../lib/api';
import { useGet, useSession } from '../lib/session';
import { useTr } from '../lib/i18n';
import { Button, colors, ErrorText, Field, P, Screen } from '../components/ui';

type Country = { code: string; name: Record<string, string>; phonePrefix: string };

export default function Register() {
  const tr = useTr();
  const { lang, signUp, setCountry } = useSession();
  const countries = useGet<Country[]>('/v1/countries');
  const [form, setForm] = useState({ countryCode: '', fullName: '', phone: '', email: '', password: '' });
  const [accept, setAccept] = useState(false);
  const [terms, setTerms] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (v: string) => setForm({ ...form, [k]: v });
  return (
    <Screen>
      <Stack.Screen options={{ title: tr({ ar: 'إنشاء حساب', en: 'Create an account' }) }} />
      <ErrorText error={error} />
      <P muted>{tr({ ar: 'الدولة', en: 'Country' })}</P>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        {(countries.data ?? []).map((c) => (
          <Pressable key={c.code} testID={`country-${c.code}`} onPress={() => setForm({ ...form, countryCode: c.code, phone: form.phone || c.phonePrefix })}
            style={{ paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999, borderWidth: 1, borderColor: form.countryCode === c.code ? colors.primary : colors.border, backgroundColor: form.countryCode === c.code ? colors.primarySoft : colors.surface }}>
            <Text>{localized(c.name, lang)}</Text>
          </Pressable>
        ))}
      </View>
      <Field testID="fullName" label={tr({ ar: 'الاسم الكامل', en: 'Full name' })} value={form.fullName} onChangeText={set('fullName')} />
      <Field testID="phone" label={tr({ ar: 'رقم الجوال (بالصيغة الدولية)', en: 'Mobile (international format)' })} value={form.phone} onChangeText={set('phone')} keyboardType="phone-pad" />
      <Field testID="email" label={tr({ ar: 'البريد الإلكتروني (اختياري)', en: 'Email (optional)' })} value={form.email} onChangeText={set('email')} autoCapitalize="none" keyboardType="email-address" />
      <Field testID="reg-password" label={tr({ ar: 'كلمة المرور (10 أحرف على الأقل، حروف وأرقام)', en: 'Password (10+ characters, letters and digits)' })} value={form.password} onChangeText={set('password')} secureTextEntry />
      {form.countryCode !== '' && (
        <Button variant="secondary" title={tr({ ar: 'قراءة الشروط والأحكام', en: 'Read the terms' })} onPress={async () => {
          try {
            const t = await api.get<{ content: Record<string, string> }>('/v1/terms/current', { kind: 'customer_terms', country: form.countryCode });
            setError(null);
            setTerms(localized(t.content, lang));
          } catch (e) { setError(e); }
        }} />
      )}
      {terms && <View style={{ backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 10, padding: 12 }}><Text>{terms}</Text></View>}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Switch testID="accept" value={accept} onValueChange={setAccept} accessibilityLabel="accept" />
        <Text style={{ flex: 1 }}>{tr({ ar: 'أوافق على الشروط والأحكام وسياسة الخصوصية', en: 'I accept the terms and the privacy policy' })}</Text>
      </View>
      <Button testID="register-submit" disabled={busy || !accept || !form.countryCode} title={tr({ ar: 'إنشاء الحساب', en: 'Create account' })} onPress={async () => {
        setBusy(true); setError(null);
        try {
          await signUp({ ...form, email: form.email.trim() || undefined, preferredLanguage: lang, acceptTerms: true });
          setCountry(form.countryCode);
          router.replace('/verify');
        } catch (e) { setError(e); } finally { setBusy(false); }
      }} />
    </Screen>
  );
}
