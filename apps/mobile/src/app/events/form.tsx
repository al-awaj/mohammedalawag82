import { useEffect, useState } from 'react';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { enumLabel, EVENT_STATUSES, EVENT_TYPES } from '@events/shared';
import { api } from '../../lib/api';
import { useAction, useGet, useSession } from '../../lib/session';
import { useTr } from '../../lib/i18n';
import { RequireLogin } from '../../components/require-login';
import { Button, Choice, ErrorText, Field, Loading, Notice, Screen } from '../../components/ui';

type Ev = { name: string; eventType: string; city: string; location: string | null; eventDate: string; startsAt: string | null; endsAt: string | null;
  expectedGuests: number | null; budgetAmount: string | null; budgetCurrency: string | null; notes: string | null; status: string };

export default function EventFormScreen() {
  return <RequireLogin><EventForm /></RequireLogin>;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Create or edit an event with every field of clause 24. Dates are typed as YYYY-MM-DD and times as HH:MM. */
function EventForm() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const tr = useTr();
  const { lang, user } = useSession();
  const existing = useGet<Ev>(id ? `/v1/events/${id}` : null);
  const countries = useGet<{ code: string; baseCurrency: string; currencies: string[] }[]>('/v1/countries');
  const country = countries.data?.find((c) => c.code === user?.countryCode);
  const currencies = country ? [...new Set([country.baseCurrency, ...country.currencies])] : [];
  const [f, setF] = useState({ name: '', eventType: 'wedding', city: '', location: '', eventDate: '', startTime: '', endTime: '', guests: '', budget: '', currency: '', notes: '', status: 'planning' });
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    const e = existing.data;
    if (!e) return;
    const t = (iso: string | null) => (iso ? new Date(iso).toTimeString().slice(0, 5) : '');
    setF({ name: e.name, eventType: e.eventType, city: e.city, location: e.location ?? '', eventDate: e.eventDate.slice(0, 10), startTime: t(e.startsAt), endTime: t(e.endsAt),
      guests: e.expectedGuests ? String(e.expectedGuests) : '', budget: e.budgetAmount ? String(Number(e.budgetAmount)) : '', currency: e.budgetCurrency ?? '', notes: e.notes ?? '', status: e.status });
  }, [existing.data]);
  const set = (k: keyof typeof f) => (v: string) => setF((x) => ({ ...x, [k]: v }));
  const save = useAction(async () => {
    const at = (time: string) => (time ? new Date(`${f.eventDate}T${time}:00`).toISOString() : null);
    const body: Record<string, unknown> = {
      name: f.name.trim(), eventType: f.eventType, city: f.city.trim(), location: f.location.trim() || null, eventDate: f.eventDate,
      startsAt: at(f.startTime), endsAt: at(f.endTime), expectedGuests: f.guests ? Number(f.guests) : null,
      budgetAmount: f.budget ? f.budget.trim() : null, budgetCurrency: f.budget ? (f.currency || currencies[0] || null) : null, notes: f.notes.trim() || null,
    };
    if (id) return api.patch<{ id: string }>(`/v1/events/${id}`, { ...body, status: f.status });
    return api.post<{ id: string }>('/v1/events', { ...body, countryCode: user?.countryCode });
  });
  if (id && existing.isLoading) return <Loading />;
  const submit = () => {
    if (f.name.trim().length < 2 || f.city.trim().length < 2) return setProblem(tr({ ar: 'الاسم والمدينة مطلوبان.', en: 'Name and city are required.' }));
    if (!DAY.test(f.eventDate)) return setProblem(tr({ ar: 'اكتب التاريخ بصيغة 2028-03-01.', en: 'Write the date as 2028-03-01.' }));
    if ((f.startTime && !TIME.test(f.startTime)) || (f.endTime && !TIME.test(f.endTime))) return setProblem(tr({ ar: 'اكتب الوقت بصيغة 18:30.', en: 'Write times as 18:30.' }));
    if (f.guests && !/^\d+$/.test(f.guests)) return setProblem(tr({ ar: 'عدد الضيوف رقم صحيح.', en: 'Guests must be a whole number.' }));
    if (f.budget && !/^\d+(\.\d{1,4})?$/.test(f.budget.trim())) return setProblem(tr({ ar: 'الميزانية رقم.', en: 'The budget must be a number.' }));
    setProblem(null);
    save.mutate(undefined, { onSuccess: (r) => router.replace(`/events/${id ?? r.id}`) });
  };
  return (
    <Screen>
      <Stack.Screen options={{ title: id ? tr({ ar: 'تعديل المناسبة', en: 'Edit event' }) : tr({ ar: 'مناسبة جديدة', en: 'New event' }) }} />
      <Field testID="event-name" label={tr({ ar: 'اسم المناسبة', en: 'Event name' })} value={f.name} onChangeText={set('name')} />
      <Choice testID="event-type" label={tr({ ar: 'نوع المناسبة', en: 'Occasion type' })} value={f.eventType}
        options={EVENT_TYPES.map((t) => ({ value: t, label: enumLabel('eventType', t, lang) }))} onChange={(v) => v && set('eventType')(v)} />
      <Field testID="event-city" label={tr({ ar: 'المدينة', en: 'City' })} value={f.city} onChangeText={set('city')} />
      <Field label={tr({ ar: 'الموقع أو العنوان', en: 'Venue or address' })} value={f.location} onChangeText={set('location')} />
      <Field testID="event-date" label={tr({ ar: 'التاريخ (2028-03-01)', en: 'Date (2028-03-01)' })} value={f.eventDate} onChangeText={set('eventDate')} />
      <Field label={tr({ ar: 'وقت البداية (18:30)', en: 'Start time (18:30)' })} value={f.startTime} onChangeText={set('startTime')} />
      <Field label={tr({ ar: 'وقت النهاية (23:00)', en: 'End time (23:00)' })} value={f.endTime} onChangeText={set('endTime')} />
      <Field label={tr({ ar: 'عدد الضيوف المتوقع', en: 'Expected guests' })} value={f.guests} onChangeText={set('guests')} keyboardType="number-pad" />
      <Field testID="event-budget" label={tr({ ar: 'الميزانية (اختياري)', en: 'Budget (optional)' })} value={f.budget} onChangeText={set('budget')} keyboardType="decimal-pad" />
      {f.budget && currencies.length > 1 ? <Choice label={tr({ ar: 'عملة الميزانية', en: 'Budget currency' })} value={f.currency || currencies[0]!}
        options={currencies.map((c) => ({ value: c, label: c }))} onChange={(v) => v && set('currency')(v)} /> : null}
      <Field label={tr({ ar: 'ملاحظات', en: 'Notes' })} value={f.notes} onChangeText={set('notes')} multiline />
      {id ? <Choice label={tr({ ar: 'حالة المناسبة', en: 'Event status' })} value={f.status}
        options={EVENT_STATUSES.map((s) => ({ value: s, label: enumLabel('event', s, lang) }))} onChange={(v) => v && set('status')(v)} /> : null}
      {problem ? <Notice kind="warn">{problem}</Notice> : null}
      <ErrorText error={save.error} />
      <Button testID="save-event" title={tr({ ar: 'حفظ', en: 'Save' })} disabled={save.isPending} onPress={submit} />
    </Screen>
  );
}
