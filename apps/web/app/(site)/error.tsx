// No loading.tsx in this group: a Suspense boundary would stream 200 before notFound() can set 404 on missing services.
'use client';
import { PageError } from '@events/web-kit/ui';

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <PageError error={error} reset={reset} />;
}
