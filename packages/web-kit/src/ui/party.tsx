'use client';
import Link from 'next/link';
import { ENUMS, localized } from '@events/shared';
import { useAction, useApp, useGet, useTr } from '../client';
import { ActionButton, type FieldSpec } from './forms';
import { ApiLink, Badge, Button, Card, DateTime, Detail, Empty, ErrorBox, Loading, Money, Notice, Page } from './basics';
import { DataTable } from './list';

/** Screens shared by customers and providers: in-app notifications and their disputes/complaints. */

type Notification = { id: string; type: string; subject: string | null; body: string | null; payload: Record<string, unknown>; createdAt: string; readAt: string | null };

export function NotificationsPage() {
  const tr = useTr();
  const { data, error, isLoading } = useGet<{ unread: number; items: Notification[] }>('/v1/me/notifications', { limit: 100 });
  const read = useAction((api, id: string) => api.post(`/v1/me/notifications/${id}/read`));
  const readAll = useAction((api) => api.post('/v1/me/notifications/read-all'));
  return (
    <Page title={tr({ ar: 'الإشعارات', en: 'Notifications' })} actions={data && data.unread > 0 && <Button variant="secondary" onClick={() => readAll.mutate(undefined)}>{tr({ ar: 'تعليم الكل كمقروء', en: 'Mark all as read' })}</Button>}>
      <ErrorBox error={error} />
      {isLoading ? <Loading /> : !data?.items.length ? <Empty /> : data.items.map((n) => (
        <div key={n.id} className="card" style={{ opacity: n.readAt ? 0.7 : 1 }}>
          <div className="row between">
            <strong>{n.subject ?? n.type}</strong>
            <span className="muted small"><DateTime value={n.createdAt} /></span>
          </div>
          {n.body && <p style={{ margin: '6px 0' }}>{n.body}</p>}
          {!n.readAt && <Button variant="ghost" onClick={() => read.mutate(n.id)}>{tr({ ar: 'تعليم كمقروء', en: 'Mark as read' })}</Button>}
        </div>
      ))}
    </Page>
  );
}

export const DISPUTE_TYPES = ['service_not_delivered', 'service_quality', 'billing', 'refund', 'damage', 'behaviour', 'other'];

/** Fields to open a dispute about a booking, or a complaint to the administration without one. */
export function disputeFields(withBooking: boolean): FieldSpec[] {
  return [
    ...(withBooking ? [] : [{ name: 'kind', label: { ar: 'النوع', en: 'Kind' }, type: 'select', required: true, defaultValue: 'complaint',
      options: [{ value: 'complaint', label: { ar: 'شكوى للإدارة', en: 'Complaint to the administration' } }] } as FieldSpec]),
    { name: 'type', label: { ar: 'الموضوع', en: 'Topic' }, type: 'select', required: true, options: DISPUTE_TYPES.map((v) => ({ value: v, label: ENUMS.disputeType?.[v] ?? v })) },
    { name: 'subject', label: { ar: 'العنوان', en: 'Subject' }, required: true },
    { name: 'description', label: { ar: 'التفاصيل (10 أحرف على الأقل)', en: 'Details (at least 10 characters)' }, type: 'textarea', required: true },
    ...(withBooking ? [{ name: 'disputedAmount', label: { ar: 'المبلغ محل النزاع (اختياري)', en: 'Amount in dispute (optional)' }, type: 'decimal' } as FieldSpec] : []),
  ];
}

type Dispute = { id: string; number: string; kind: string; bookingId: string | null; bookingNumber: string | null; type: string; subject: string; status: string; disputedAmount: string | null; currency: string | null; createdAt: string };

