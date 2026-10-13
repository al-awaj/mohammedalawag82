import { useEffect, useState } from 'react';
import { Stack } from 'expo-router';
import { api } from '../lib/api';
import { useAction, useSession } from '../lib/session';
import { useTr } from '../lib/i18n';
import { RequireLogin } from '../components/require-login';
import { Button, Card, Choice, ErrorText, Field, H2, Notice, P, Screen } from '../components/ui';

export default function ProfileScreen() {
  return <RequireLogin><Profile /></RequireLogin>;
}

/** Edit the profile (name, preferred language) and change the password. */
function Profile() {
  const tr = useTr();
  const { user, setLang, reloadUser } = useSession();
  const [name, setName] = useState(user?.fullName ?? '');
  const [language, setLanguage] = useState<'ar' | 'en'>(user?.preferredLanguage === 'en' ? 'en' : 'ar');
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [saved, setSaved] = useState<'profile' | 'password' | null>(null);
  useEffect(() => { if (user) setName(user.fullName); }, [user]);
  const saveProfile = useAction(() => api.patch('/v1/me', { fullName: name.trim(), preferredLanguage: language }));
  const changePassword = useAction(() => api.post('/v1/me/password', { currentPassword: current, newPassword: next }));
  return (
    <Screen>
      <Stack.Screen options={{ title: tr({ ar: 'الملف الشخصي', en: 'Profile' }) }} />
      <Card>
        <H2>{tr({ ar: 'بياناتي', en: 'My details' })}</H2>
        <P muted small>{user?.phone} · {user?.email ?? ''} · {user?.countryCode}</P>
        <Field testID="profile-name" label={tr({ ar: 'الاسم', en: 'Name' })} value={name} onChangeText={setName} />
        <Choice label={tr({ ar: 'لغة الرسائل والإشعارات', en: 'Language for messages' })} value={language}
          options={[{ value: 'ar', label: 'العربية' }, { value: 'en', label: 'English' }]} onChange={(v) => v && setLanguage(v)} />
        <ErrorText error={saveProfile.error} />
        {saved === 'profile' && <Notice kind="ok">{tr({ ar: 'حُفظت البيانات.', en: 'Saved.' })}</Notice>}
        <Button testID="save-profile" title={tr({ ar: 'حفظ', en: 'Save' })} disabled={name.trim().length < 2 || saveProfile.isPending}
          onPress={() => saveProfile.mutate(undefined, { onSuccess: async () => { setSaved('profile'); setLang(language); await reloadUser(); } })} />
      </Card>
      <Card>
        <H2>{tr({ ar: 'تغيير كلمة المرور', en: 'Change password' })}</H2>
        <Field label={tr({ ar: 'كلمة المرور الحالية', en: 'Current password' })} value={current} onChangeText={setCurrent} secureTextEntry />
        <Field label={tr({ ar: 'كلمة المرور الجديدة (8 أحرف على الأقل)', en: 'New password (at least 8 characters)' })} value={next} onChangeText={setNext} secureTextEntry />
        <ErrorText error={changePassword.error} />
        {saved === 'password' && <Notice kind="ok">{tr({ ar: 'تغيرت كلمة المرور.', en: 'Password changed.' })}</Notice>}
        <Button title={tr({ ar: 'تغيير كلمة المرور', en: 'Change password' })} disabled={!current || next.length < 8 || changePassword.isPending}
          onPress={() => changePassword.mutate(undefined, { onSuccess: () => { setSaved('password'); setCurrent(''); setNext(''); } })} />
      </Card>
    </Screen>
  );
}
