'use client';
import Link from 'next/link';
import { useEffect } from 'react';
import { RotateCcw, SearchX, TriangleAlert } from 'lucide-react';
import { useTr } from '../client';

/** Route-level states used by every app's loading.tsx, error.tsx and not-found.tsx. */
export function PageLoading() {
  const tr = useTr();
  return (
    <div className="page-status" role="status" aria-live="polite">
      <span className="spinner spinner-lg" aria-hidden />
      <span className="muted">{tr({ ar: 'جارٍ التحميل…', en: 'Loading…' })}</span>
    </div>
  );
}

export function PageError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const tr = useTr();
  useEffect(() => { console.error(error); }, [error]);
  return (
    <div className="page-status">
      <span className="status-icon status-bad"><TriangleAlert aria-hidden /></span>
      <h1>{tr({ ar: 'حدث خطأ غير متوقع', en: 'Something went wrong' })}</h1>
      <p className="muted">{tr({ ar: 'لم تكتمل العملية. أعد المحاولة، وإن تكرر الخطأ تواصل مع الدعم.', en: 'The page could not be shown. Try again; if it keeps happening, contact support.' })}
        {error.digest && <><br /><code className="code">{error.digest}</code></>}</p>
      <div className="row gap">
        <button type="button" className="btn btn-primary" onClick={reset}><RotateCcw className="ico" aria-hidden />{tr({ ar: 'إعادة المحاولة', en: 'Try again' })}</button>
        <Link href="/" className="btn btn-secondary">{tr({ ar: 'الرئيسية', en: 'Home' })}</Link>
      </div>
    </div>
  );
}

export function PageNotFound() {
  const tr = useTr();
  return (
    <div className="page-status">
      <span className="status-icon"><SearchX aria-hidden /></span>
      <h1>{tr({ ar: 'الصفحة غير موجودة', en: 'Page not found' })}</h1>
      <p className="muted">{tr({ ar: 'ربما نُقلت الصفحة أو لم تعد متاحة.', en: 'The page may have moved or is no longer available.' })}</p>
      <Link href="/" className="btn btn-primary">{tr({ ar: 'العودة للرئيسية', en: 'Back home' })}</Link>
    </div>
  );
}
