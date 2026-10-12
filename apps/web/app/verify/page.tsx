'use client';
import { useSearchParams } from 'next/navigation';
import { VerifyPanel } from '@events/web-kit/ui';

export default function Verify() {
  const next = useSearchParams().get('next');
  return <VerifyPanel next={next && next.startsWith('/') && !next.startsWith('//') ? next : '/'} />;
}
