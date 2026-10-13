'use client';
import Link from 'next/link';
import { use } from 'react';
import { enumLabel, formatDateTime, localized } from '@events/shared';
import { useAction, useApp, useGet, useTr } from '@events/web-kit/client';
import { ActionButton, Badge, Button, Card, DataTable, DateTime, Detail, Empty, ErrorBox, Loading, Money, Notice, Page } from '@events/web-kit/ui';
import { eventBody, eventFields, useCountryCurrencies } from '@/lib/events';

interface EventBooking { id: string; number: string; status: string; serviceTitle: Record<string, string>; startAt: string; total: string; upfrontAmount: string; paidAmount: string; remainingAmount: string; currency: string }
interface EventDetail {
  id: string; name: string; eventType: string; countryCode: string; city: string; location: string | null; eventDate: string; startsAt: string | null; endsAt: string | null;
  expectedGuests: number | null; budgetAmount: string | null; budgetCurrency: string | null; notes: string | null; status: string;
  bookings: EventBooking[];
  totals: Record<string, { committedTotal: string; upfrontTotal: string; paidTotal: string; remainingTotal: string; bookings: number }>;
  budget: { amount: string; currency: string; committed: string; remaining: string; overBudget: boolean; otherCurrencies: string[] } | null;
}
type MyBooking = { id: string; number: string; status: string; serviceTitle: Record<string, string>; startAt: string; eventId: string | null };

