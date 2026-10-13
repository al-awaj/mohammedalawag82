'use client';
import { useGet, useSession, useTr } from '@events/web-kit/client';
import { ActionButton, DataTable, DateTime, ErrorBox, Loading, Notice, Page } from '@events/web-kit/ui';

type Ev = { id: string; name: string; eventType: string; city: string | null; eventDate: string | null; expectedGuests: number | null; status: string };

export default function Events() {
  const tr = useTr();
  const session = useSession().data;
  const { data, error, isLoading } = useGet<Ev[]>('/v1/events');
  return (
    <Page title={tr({ ar: 'مناسباتي', en: 'My events' })} actions={
      <ActionButton variant="primary" label={tr({ ar: 'مناسبة جديدة', en: 'New event' })} fields={[
        { name: 'name', label: { ar: 'اسم المناسبة', en: 'Event name' }, required: true },
        { name: 'eventType', label: { ar: 'النوع', en: 'Type' }, type: 'select', required: true, options: [
          { value: 'wedding', label: { ar: 'زفاف', en: 'Wedding' } }, { value: 'engagement', label: { ar: 'خطوبة', en: 'Engagement' } }, { value: 'birthday', label: { ar: 'عيد ميلاد', en: 'Birthday' } },
          { value: 'graduation', label: { ar: 'تخرج', en: 'Graduation' } }, { value: 'success', label: { ar: 'نجاح', en: 'Success celebration' } }, { value: 'family', label: { ar: 'مناسبة عائلية', en: 'Family' } },
          { value: 'conference', label: { ar: 'مؤتمر', en: 'Conference' } }, { value: 'official', label: { ar: 'مناسبة رسمية', en: 'Official' } }, { value: 'religious', label: { ar: 'مناسبة دينية', en: 'Religious' } },
          { value: 'social', label: { ar: 'اجتماعية', en: 'Social' } }, { value: 'other', label: { ar: 'أخرى', en: 'Other' } }] },
        { name: 'city', label: { ar: 'المدينة', en: 'City' }, required: true },
        { name: 'eventDate', label: { ar: 'التاريخ', en: 'Date' }, type: 'date', required: true },
        { name: 'expectedGuests', label: { ar: 'عدد الضيوف المتوقع', en: 'Expected guests' }, type: 'number' },
        { name: 'notes', label: { ar: 'ملاحظات', en: 'Notes' }, type: 'textarea' },
      ]} run={(api, v) => api.post('/v1/events', { ...v, countryCode: session?.countryCode })} />
    }>
      <Notice>{tr({ ar: 'نظّم خدمات مناسبتك في مكان واحد: عند الحجز يمكنك ربط الخدمة بمناسبة.', en: 'Organise your occasion’s services in one place.' })}</Notice>
      <ErrorBox error={error} />
      {isLoading ? <Loading /> : <DataTable rows={data ?? []} columns={[
        { key: 'name', label: { ar: 'المناسبة', en: 'Event' } },
        { key: 'eventType', label: { ar: 'النوع', en: 'Type' } },
        { key: 'city', label: { ar: 'المدينة', en: 'City' } },
        { key: 'eventDate', label: { ar: 'التاريخ', en: 'Date' }, render: (e) => <DateTime value={e.eventDate} dateOnly /> },
        { key: 'expectedGuests', label: { ar: 'الضيوف', en: 'Guests' } },
        { key: 'status', label: { ar: 'الحالة', en: 'Status' } },
      ]} />}
    </Page>
  );
}
