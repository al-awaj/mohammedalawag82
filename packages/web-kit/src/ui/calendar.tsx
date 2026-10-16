'use client';
import type { ReactNode } from 'react';
import { localized } from '@events/shared';
import { useApp, useTr } from '../client';

/**
 * Calendar views (clause 26): month, week and day, drawn in each block's own country timezone so a booking shows
 * at the local time the customer booked. The preparation/cleanup buffers of the service type (the difference between
 * `blockedStart/blockedEnd` and `start/end`) are drawn as a hatched band around the block.
 */
export type CalendarMode = 'month' | 'week' | 'day';
export interface CalendarBlock {
  id: string; kind: string; start: string; end: string; blockedStart: string; blockedEnd: string; timezone: string;
  serviceTitle: Record<string, string>; units: number; bookingRef: string | null; reason: string | null; providerName?: string;
}

const DAY_MS = 86_400_000;
const pad = (n: number) => String(n).padStart(2, '0');
export const isoDay = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const parseDay = (s: string) => new Date(`${s}T00:00:00Z`);
export const addDays = (s: string, n: number) => isoDay(new Date(parseDay(s).getTime() + n * DAY_MS));

/** Local calendar day and minute of the day of an instant in a timezone. */
export function zoned(iso: string, timeZone: string): { day: string; minute: number } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, minute: Number(parts.hour) * 60 + Number(parts.minute) };
}

/** First and last day shown by a view around `anchor` (weeks start on Sunday; a month view shows whole weeks). */
export function viewRange(mode: CalendarMode, anchor: string): { from: string; to: string } {
  const a = parseDay(anchor);
  if (mode === 'day') return { from: anchor, to: anchor };
  if (mode === 'week') { const from = addDays(anchor, -a.getUTCDay()); return { from, to: addDays(from, 6) }; }
  const first = isoDay(new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), 1)));
  const last = isoDay(new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth() + 1, 0)));
  const from = addDays(first, -parseDay(first).getUTCDay());
  return { from, to: addDays(last, 6 - parseDay(last).getUTCDay()) };
}

export function shift(mode: CalendarMode, anchor: string, dir: 1 | -1): string {
  if (mode === 'day') return addDays(anchor, dir);
  if (mode === 'week') return addDays(anchor, 7 * dir);
  const a = parseDay(anchor);
  return isoDay(new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth() + dir, 1)));
}

/** The part of a block (and of its buffered range) that falls on one local day, in minutes from midnight. */
export function onDay(b: CalendarBlock, day: string): { from: number; to: number; bufFrom: number; bufTo: number } | null {
  const clip = (iso: string) => {
    const z = zoned(iso, b.timezone);
    return z.day < day ? 0 : z.day > day ? 1440 : z.minute;
  };
  const bufFrom = clip(b.blockedStart);
  const bufTo = clip(b.blockedEnd);
  if (bufTo <= bufFrom) return null;
  const from = clip(b.start);
  const to = clip(b.end);
  return { from, to: Math.max(from, to), bufFrom, bufTo };
}

const KIND_CLASS: Record<string, string> = { booking: 'cal-booking', hold: 'cal-hold', external: 'cal-external', closed: 'cal-closed' };
const WEEKDAYS = [
  { ar: 'الأحد', en: 'Sun' }, { ar: 'الاثنين', en: 'Mon' }, { ar: 'الثلاثاء', en: 'Tue' }, { ar: 'الأربعاء', en: 'Wed' },
  { ar: 'الخميس', en: 'Thu' }, { ar: 'الجمعة', en: 'Fri' }, { ar: 'السبت', en: 'Sat' },
];
const hm = (m: number) => `${pad(Math.floor(m / 60) % 24)}:${pad(m % 60)}`;

