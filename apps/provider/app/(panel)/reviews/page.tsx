'use client';
import { useGet, useTr } from '@events/web-kit/client';
import { ActionButton, Badge, DataTable, DateTime, ErrorBox, Loading, Notice, Page } from '@events/web-kit/ui';

type Review = { id: string; rating: number; comment: string | null; status: string; createdAt: string };

export default function Reviews() {
  const tr = useTr();
  const { data, error, isLoading } = useGet<Review[]>('/v1/provider/reviews');
  return (
    <Page title={tr({ ar: 'تقييمات العملاء', en: 'Customer reviews' })}>
      <Notice>{tr({ ar: 'لا يمكن حذف التقييمات؛ يمكنك الإبلاغ عن تقييم مخالف لتراجعه الإدارة.', en: 'Reviews cannot be deleted; you can report an abusive review for the administration to check.' })}</Notice>
      <ErrorBox error={error} />
      {isLoading ? <Loading /> : (
        <DataTable rows={data ?? []} columns={[
          { key: 'rating', label: { ar: 'التقييم', en: 'Rating' }, render: (r) => '★'.repeat(r.rating) + '☆'.repeat(5 - r.rating) },
          { key: 'comment', label: { ar: 'التعليق', en: 'Comment' } },
          { key: 'status', label: { ar: 'الحالة', en: 'Status' }, render: (r) => <Badge group="review" value={r.status} /> },
          { key: 'createdAt', label: { ar: 'التاريخ', en: 'Date' }, render: (r) => <DateTime value={r.createdAt} /> },
          { key: 'report', label: '', render: (r) => <ActionButton label={tr({ ar: 'إبلاغ', en: 'Report' })} fields={[{ name: 'reason', label: { ar: 'سبب الإبلاغ', en: 'Reason' }, type: 'textarea', required: true }]} run={(api, v) => api.post(`/v1/provider/reviews/${r.id}/report`, v)} /> },
        ]} />
      )}
    </Page>
  );
}
