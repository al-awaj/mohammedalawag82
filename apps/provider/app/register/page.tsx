'use client';
import { RegisterPanel } from '@events/web-kit/ui';
import { useTr } from '@events/web-kit/client';

export default function Register() {
  const tr = useTr();
  return <RegisterPanel title={tr({ ar: 'تسجيل صاحب خدمة', en: 'Provider sign-up' })} termsKind="provider_terms" home="/onboarding" />;
}
