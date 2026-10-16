import { router } from 'expo-router';
import { useSession } from '../../lib/session';
import { useTr } from '../../lib/i18n';
import { Button, Card, H2, P, Screen } from '../../components/ui';
import { Platform } from 'react-native';

export default function Account() {
  const tr = useTr();
  const { user, lang, setLang, signOut } = useSession();
  return (
    <Screen>
      {user ? (
        <Card>
          <H2>{user.fullName}</H2>
          <P muted>{user.phone} · {user.countryCode}</P>
        </Card>
      ) : <>
        <Button testID="account-login" title={tr({ ar: 'تسجيل الدخول', en: 'Sign in' })} onPress={() => router.push('/login')} />
        <Button variant="secondary" title={tr({ ar: 'إنشاء حساب', en: 'Create an account' })} onPress={() => router.push('/register')} />
      </>}
      {user && <>
        <Button variant="secondary" testID="open-events" title={tr({ ar: 'مناسباتي', en: 'My events' })} onPress={() => router.push('/events')} />
        <Button variant="secondary" title={tr({ ar: 'الملف الشخصي وكلمة المرور', en: 'Profile & password' })} onPress={() => router.push('/profile')} />
        <Button variant="secondary" title={tr({ ar: 'الإشعارات', en: 'Notifications' })} onPress={() => router.push('/notifications')} />
        <Button variant="secondary" title={tr({ ar: 'الفواتير والإيصالات', en: 'Invoices & receipts' })} onPress={() => router.push('/documents')} />
        <Button variant="secondary" title={tr({ ar: 'النزاعات والشكاوى', en: 'Disputes & complaints' })} onPress={() => router.push('/disputes')} />
        <Button variant="secondary" testID="contact-support" title={tr({ ar: 'تواصل مع الدعم', en: 'Contact support' })} onPress={() => router.push('/disputes?new=1')} />
      </>}
      <Button variant="secondary" testID="open-help" title={tr({ ar: 'المساعدة والأسئلة الشائعة', en: 'Help & FAQ' })} onPress={() => router.push('/help')} />
      <Button variant="secondary" testID="switch-lang" title={lang === 'ar' ? 'English' : 'العربية'} onPress={() => setLang(lang === 'ar' ? 'en' : 'ar')} />
      {Platform.OS !== 'web' && <P muted small>{tr({ ar: 'يُطبق اتجاه الواجهة الجديد بعد إعادة تشغيل التطبيق.', en: 'The new layout direction applies after restarting the app.' })}</P>}
      {user && <Button variant="danger" title={tr({ ar: 'تسجيل الخروج', en: 'Sign out' })} onPress={() => void signOut()} />}
    </Screen>
  );
}