export function CalendarView({ mode, anchor, blocks, onMode, onAnchor, kindLabel, blockHref, today }: {
  mode: CalendarMode; anchor: string; blocks: CalendarBlock[];
  onMode: (m: CalendarMode) => void; onAnchor: (d: string) => void;
  kindLabel: (kind: string) => string; blockHref?: (b: CalendarBlock) => string | null; today: string;
}) {
  const tr = useTr();
  const { lang } = useApp();
  const { from, to } = viewRange(mode, anchor);
  const days: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
  const title = (b: CalendarBlock) => `${kindLabel(b.kind)} · ${localized(b.serviceTitle, lang)}${b.providerName ? ` · ${b.providerName}` : ''}${b.reason ? ` · ${b.reason}` : ''}`;
  const wrap = (b: CalendarBlock, node: ReactNode) => {
    const href = blockHref?.(b);
    return href ? <a key={b.id} href={href}>{node}</a> : <span key={b.id}>{node}</span>;
  };
  const heading = new Intl.DateTimeFormat(lang === 'ar' ? 'ar' : 'en', mode === 'month' ? { month: 'long', year: 'numeric', timeZone: 'UTC' } : { dateStyle: 'medium', timeZone: 'UTC' })
    .format(parseDay(mode === 'month' ? anchor : from)) + (mode === 'week' ? ` – ${new Intl.DateTimeFormat(lang === 'ar' ? 'ar' : 'en', { dateStyle: 'medium', timeZone: 'UTC' }).format(parseDay(to))}` : '');

  return (
    <div className="cal" data-testid="calendar" data-mode={mode}>
      <div className="row between cal-bar">
        <div className="row gap">
          <button type="button" className="btn btn-secondary" onClick={() => onAnchor(shift(mode, anchor, -1))} aria-label={tr({ ar: 'السابق', en: 'Previous' })}>‹</button>
          <button type="button" className="btn btn-secondary" onClick={() => onAnchor(today)}>{tr({ ar: 'اليوم', en: 'Today' })}</button>
          <button type="button" className="btn btn-secondary" onClick={() => onAnchor(shift(mode, anchor, 1))} aria-label={tr({ ar: 'التالي', en: 'Next' })}>›</button>
          <strong data-testid="calendar-title">{heading}</strong>
        </div>
        <div className="tabs" role="tablist">
          {(['month', 'week', 'day'] as const).map((m) => (
            <button key={m} type="button" role="tab" aria-selected={m === mode} className={m === mode ? 'tab active' : 'tab'} onClick={() => onMode(m)}>
              {tr({ month: { ar: 'شهر', en: 'Month' }, week: { ar: 'أسبوع', en: 'Week' }, day: { ar: 'يوم', en: 'Day' } }[m])}
            </button>
          ))}
        </div>
      </div>
      <div className="cal-legend small">
        {Object.keys(KIND_CLASS).map((k) => <span key={k} className={`cal-chip ${KIND_CLASS[k]}`}>{kindLabel(k)}</span>)}
        <span className="cal-chip cal-buffer-sample">{tr({ ar: 'وقت تجهيز/تنظيف', en: 'Preparation/cleanup' })}</span>
      </div>

      {mode === 'month' ? (
        <div className="cal-month">
          {WEEKDAYS.map((w, i) => <div key={i} className="cal-head">{tr(w)}</div>)}
          {days.map((d) => {
            const items = blocks.filter((b) => onDay(b, d));
            return (
              <div key={d} className={`cal-cell${d.slice(0, 7) !== anchor.slice(0, 7) ? ' cal-out' : ''}${d === today ? ' cal-today' : ''}`} data-day={d}>
                <button type="button" className="cal-daynum" onClick={() => { onAnchor(d); onMode('day'); }}>{Number(d.slice(8))}</button>
                {items.slice(0, 4).map((b) => wrap(b, <span className={`cal-chip ${KIND_CLASS[b.kind] ?? ''}`} title={title(b)} data-testid={`cal-block-${b.id}`}>
                  {hm(onDay(b, d)!.from)} {localized(b.serviceTitle, lang)}
                </span>))}
                {items.length > 4 && <span className="muted small">+{items.length - 4}</span>}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="cal-grid" style={{ gridTemplateColumns: `48px repeat(${days.length}, minmax(0, 1fr))` }}>
          <div />
          {days.map((d) => <div key={d} className={`cal-head${d === today ? ' cal-today' : ''}`}>{tr(WEEKDAYS[parseDay(d).getUTCDay()]!)} {Number(d.slice(8))}</div>)}
          <div className="cal-hours">{Array.from({ length: 24 }, (_, h) => <div key={h}>{pad(h)}:00</div>)}</div>
          {days.map((d) => (
            <div key={d} className="cal-col" data-day={d}>
              {blocks.map((b) => {
                const p = onDay(b, d);
                if (!p) return null;
                return wrap(b, <>
                  {(p.bufFrom < p.from || p.bufTo > p.to) && <span className="cal-buffer" style={{ top: `${(p.bufFrom / 1440) * 100}%`, height: `${((p.bufTo - p.bufFrom) / 1440) * 100}%` }} />}
                  <span className={`cal-event ${KIND_CLASS[b.kind] ?? ''}`} title={title(b)} data-testid={`cal-block-${b.id}`}
                    style={{ top: `${(p.from / 1440) * 100}%`, height: `max(18px, ${((p.to - p.from) / 1440) * 100}%)` }}>
                    {hm(p.from)}–{hm(p.to)} {localized(b.serviceTitle, lang)}
                  </span>
                </>);
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