export function DisputesPage({ base = '/disputes' }: { base?: string }) {
  const tr = useTr();
  const { data, error, isLoading } = useGet<Dispute[]>('/v1/disputes');
  return (
    <Page title={tr({ ar: 'النزاعات والشكاوى', en: 'Disputes & complaints' })} actions={
      <ActionButton label={tr({ ar: 'شكوى للإدارة', en: 'Complaint to the administration' })} fields={disputeFields(false)}
        run={(api, v) => api.post('/v1/disputes', v)} />
    }>
      <Notice>{tr({ ar: 'تُدار النزاعات عبر الإدارة؛ لا توجد محادثة مباشرة بين العميل وصاحب الخدمة. لفتح نزاع على حجز، افتحه من صفحة الحجز.', en: 'Disputes are handled by the administration; there is no direct chat between customer and provider. To dispute a booking, open it from the booking page.' })}</Notice>
      <ErrorBox error={error} />
      {isLoading ? <Loading /> : (
        <DataTable rows={data ?? []} rowHref={(d) => `${base}/${d.id}`} columns={[
          { key: 'number', label: { ar: 'الرقم', en: 'Number' } },
          { key: 'subject', label: { ar: 'العنوان', en: 'Subject' } },
          { key: 'type', label: { ar: 'الموضوع', en: 'Topic' }, render: (d) => <Badge group="disputeType" value={d.type} /> },
          { key: 'bookingNumber', label: { ar: 'الحجز', en: 'Booking' } },
          { key: 'status', label: { ar: 'الحالة', en: 'Status' }, render: (d) => <Badge group="dispute" value={d.status} /> },
          { key: 'createdAt', label: { ar: 'التاريخ', en: 'Date' }, render: (d) => <DateTime value={d.createdAt} /> },
        ]} />
      )}
    </Page>
  );
}

type DisputeDetail = Dispute & {
  description: string; myRole: string; heldAmount: string; decision: Record<string, unknown> | null;
  events: { action: string; actorRole: string; from: string | null; to: string | null; note: string | null; at: string }[];
  evidence: { id: string; partyRole: string; mimeType: string; description: string | null; createdAt: string }[];
};

