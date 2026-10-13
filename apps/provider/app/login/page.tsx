'use client';
import Link from 'next/link';
import { LoginPanel } from '@events/web-kit/ui';
import { useTr } from '@events/web-kit/client';

export default function Login() {
  const tr = useTr();
  return <LoginPanel title={tr({ ar: 'لوحة أصحاب الخدمات', en: 'Provider panel' })} extra={
    <p className="small">
      <Link href="/register">{tr({ ar: 'سجّل كصاحب خدمة', en: 'Register as a provider' })}</Link> · <Link href="/reset">{tr({ ar: 'نسيت كلمة المرور؟', en: 'Forgot password?' })}</Link>
    </p>
  } />;
}
