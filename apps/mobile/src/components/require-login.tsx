import type { ReactNode } from 'react';
import { router } from 'expo-router';
import { useSession } from '../lib/session';
import { useTr } from '../lib/i18n';
import { Button, Loading, P, Screen } from './ui';

/** Customer-only screens: prompts to sign in or verify the phone first. */
export function RequireLogin({ children }: { children: ReactNode }) {
  const tr = useTr();
  const { user } = useSession();
  if (user === undefined) return <Loading />;
  if (!user) return (
    <Screen>
      <P>{tr({ ar: 'سجّل الدخول للمتابعة.', en: 'Sign in to continue.' })}</P>
      <Button testID="go-login" title={tr({ ar: 'تسجيل الدخول', en: 'Sign in' })} onPress={() => router.push('/login')} />
      <Button variant="secondary" title={tr({ ar: 'إنشاء حساب', en: 'Create an account' })} onPress={() => router.push('/register')} />
    </Screen>
  );
  if (!user.phoneVerifiedAt) return (
    <Screen>
      <P>{tr({ ar: 'أكّد رقم جوالك أولًا.', en: 'Verify your mobile number first.' })}</P>
      <Button title={tr({ ar: 'تأكيد الرقم', en: 'Verify' })} onPress={() => router.push('/verify')} />
    </Screen>
  );
  return <>{children}</>;
}