export function DisputeDetailPage({ id, bookingHref }: { id: string; bookingHref?: (bookingId: string) => string }) {
  const tr = useTr();
  const { data: d, error, isLoading } = useGet<DisputeDetail>(`/v1/disputes/${id}`);
  if (isLoading) return <Loading />;
  if (error || !d) return <ErrorBox error={error} />;
  const open = !['settled', 'closed', 'rejected', 'resolution_approved'].includes(d.status);
  return (
    <Page title={`${d.kind === 'complaint' ? tr({ ar: 'شكوى', en: 'Complaint' }) : tr({ ar: 'نزاع', en: 'Dispute' })} ${d.number}`} actions={<>
      <ApiLink path={`/v1/disputes/${id}/record?format=html&lang=ar`}>{tr({ ar: 'طباعة السجل', en: 'Print record' })}</ApiLink>
      {open && <ActionButton label={tr({ ar: 'إضافة إفادة', en: 'Add a statement' })} fields={[{ name: 'note', label: { ar: 'الإفادة (تصل للإدارة)', en: 'Statement (sent to the administration)' }, type: 'textarea', required: true }]}
        run={(api, v) => api.post(`/v1/disputes/${id}/statements`, v)} />}
      {open && <ActionButton label={tr({ ar: 'رفع دليل', en: 'Upload evidence' })} fields={[
        { name: 'description', label: { ar: 'وصف الدليل', en: 'Description' } },
        { name: 'file', label: { ar: 'الملف (صورة أو PDF)', en: 'File (image or PDF)' }, type: 'file', required: true }]}
        run={(api, v) => { const f = new FormData(); if (v.description) f.append('description', String(v.description)); f.append('file', v.file as File); return api.upload(`/v1/disputes/${id}/evidence`, f); }} />}
    </>}>
      <Card>
        <Detail items={[
          [tr({ ar: 'الحالة', en: 'Status' }), <Badge key="s" group="dispute" value={d.status} />],
          [tr({ ar: 'الموضوع', en: 'Topic' }), <Badge key="t" group="disputeType" value={d.type} />],
          [tr({ ar: 'الحجز', en: 'Booking' }), d.bookingId && bookingHref ? <Link key="b" href={bookingHref(d.bookingId)}>{d.bookingNumber}</Link> : d.bookingNumber],
          [tr({ ar: 'صفتك', en: 'Your role' }), d.myRole],
          [tr({ ar: 'المبلغ محل النزاع', en: 'Amount in dispute' }), <Money key="a" amount={d.disputedAmount} currency={d.currency} />],
          [tr({ ar: 'تاريخ الفتح', en: 'Opened' }), <DateTime key="o" value={d.createdAt} />],
        ]} />
        <h2 style={{ marginTop: 16 }}>{d.subject}</h2>
        <p>{d.description}</p>
        {d.decision && <Notice>{tr({ ar: 'القرار:', en: 'Decision:' })} {String(d.decision.outcome ?? '')} — {String(d.decision.rationale ?? '')}</Notice>}
      </Card>
      <Card title={tr({ ar: 'السجل', en: 'Timeline' })}>
        <DataTable rows={d.events.map((e, i) => ({ ...e, id: String(i) }))} columns={[
          { key: 'at', label: { ar: 'الوقت', en: 'Time' }, render: (e) => <DateTime value={e.at} /> },
          { key: 'actorRole', label: { ar: 'الطرف', en: 'By' } },
          { key: 'to', label: { ar: 'الحالة', en: 'Status' }, render: (e) => (e.to ? <Badge group="dispute" value={e.to} /> : '—') },
          { key: 'note', label: { ar: 'الملاحظة', en: 'Note' } },
        ]} />
      </Card>
      <Card title={tr({ ar: 'الأدلة', en: 'Evidence' })}>
        <DataTable rows={d.evidence} columns={[
          { key: 'partyRole', label: { ar: 'من', en: 'From' } },
          { key: 'description', label: { ar: 'الوصف', en: 'Description' }, render: (e) => <a href={`/bff/v1/disputes/${id}/evidence/${e.id}`} target="_blank" rel="noopener noreferrer">{e.description ?? e.mimeType}</a> },
          { key: 'createdAt', label: { ar: 'التاريخ', en: 'Date' }, render: (e) => <DateTime value={e.createdAt} /> },
        ]} />
      </Card>
    </Page>
  );
}

/** Issued documents of the signed-in customer or provider, with printable versions. */
export function MyDocumentsPage() {
  const tr = useTr();
  const { lang } = useApp();
  const { data, error, isLoading } = useGet<{ id: string; number: string; kind: string; currency: string; total: string; issuedAt: string }[]>('/v1/documents', { limit: 200 });
  return (
    <Page title={tr({ ar: 'الفواتير والإيصالات', en: 'Invoices & receipts' })}>
      <ErrorBox error={error} />
      {isLoading ? <Loading /> : (
        <DataTable rows={data ?? []} columns={[
          { key: 'number', label: { ar: 'الرقم', en: 'Number' }, render: (d) => <code>{d.number}</code> },
          { key: 'kind', label: { ar: 'النوع', en: 'Kind' }, render: (d) => <Badge group="document" value={d.kind} /> },
          { key: 'total', label: { ar: 'المبلغ', en: 'Amount' }, render: (d) => <Money amount={d.total} currency={d.currency} /> },
          { key: 'issuedAt', label: { ar: 'التاريخ', en: 'Date' }, render: (d) => <DateTime value={d.issuedAt} /> },
          { key: 'print', label: '', render: (d) => <a href={`/bff/v1/documents/${d.id}?format=html&lang=${lang}`} target="_blank" rel="noopener noreferrer">{tr({ ar: 'عرض وطباعة', en: 'View & print' })}</a> },
        ]} />
      )}
    </Page>
  );
}

