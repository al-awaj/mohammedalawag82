'use client';
import { useRouter } from 'next/navigation';
import { enumLabel } from '@events/shared';
import { useApp, useGet, useSession, useTr } from '@events/web-kit/client';
import { ActionButton, Badge, DataTable, DateTime, ErrorBox, Loading, Money, Notice, Page } from '@events/web-kit/ui';
import { eventBody, eventFields, useCountryCurrencies, type EventSummary } from '@/lib/events';

export default function Events() {
  const tr = useTr();
  const { lang } = useApp();
  const router = useRouter();
  const currencies = useCountryCurrencies();
  const session = useSession().data;
  const { data, error, isLoading } = useGet<EventSummary[]>('/v1/events');
  return (
    <Page title={tr({ ar: 'مناسباتي', en: 'My events' })} actions={
      <ActionButton variant="primary" label={tr({ ar: 'مناسبة جديدة', en: 'New event' })} fields={eventFields(lang, currencies)}
        run={(api, v) => api.post<{ id: string }>('/v1/events', { ...eventBody(v, false), countryCode: session?.countryCode })}
        onDone={(r) => router.push(`/account/events/${(r as { id: string }).id}`)} />
    }>
      <Notice>{tr({
        ar: 'نظّم خدمات مناسبتك في مكان واحد: اربط كل خدمة بالمناسبة من السلة أو من صفحة الحجز، وتابع الإجمالي والمدفوع والمتبقي مقابل ميزانيتك.',
        en: 'Organise your occasion in one place: link each service to the event from the cart or the booking page, and follow totals, payments and balance against your budget.',
      })}</Notice>
      <ErrorBox error={error} />
      {isLoading ? <Loading /> : <DataTable rows={data ?? []} rowHref={(e) => `/account/events/${e.id}`} columns={[
        { key: 'name', label: { ar: 'المناسبة', en: 'Event' } },
        { key: 'eventType', label: { ar: 'النوع', en: 'Type' }, render: (e) => enumLabel('eventType', e.eventType, lang) },
        { key: 'eventDate', label: { ar: 'التاريخ', en: 'Date' }, render: (e) => <DateTime value={e.eventDate} dateOnly /> },
        { key: 'city', label: { ar: 'المدينة', en: 'City' } },
        { key: 'bookingCount', label: { ar: 'الخدمات', en: 'Services' } },
        { key: 'budgetAmount', label: { ar: 'الميزانية', en: 'Budget' }, render: (e) => (e.budgetAmount ? <Money amount={e.budgetAmount} currency={e.budgetCurrency} /> : '—') },
        { key: 'status', label: { ar: 'الحالة', en: 'Status' }, render: (e) => <Badge group="event" value={e.status} /> },
      ]} />}
    </Page>
  );
}
