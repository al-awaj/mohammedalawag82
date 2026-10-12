'use client';
import { RegisterPanel } from '@events/web-kit/ui';
import { useTr } from '@events/web-kit/client';

export default function Register() {
  const tr = useTr();
  return <RegisterPanel title={tr({ ar: 'إنشاء حساب', en: 'Create an account' })} termsKind="customer_terms" home="/" />;
}
