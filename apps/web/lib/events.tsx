'use client';
import { useState } from 'react';
import { enumLabel, EVENT_STATUSES, EVENT_TYPES } from '@events/shared';
import { useAction, useApp, useGet, useSession, useTr } from '@events/web-kit/client';
import type { FieldSpec } from '@events/web-kit/ui';

export interface EventSummary {
  id: string; name: string; eventType: string; city: string; eventDate: string; status: string;
  budgetAmount: string | null; budgetCurrency: string | null; expectedGuests: number | null; bookingCount: number;
}

/** The customer's events that can still take bookings. */
export function useOpenEvents() {
  const r = useGet<EventSummary[]>('/v1/events');
  return { ...r, data: (r.data ?? []).filter((e) => e.status !== 'cancelled') };
}

/** Currencies offered for an event budget: those of the customer's country. */
export function useCountryCurrencies(): string[] {
  const s = useSession().data;
  const countries = useGet<{ code: string; baseCurrency: string; currencies: string[] }[]>('/v1/countries').data ?? [];
  const c = countries.find((x) => x.code === s?.countryCode);
  return c ? [...new Set([c.baseCurrency, ...c.currencies])] : [];
}

/** All the fields of an event (clause 24). `current` pre-fills them when editing. */
export function eventFields(lang: 'ar' | 'en', currencies: string[], current?: Record<string, unknown>, withStatus = false): FieldSpec[] {
  const local = (iso: unknown) => (typeof iso === 'string' && iso ? iso.slice(0, 16) : undefined);
  const fields: FieldSpec[] = [
    { name: 'name', label: { ar: 'اسم المناسبة', en: 'Event name' }, required: true, defaultValue: current?.name },
    { name: 'eventType', label: { ar: 'نوع المناسبة', en: 'Occasion type' }, type: 'select', required: true, defaultValue: current?.eventType,
      options: EVENT_TYPES.map((t) => ({ value: t, label: { ar: enumLabel('eventType', t, 'ar'), en: enumLabel('eventType', t, 'en') } })) },
    { name: 'city', label: { ar: 'المدينة', en: 'City' }, required: true, defaultValue: current?.city },
    { name: 'location', label: { ar: 'الموقع أو العنوان', en: 'Venue or address' }, defaultValue: current?.location },
    { name: 'geo', label: { ar: 'مكان المناسبة على الخريطة (اختياري)', en: 'Event place on the map (optional)' }, type: 'geo', defaultValue: { lat: current?.latitude, lng: current?.longitude } },
    { name: 'eventDate', label: { ar: 'تاريخ المناسبة', en: 'Date' }, type: 'date', required: true, defaultValue: typeof current?.eventDate === 'string' ? current.eventDate.slice(0, 10) : undefined },
    { name: 'startsAt', label: { ar: 'وقت البداية', en: 'Starts at' }, type: 'datetime', defaultValue: local(current?.startsAt) },
    { name: 'endsAt', label: { ar: 'وقت النهاية', en: 'Ends at' }, type: 'datetime', defaultValue: local(current?.endsAt) },
    { name: 'expectedGuests', label: { ar: 'عدد الضيوف المتوقع', en: 'Expected guests' }, type: 'number', defaultValue: current?.expectedGuests },
    { name: 'budgetAmount', label: { ar: 'الميزانية', en: 'Budget' }, type: 'decimal', defaultValue: current?.budgetAmount ? Number(current.budgetAmount).toString() : undefined,
      help: { ar: 'اختياري. تُقارن بإجمالي الحجوزات بنفس العملة فقط.', en: 'Optional. Compared with bookings in the same currency only.' } },
    { name: 'budgetCurrency', label: { ar: 'عملة الميزانية', en: 'Budget currency' }, type: 'select', defaultValue: current?.budgetCurrency ?? currencies[0],
      options: currencies.map((c) => ({ value: c, label: { ar: c, en: c } })) },
    { name: 'notes', label: { ar: 'ملاحظات', en: 'Notes' }, type: 'textarea', defaultValue: current?.notes },
  ];
  if (withStatus) {
    fields.push({ name: 'status', label: { ar: 'حالة المناسبة', en: 'Event status' }, type: 'select', required: true, defaultValue: current?.status,
      options: EVENT_STATUSES.map((s) => ({ value: s, label: { ar: enumLabel('event', s, 'ar'), en: enumLabel('event', s, 'en') } })) });
  }
  void lang;
  return fields;
}

/** Body for POST/PATCH: a budget without an amount carries no currency, and empty optional fields are sent as null on edit. */
export function eventBody(v: Record<string, unknown>, editing: boolean): Record<string, unknown> {
  const { geo, ...rest } = v;
  const g = geo as { lat: number; lng: number } | undefined;
  const body: Record<string, unknown> = { ...rest, ...(g || editing ? { latitude: g?.lat ?? null, longitude: g?.lng ?? null } : {}) };
  if (!body.budgetAmount) delete body.budgetCurrency;
  if (editing) {
    for (const k of ['location', 'startsAt', 'endsAt', 'expectedGuests', 'budgetAmount', 'budgetCurrency', 'notes']) if (!(k in body)) body[k] = null;
  }
  return body;
}

/** Select that links a cart item or a booking to one of the customer's events. */
export function EventPicker({ value, path, testId }: { value: string | null; path: string; testId?: string }) {
  const tr = useTr();
  const { lang } = useApp();
  const events = useOpenEvents();
  const [current, setCurrent] = useState(value ?? '');
  const save = useAction((api, eventId: string | null) => (path.startsWith('/v1/cart') ? api.patch(path, { eventId }) : api.put(path, { eventId })));
  if (!events.data.length && !value) return null;
  return (
    <label className="row gap small" style={{ alignItems: 'center' }}>
      <span className="muted">{tr({ ar: 'ضمن المناسبة', en: 'Part of event' })}</span>
      <select data-testid={testId} value={current} disabled={save.isPending} style={{ width: 'auto' }}
        onChange={(e) => { setCurrent(e.target.value); save.mutate(e.target.value || null); }}>
        <option value="">{tr({ ar: '— بدون مناسبة —', en: '— No event —' })}</option>
        {events.data.map((ev) => <option key={ev.id} value={ev.id}>{ev.name} · {enumLabel('eventType', ev.eventType, lang)}</option>)}
      </select>
      {save.error ? <span className="badge badge-bad">{tr({ ar: 'تعذر الحفظ', en: 'Not saved' })}</span> : null}
    </label>
  );
}
