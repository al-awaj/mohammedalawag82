'use client';
import Link from 'next/link';
import { use } from 'react';
import { useCan, useGet, useTr } from '@events/web-kit/client';
import { ActionButton, ApiLink, Badge, Card, DataTable, DateTime, Detail, ErrorBox, Json, Loading, Money, Notice, Page } from '@events/web-kit/ui';

interface Dispute {
  id: string; number: string; kind: string; bookingId: string | null; bookingNumber: string | null; type: string; subject: string; description: string;
  complainantRole: string; respondentRole: string | null; disputedAmount: string | null; currency: string | null; heldAmount: string; status: string;
  decision: Record<string, unknown> | null; decidedAt: string | null; closedAt: string | null; createdAt: string; assignedTo: string | null;
  events: { action: string; actorRole: string; from: string | null; to: string | null; note: string | null; visibility: string; at: string }[];
  evidence: { id: string; partyRole: string; mimeType: string; sizeBytes: number; description: string | null; shared: boolean; createdAt: string }[];
  refunds: { id: string; number: string; amount: string; status: string }[];
}
const OPEN = ['new', 'under_review', 'awaiting_info', 'awaiting_response', 'deciding'];

export default function DisputePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const tr = useTr();
  const can = useCan();
  const { data: d, error, isLoading } = useGet<Dispute>(`/v1/admin/disputes/${id}`);
  const staff = useGet<{ id: string; fullName: string; status: string }[]>(can('users.view') ? '/v1/admin/staff' : null).data ?? [];
  if (isLoading) return <Loading />;
  if (error || !d) return <ErrorBox error={error} />;
  const act = (action: string, label: { ar: string; en: string }, fields: Parameters<typeof ActionButton>[0]['fields'] = []) => (
    <ActionButton key={action} label={tr(label)} fields={fields} run={(api, v) => api.post(`/v1/admin/disputes/${id}/actions`, { action, ...v })} />
  );
  const note = (required: boolean) => ({ name: 'note', label: { ar: 'الملاحظة', en: 'Note' }, type: 'textarea' as const, required });
  const review = can('disputes.review');
  const decide = can('disputes.decide');
  return (
    <Page title={`${d.kind === 'complaint' ? tr({ ar: 'شكوى', en: 'Complaint' }) : tr({ ar: 'نزاع', en: 'Dispute' })} ${d.number}`} actions={<>
      <ApiLink path={`/v1/disputes/${id}/record?format=html&lang=ar`}>{tr({ ar: 'طباعة السجل', en: 'Print record' })}</ApiLink>
      {review && d.status === 'new' && act('start_review', { ar: 'بدء المراجعة', en: 'Start review' })}
      {review && ['new', 'under_review', 'deciding'].includes(d.status) && act('request_info', { ar: 'طلب معلومات', en: 'Request information' }, [
        note(true), { name: 'from', label: { ar: 'من', en: 'From' }, type: 'select', options: [{ value: 'customer', label: { ar: 'العميل', en: 'Customer' } }, { value: 'provider', label: { ar: 'صاحب الخدمة', en: 'Provider' } }] }])}
      {review && d.respondentRole && ['new', 'under_review', 'deciding'].includes(d.status) && act('request_response', { ar: 'طلب رد الطرف الآخر', en: 'Request response' }, [note(true)])}
      {review && ['under_review', 'awaiting_info', 'awaiting_response'].includes(d.status) && act('to_decision', { ar: 'إحالة للقرار', en: 'Send to decision' }, [note(false)])}
      {review && OPEN.includes(d.status) && staff.length > 0 && act('assign', { ar: 'إسناد', en: 'Assign' }, [
        { name: 'assignee', label: { ar: 'الموظف', en: 'Staff member' }, type: 'select', required: true, options: staff.filter((s) => s.status === 'active').map((s) => ({ value: s.id, label: s.fullName })) }])}
      {review && act('note', { ar: 'ملاحظة داخلية', en: 'Internal note' }, [note(true)])}
      {decide && d.bookingId && OPEN.includes(d.status) && (
        <ActionButton label={tr({ ar: 'تعليق المبلغ', en: 'Hold amount' })}
          note={tr({ ar: 'يُعلق مبلغ هذا الحجز فقط ولا تُجمد بقية مستحقات صاحب الخدمة.', en: 'Only this booking’s amount is held; the provider’s other earnings are not frozen.' })}
          fields={[{ name: 'amount', label: { ar: 'المبلغ', en: 'Amount' }, type: 'decimal', required: true, defaultValue: d.disputedAmount ?? undefined }]}
          run={(api, v) => api.post(`/v1/admin/disputes/${id}/hold`, v)} />
      )}
      {decide && d.status === 'deciding' && (
        <ActionButton variant="primary" label={tr({ ar: 'إصدار القرار', en: 'Decide' })} fields={[
          { name: 'outcome', label: { ar: 'النتيجة', en: 'Outcome' }, type: 'select', required: true, options: [{ value: 'approve', label: { ar: 'قبول', en: 'Approve' } }, { value: 'reject', label: { ar: 'رفض', en: 'Reject' } }] },
          { name: 'rationale', label: { ar: 'المبررات', en: 'Rationale' }, type: 'textarea', required: true },
          { name: 'refundAmount', label: { ar: 'مبلغ الاسترداد (إن وجد)', en: 'Refund amount (if any)' }, type: 'decimal' },
          { name: 'chargeTo', label: { ar: 'يُحمّل على (بعد تقديم الخدمة)', en: 'Charged to (after delivery)' }, type: 'select', options: [{ value: 'provider', label: { ar: 'صاحب الخدمة', en: 'Provider' } }, { value: 'platform', label: { ar: 'المنصة (حتى عمولتها)', en: 'Platform (up to its commission)' } }] },
        ]} run={(api, v) => api.post(`/v1/admin/disputes/${id}/decide`, v)} />
      )}
      {decide && d.status === 'resolution_approved' && (
        <ActionButton variant="primary" label={tr({ ar: 'تنفيذ التسوية', en: 'Settle' })}
          note={tr({ ar: 'تُنشأ طلبات الاسترداد المعتمدة وتحتاج اعتمادًا ماليًا من موظف آخر.', en: 'Refund requests are created and need financial approval by another staff member.' })}
          run={(api) => api.post(`/v1/admin/disputes/${id}/settle`)} />
      )}
      {review && ['settled', 'rejected'].includes(d.status) && act('close', { ar: 'إغلاق', en: 'Close' }, [note(false)])}
    </>}>
      <Card>
        <Detail items={[
          [tr({ ar: 'الحالة', en: 'Status' }), <Badge key="s" group="dispute" value={d.status} />],
          [tr({ ar: 'النوع', en: 'Type' }), <Badge key="t" group="disputeType" value={d.type} />],
          [tr({ ar: 'الحجز', en: 'Booking' }), d.bookingId ? <Link key="b" href={`/bookings/${d.bookingId}`}>{d.bookingNumber}</Link> : '—'],
          [tr({ ar: 'مقدم من', en: 'Raised by' }), d.complainantRole],
          [tr({ ar: 'الطرف الآخر', en: 'Other party' }), d.respondentRole ?? '—'],
          [tr({ ar: 'المبلغ محل النزاع', en: 'Disputed amount' }), <Money key="a" amount={d.disputedAmount} currency={d.currency} />],
          [tr({ ar: 'المبلغ المعلق', en: 'Held' }), <Money key="h" amount={d.heldAmount} currency={d.currency} />],
          [tr({ ar: 'تاريخ الفتح', en: 'Opened' }), <DateTime key="o" value={d.createdAt} />],
        ]} />
        <h2 style={{ marginTop: 16 }}>{d.subject}</h2>
        <p>{d.description}</p>
      </Card>
      {d.decision && <Card title={tr({ ar: 'القرار', en: 'Decision' })}><Json value={d.decision} /></Card>}
      <Card title={tr({ ar: 'الأدلة', en: 'Evidence' })}>
        <Notice>{tr({ ar: 'الأدلة لا تُحذف ولا تُعدل؛ مشاركتها مع الطرف الآخر قرار موثق.', en: 'Evidence cannot be deleted or changed; sharing it with the other party is a recorded decision.' })}</Notice>
        <DataTable rows={d.evidence} columns={[
          { key: 'partyRole', label: { ar: 'من', en: 'From' } },
          { key: 'description', label: { ar: 'الوصف', en: 'Description' }, render: (e) => <a href={`/bff/v1/disputes/${id}/evidence/${e.id}`} target="_blank" rel="noopener noreferrer">{e.description ?? e.mimeType}</a> },
          { key: 'createdAt', label: { ar: 'التاريخ', en: 'Date' }, render: (e) => <DateTime value={e.createdAt} /> },
          { key: 'shared', label: { ar: 'مشترك', en: 'Shared' } },
          { key: 'share', label: '', render: (e) => review ? (
            <ActionButton label={e.shared ? tr({ ar: 'إلغاء المشاركة', en: 'Unshare' }) : tr({ ar: 'مشاركة مع الطرف الآخر', en: 'Share with other party' })}
              fields={[{ name: 'reason', label: { ar: 'السبب', en: 'Reason' }, type: 'textarea', required: true }]}
              run={(api, v) => api.post(`/v1/admin/disputes/${id}/evidence/${e.id}/share`, { shared: !e.shared, ...v })} />
          ) : null },
        ]} />
      </Card>
      <Card title={tr({ ar: 'السجل', en: 'Timeline' })}>
        <DataTable rows={d.events.map((e, i) => ({ ...e, id: String(i) }))} columns={[
          { key: 'at', label: { ar: 'الوقت', en: 'Time' }, render: (e) => <DateTime value={e.at} /> },
          { key: 'actorRole', label: { ar: 'الطرف', en: 'Actor' } },
          { key: 'action', label: { ar: 'الإجراء', en: 'Action' } },
          { key: 'to', label: { ar: 'الحالة', en: 'Status' }, render: (e) => (e.to ? <Badge group="dispute" value={e.to} /> : '—') },
          { key: 'note', label: { ar: 'الملاحظة', en: 'Note' } },
          { key: 'visibility', label: { ar: 'الظهور', en: 'Visibility' } },
        ]} />
      </Card>
      {d.refunds.length > 0 && (
        <Card title={tr({ ar: 'الاستردادات', en: 'Refunds' })}>
          <DataTable rows={d.refunds} rowHref={(r) => `/refunds/${r.id}`} columns={[
            { key: 'number', label: { ar: 'الرقم', en: 'Number' } },
            { key: 'amount', label: { ar: 'المبلغ', en: 'Amount' }, render: (r) => <Money amount={r.amount} currency={d.currency} /> },
            { key: 'status', label: { ar: 'الحالة', en: 'Status' }, render: (r) => <Badge group="refund" value={r.status} /> },
          ]} />
        </Card>
      )}
    </Page>
  );
}
