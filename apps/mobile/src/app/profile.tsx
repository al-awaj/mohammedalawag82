import { useEffect, useState } from 'react';
import { Alert, Share } from 'react-native';
import { router, Stack } from 'expo-router';
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
  const { user, setLang, reloadUser, signOut } = useSession();
  const [name, setName] = useState(user?.fullName ?? '');
  const [language, setLanguage] = useState<'ar' | 'en'>(user?.preferredLanguage === 'en' ? 'en' : 'ar');
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [saved, setSaved] = useState<'profile' | 'password' | null>(null);
  useEffect(() => { if (user) setName(user.fullName); }, [user]);
  const saveProfile = useAction(() => api.patch('/v1/me', { fullName: name.trim(), preferredLanguage: language }));
  const changePassword = useAction(() => api.post('/v1/me/password', { currentPassword: current, newPassword: next }));
  const [delPassword, setDelPassword] = useState('');
  const exportData = useAction(async () => { const d = await api.get('/v1/me/export'); await Share.share({ message: JSON.stringify(d, null, 2) }); });
  const deleteAccount = useAction(() => api.post('/v1/me/delete', { password: delPassword, confirm: true }));
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
      <Card>
        <H2>{tr({ ar: 'بياناتي الشخصية', en: 'My personal data' })}</H2>
        <ErrorText error={exportData.error} />
        <Button variant="secondary" testID="export-data" title={tr({ ar: 'تصدير بياناتي', en: 'Export my data' })} onPress={() => exportData.mutate(undefined)} />
        <P muted small>{tr({ ar: 'حذف الحساب نهائي: يُزال اسمك وجوالك وبريدك، وتبقى السجلات المالية دون بياناتك الشخصية. يجب إنهاء الحجوزات والنزاعات القائمة أولًا.', en: 'Deleting the account is final: your name, phone and email are removed; financial records stay without your personal details. Open bookings and disputes must be settled first.' })}</P>
        <Field label={tr({ ar: 'كلمة المرور للتأكيد', en: 'Password to confirm' })} value={delPassword} onChangeText={setDelPassword} secureTextEntry />
        <ErrorText error={deleteAccount.error} />
        <Button variant="danger" testID="delete-account" title={tr({ ar: 'حذف حسابي', en: 'Delete my account' })} disabled={!delPassword || deleteAccount.isPending}
          onPress={() => Alert.alert(tr({ ar: 'حذف الحساب', en: 'Delete account' }), tr({ ar: 'لا يمكن التراجع. هل أنت متأكد؟', en: 'This cannot be undone. Are you sure?' }), [
            { text: tr({ ar: 'إلغاء', en: 'Cancel' }), style: 'cancel' },
            { text: tr({ ar: 'حذف', en: 'Delete' }), style: 'destructive', onPress: () => deleteAccount.mutate(undefined, { onSuccess: async () => { await signOut().catch(() => undefined); router.replace('/'); } }) },
          ])} />
      </Card>
    </Screen>
  );
}
