'use client';
import { LoginPanel } from '@events/web-kit/ui';
import { useTr } from '@events/web-kit/client';

export default function Login() {
  const tr = useTr();
  return <LoginPanel title={tr({ ar: 'لوحة الإدارة', en: 'Administration' })} />;
}