export default function EventPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const tr = useTr();
  const { lang } = useApp();
  const currencies = useCountryCurrencies();
  const { data: e, error, isLoading } = useGet<EventDetail>(`/v1/events/${id}`);
  const mine = useGet<MyBooking[]>('/v1/bookings', { when: 'all', limit: 200 });
  const unlink = useAction((api, bookingId: string) => api.put(`/v1/bookings/${bookingId}/event`, { eventId: null }));
  if (isLoading) return <Loading />;
  if (error || !e) return <ErrorBox error={error} />;
  const linkable = (mine.data ?? []).filter((b) => !b.eventId && !['expired', 'rejected', 'cancelled_by_customer', 'cancelled_by_provider', 'cancelled_by_admin'].includes(b.status));
  const usedPercent = e.budget ? Math.min(100, Math.round((Number(e.budget.committed) / Math.max(Number(e.budget.amount), 0.0001)) * 100)) : 0;
  return (
    <Page title={e.name} actions={<>
      <ActionButton label={tr({ ar: 'تعديل المناسبة', en: 'Edit event' })} fields={eventFields(lang, currencies, e as unknown as Record<string, unknown>, true)}
        run={(api, v) => api.patch(`/v1/events/${id}`, eventBody(v, true))} />
      {e.status !== 'cancelled' && linkable.length > 0 && (
        <ActionButton variant="primary" label={tr({ ar: 'إضافة حجز للمناسبة', en: 'Add a booking' })} fields={[{
          name: 'bookingId', label: { ar: 'الحجز', en: 'Booking' }, type: 'select', required: true,
          options: linkable.map((b) => ({ value: b.id, label: { ar: `${b.number} · ${localized(b.serviceTitle, 'ar')} · ${formatDateTime(b.startAt, 'ar')}`, en: `${b.number} · ${localized(b.serviceTitle, 'en')} · ${formatDateTime(b.startAt, 'en')}` } })),
        }]} run={(api, v) => api.put(`/v1/bookings/${String(v.bookingId)}/event`, { eventId: id })} />
      )}
      <Link className="btn btn-secondary" href="/search">{tr({ ar: 'أضف خدمة جديدة', en: 'Find a service' })}</Link>
    </>}>
      <ErrorBox error={unlink.error} />
      <Card>
        <Detail items={[
          [tr({ ar: 'النوع', en: 'Type' }), enumLabel('eventType', e.eventType, lang)],
          [tr({ ar: 'الحالة', en: 'Status' }), <Badge key="s" group="event" value={e.status} />],
          [tr({ ar: 'التاريخ', en: 'Date' }), <DateTime key="d" value={e.eventDate} dateOnly />],
          [tr({ ar: 'الوقت', en: 'Time' }), e.startsAt ? `${formatDateTime(e.startsAt, lang)}${e.endsAt ? ` → ${formatDateTime(e.endsAt, lang)}` : ''}` : '—'],
          [tr({ ar: 'المكان', en: 'Place' }), [e.city, e.location].filter(Boolean).join(' · ')],
          [tr({ ar: 'الضيوف المتوقعون', en: 'Expected guests' }), e.expectedGuests ?? '—'],
          [tr({ ar: 'ملاحظات', en: 'Notes' }), e.notes ?? '—'],
        ]} />
      </Card>

      <Card title={tr({ ar: 'الميزانية', en: 'Budget' })}>
        {!e.budget ? <p className="muted">{tr({ ar: 'لم تُحدَّد ميزانية. يمكنك إضافتها من «تعديل المناسبة».', en: 'No budget set. Add one with “Edit event”.' })}</p> : <>
          <Detail items={[
            [tr({ ar: 'الميزانية', en: 'Budget' }), <Money key="a" amount={e.budget.amount} currency={e.budget.currency} />],
            [tr({ ar: 'المحجوز حتى الآن', en: 'Committed so far' }), <Money key="c" amount={e.budget.committed} currency={e.budget.currency} />],
            [tr({ ar: 'المتبقي من الميزانية', en: 'Left in budget' }), <Money key="r" amount={e.budget.remaining} currency={e.budget.currency} />],
          ]} />
          <div role="progressbar" aria-valuenow={usedPercent} aria-valuemin={0} aria-valuemax={100} className="budget-bar">
            <span style={{ width: `${usedPercent}%` }} className={e.budget.overBudget ? 'over' : ''} />
          </div>
          {e.budget.overBudget && <Notice kind="warning">{tr({ ar: 'تجاوزت الحجوزات ميزانية المناسبة.', en: 'Bookings have gone over the event budget.' })}</Notice>}
          {e.budget.otherCurrencies.length > 0 && <p className="small muted">{tr({ ar: 'حجوزات بعملات أخرى لا تُحوَّل تلقائيًا ولا تدخل في المقارنة:', en: 'Bookings in other currencies are not converted and not compared:' })} {e.budget.otherCurrencies.join('، ')}</p>}
        </>}
      </Card>

      {Object.keys(e.totals).length > 0 && (
        <Card title={tr({ ar: 'الإجمالي حسب العملة', en: 'Totals by currency' })}>
          <DataTable rowKey="currency" rows={Object.entries(e.totals).map(([currency, t]) => ({ currency, ...t }))} columns={[
            { key: 'currency', label: { ar: 'العملة', en: 'Currency' } },
            { key: 'bookings', label: { ar: 'الحجوزات', en: 'Bookings' } },
            { key: 'committedTotal', label: { ar: 'الإجمالي', en: 'Total' }, render: (t) => <Money amount={t.committedTotal} currency={t.currency} /> },
            { key: 'upfrontTotal', label: { ar: 'العربون', en: 'Deposits' }, render: (t) => <Money amount={t.upfrontTotal} currency={t.currency} /> },
            { key: 'paidTotal', label: { ar: 'المدفوع', en: 'Paid' }, render: (t) => <Money amount={t.paidTotal} currency={t.currency} /> },
            { key: 'remainingTotal', label: { ar: 'المتبقي', en: 'Remaining' }, render: (t) => <Money amount={t.remainingTotal} currency={t.currency} /> },
          ]} />
        </Card>
      )}

      <Card title={tr({ ar: 'خدمات المناسبة', en: 'Services for this event' })}>
        {!e.bookings.length ? <Empty>{tr({ ar: 'لا توجد خدمات مرتبطة بعد. اربطها من السلة أو من صفحة الحجز.', en: 'No services linked yet. Link them from the cart or a booking page.' })}</Empty> :
          <DataTable rows={e.bookings} rowHref={(b) => `/account/bookings/${b.id}`} columns={[
            { key: 'number', label: { ar: 'الحجز', en: 'Booking' } },
            { key: 'serviceTitle', label: { ar: 'الخدمة', en: 'Service' }, render: (b) => localized(b.serviceTitle, lang) },
            { key: 'startAt', label: { ar: 'الموعد', en: 'When' }, render: (b) => <DateTime value={b.startAt} /> },
            { key: 'status', label: { ar: 'الحالة', en: 'Status' }, render: (b) => <Badge group="booking" value={b.status} /> },
            { key: 'total', label: { ar: 'السعر', en: 'Price' }, render: (b) => <Money amount={b.total} currency={b.currency} /> },
            { key: 'paidAmount', label: { ar: 'المدفوع', en: 'Paid' }, render: (b) => <Money amount={b.paidAmount} currency={b.currency} /> },
            { key: 'remainingAmount', label: { ar: 'المتبقي', en: 'Remaining' }, render: (b) => <Money amount={b.remainingAmount} currency={b.currency} /> },
            { key: 'id', label: { ar: '', en: '' }, render: (b) => <Button variant="ghost" disabled={unlink.isPending} onClick={(ev) => { ev.preventDefault(); ev.stopPropagation(); unlink.mutate(b.id); }}>{tr({ ar: 'إزالة من المناسبة', en: 'Remove from event' })}</Button> },
          ]} />}
      </Card>
    </Page>
  );
}
