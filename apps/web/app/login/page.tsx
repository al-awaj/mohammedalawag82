'use client';
import Link from 'next/link';
import { LoginPanel } from '@events/web-kit/ui';
import { useTr } from '@events/web-kit/client';

export default function Login() {
  const tr = useTr();
  return <LoginPanel title={tr({ ar: 'تسجيل الدخول', en: 'Sign in' })} home="/account/bookings" extra={
    <p className="small"><Link href="/register">{tr({ ar: 'إنشاء حساب جديد', en: 'Create an account' })}</Link> · <Link href="/reset">{tr({ ar: 'نسيت كلمة المرور؟', en: 'Forgot password?' })}</Link> · <Link href="/">{tr({ ar: 'الرئيسية', en: 'Home' })}</Link></p>
  } />;
}
