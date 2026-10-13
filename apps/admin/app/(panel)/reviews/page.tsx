'use client';
import { useTr } from '@events/web-kit/client';
import { ActionButton, Badge, DateTime, ListView, Page, reasonField } from '@events/web-kit/ui';
import { opts } from '@/lib/util';

type Row = { id: string; bookingId: string; serviceId: string; rating: number; comment: string | null; status: string; reportedCount: number; moderationReason: string | null; createdAt: string };

export default function Reviews() {
  const tr = useTr();
  return (
    <Page title={tr({ ar: 'التقييمات', en: 'Reviews' })}>
      <ListView<Row>
        path="/v1/admin/reviews"
        filters={[
          { name: 'status', label: tr({ ar: 'الحالة', en: 'Status' }), type: 'select', options: opts('review') },
          { name: 'reported', label: tr({ ar: 'المبلغ عنها', en: 'Reported' }), type: 'checkbox' },
        ]}
        columns={[
          { key: 'rating', label: { ar: 'التقييم', en: 'Rating' }, render: (r) => '★'.repeat(r.rating) + '☆'.repeat(5 - r.rating) },
          { key: 'comment', label: { ar: 'التعليق', en: 'Comment' } },
          { key: 'reportedCount', label: { ar: 'البلاغات', en: 'Reports' } },
          { key: 'status', label: { ar: 'الحالة', en: 'Status' }, render: (r) => <Badge group="review" value={r.status} /> },
          { key: 'moderationReason', label: { ar: 'سبب الإدارة', en: 'Moderation reason' } },
          { key: 'createdAt', label: { ar: 'التاريخ', en: 'Date' }, render: (r) => <DateTime value={r.createdAt} /> },
          { key: 'actions', label: '', render: (r) => (
            <div className="row gap">
              {r.status !== 'published' && <ActionButton label={tr({ ar: 'نشر', en: 'Publish' })} fields={[reasonField()]} run={(api, v) => api.post(`/v1/admin/reviews/${r.id}/moderate`, { action: 'publish', ...v })} />}
              {r.status !== 'hidden' && <ActionButton variant="danger" label={tr({ ar: 'إخفاء', en: 'Hide' })} fields={[reasonField()]} run={(api, v) => api.post(`/v1/admin/reviews/${r.id}/moderate`, { action: 'hide', ...v })} />}
            </div>
          ) },
        ]}
      />
    </Page>
  );
}
