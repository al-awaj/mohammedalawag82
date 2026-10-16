import { useState } from 'react';
import { enumLabel } from '@events/shared';
import { api } from '../lib/api';
import { useAction, useGet, useSession } from '../lib/session';
import { useTr } from '../lib/i18n';
import { Choice, ErrorText } from './ui';

export type EventSummary = { id: string; name: string; eventType: string; status: string };

/** Links a cart item (`/v1/cart/items/:id`) or a booking (`/v1/bookings/:id/event`) to one of the customer's events. */
export function EventPicker({ value, path }: { value: string | null; path: string }) {
  const tr = useTr();
  const { lang } = useSession();
  const events = (useGet<EventSummary[]>('/v1/events').data ?? []).filter((e) => e.status !== 'cancelled');
  const [current, setCurrent] = useState<string | null>(value);
  const save = useAction((eventId: string | null) => (path.startsWith('/v1/cart') ? api.patch(path, { eventId }) : api.put(path, { eventId })));
  if (!events.length && !value) return null;
  return (
    <>
      <Choice testID="event" label={tr({ ar: 'ضمن المناسبة', en: 'Part of event' })} value={current}
        options={events.map((e) => ({ value: e.id, label: `${e.name} · ${enumLabel('eventType', e.eventType, lang)}` }))}
        onChange={(v) => { setCurrent(v); save.mutate(v); }} />
      <ErrorText error={save.error} />
    </>
  );
}
