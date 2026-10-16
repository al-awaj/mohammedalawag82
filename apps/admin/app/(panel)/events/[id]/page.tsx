'use client';
import { use } from 'react';
import { enumLabel, formatDateTime, localized } from '@events/shared';
import { useApp, useGet, useTr } from '@events/web-kit/client';
import { Badge, Card, DataTable, DateTime, Detail, ErrorBox, Loading, Money, Notice, Page } from '@events/web-kit/ui';

interface EventDetail {
  id: string; name: string; eventType: string; countryCode: string; city: string; location: string | null; eventDate: string; startsAt: string | null; endsAt: string | null;
  expectedGuests: number | null; notes: string | null; status: string; createdAt: string; customer: { id: string; name: string; phone: string | null };
  bookings: { id: string; number: string; status: string; serviceTitle: Record<string, string>; startAt: string; total: string; paidAmount: string; remainingAmount: string; currency: string }[];
  totals: Record<string, { committedTotal: string; paidTotal: string; remainingTotal: string; bookings: number }>;
  budget: { amount: string; currency: string; committed: string; remaining: string; overBudget: boolean; otherCurrencies: string[] } | null;
}

/** Read-only view of a customer's event for support and bookings staff (clause 7). */
export default function EventPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const tr = useTr();
  const { lang } = useApp();
  const { data: e, error, isLoading } = useGet<EventDetail>(`/v1/admin/events/${id}`);
  if (isLoading) return <Loading />;
  if (error || !e) return <ErrorBox error={error} />;
  return (
    <Page title={e.name}>
      <Card>
        <Detail items={[
          [tr({ ar: 'العميل', en: 'Customer' }), `${e.customer.name}${e.customer.phone ? ` · ${e.customer.phone}` : ''}`],
          [tr({ ar: 'النوع', en: 'Type' }), enumLabel('eventType', e.eventType, lang)],
          [tr({ ar: 'الحالة', en: 'Status' }), <Badge key="s" group="event" value={e.status} />],
          [tr({ ar: 'التاريخ', en: 'Date' }), <DateTime key="d" value={e.eventDate} dateOnly />],
          [tr({ ar: 'الوقت', en: 'Time' }), e.startsAt ? `${formatDateTime(e.startsAt, lang)}${e.endsAt ? ` → ${formatDateTime(e.endsAt, lang)}` : ''}` : '—'],
          [tr({ ar: 'المكان', en: 'Place' }), [`${e.city} (${e.countryCode})`, e.location].filter(Boolean).join(' · ')],
          [tr({ ar: 'الضيوف المتوقعون', en: 'Expected guests' }), e.expectedGuests ?? '—'],
          [tr({ ar: 'ملاحظات العميل', en: 'Customer notes' }), e.notes ?? '—'],
        ]} />
      </Card>
      {e.budget && <Card title={tr({ ar: 'الميزانية', en: 'Budget' })}>
        <Detail items={[
          [tr({ ar: 'الميزانية', en: 'Budget' }), <Money key="a" amount={e.budget.amount} currency={e.budget.currency} />],
          [tr({ ar: 'المحجوز', en: 'Committed' }), <Money key="c" amount={e.budget.committed} currency={e.budget.currency} />],
          [tr({ ar: 'المتبقي', en: 'Left' }), <Money key="r" amount={e.budget.remaining} currency={e.budget.currency} />],
        ]} />
        {e.budget.overBudget && <Notice kind="warning">{tr({ ar: 'الحجوزات تجاوزت الميزانية.', en: 'Bookings exceed the budget.' })}</Notice>}
      </Card>}
      <Card title={tr({ ar: 'الحجوزات المرتبطة', en: 'Linked bookings' })}>
        <DataTable rows={e.bookings} rowHref={(b) => `/bookings/${b.id}`} columns={[
          { key: 'number', label: { ar: 'الحجز', en: 'Booking' } },
          { key: 'serviceTitle', label: { ar: 'الخدمة', en: 'Service' }, render: (b) => localized(b.serviceTitle, lang) },
          { key: 'startAt', label: { ar: 'الموعد', en: 'When' }, render: (b) => <DateTime value={b.startAt} /> },
          { key: 'status', label: { ar: 'الحالة', en: 'Status' }, render: (b) => <Badge group="booking" value={b.status} /> },
          { key: 'total', label: { ar: 'الإجمالي', en: 'Total' }, render: (b) => <Money amount={b.total} currency={b.currency} /> },
          { key: 'paidAmount', label: { ar: 'المدفوع', en: 'Paid' }, render: (b) => <Money amount={b.paidAmount} currency={b.currency} /> },
          { key: 'remainingAmount', label: { ar: 'المتبقي', en: 'Remaining' }, render: (b) => <Money amount={b.remainingAmount} currency={b.currency} /> },
        ]} />
      </Card>
    </Page>
  );
}
