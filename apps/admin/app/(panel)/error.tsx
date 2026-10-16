'use client';
import { PageError } from '@events/web-kit/ui';

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <PageError error={error} reset={reset} />;
}
