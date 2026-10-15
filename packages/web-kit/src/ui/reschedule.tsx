'use client';
import { CalendarClock } from 'lucide-react';
import { useGet, useTr } from '../client';
import { Card, DateTime } from './basics';
import { ActionButton, reasonField } from './forms';

export interface RescheduleRequest {
  id: string; oldStartAt: string; oldEndAt: string; newStartAt: string; newEndAt: string; reason: string | null;
  status: string; deadline: string; decidedAt: string | null; decisionReason: string | null; createdAt: string;
}
const STATUS: Record<string, { ar: string; en: string }> = {
  pending: { ar: 'بانتظار الرد', en: 'Awaiting answer' }, approved: { ar: 'تمت الموافقة', en: 'Approved' }, rejected: { ar: 'مرفوض', en: 'Declined' },
  withdrawn: { ar: 'مسحوب', en: 'Withdrawn' }, expired: { ar: 'انتهت المهلة', en: 'Expired' },
};
const TONE: Record<string, string> = { pending: 'warn', approved: 'ok', rejected: 'bad', withdrawn: 'neutral', expired: 'neutral' };

/**
 * Booking date change (clause 26), shared by the website (customer asks), provider panel and admin panel (they decide).
 * The duration and price never change; the customer picks a new day (and time for time-slot services).
 */
export function RescheduleCard({ audience, bookingId, startAt, endAt, movable }: {
  audience: 'customer' | 'provider' | 'staff'; bookingId: string; startAt: string; endAt: string; movable: boolean;
}) {
  const tr = useTr();
  const base = audience === 'customer' ? `/v1/bookings/${bookingId}` : audience === 'provider' ? `/v1/provider/bookings/${bookingId}` : `/v1/admin/bookings/${bookingId}`;
  const decide = audience === 'provider' ? '/v1/provider/reschedule-requests' : '/v1/admin/reschedule-requests';
  const { data } = useGet<RescheduleRequest[]>(`${base}/reschedule-requests`);
  const list = data ?? [];
  const pending = list.find((r) => r.status === 'pending');
  const start = new Date(startAt);
  // Whole-day bookings move by days; time-slot bookings also choose a start time.
  const fullDays = (new Date(endAt).getTime() - start.getTime()) % 86_400_000 === 0;
  const pad = (n: number) => String(n).padStart(2, '0');
  const localTime = `${pad(start.getHours())}:${pad(start.getMinutes())}`;
  if (!list.length && !(audience === 'customer' && movable)) return null;
  return (
    <Card title={<span className="row gap"><CalendarClock className="ico" aria-hidden />{tr({ ar: 'تغيير الموعد', en: 'Change of date' })}</span>} actions={
      audience === 'customer' && movable && !pending ? (
        <ActionButton label={tr({ ar: 'طلب تغيير الموعد', en: 'Request a new date' })}
          note={tr({ ar: 'تبقى المدة والسعر كما هما. يُحجز الموعد الجديد لك مؤقتًا حتى يرد صاحب الخدمة، ويبقى موعدك الحالي ساريًا إن رُفض الطلب.', en: 'Duration and price stay the same. The new slot is held for you until the provider answers; your current date stands if the request is declined.' })}
          fields={[
            { name: 'date', label: { ar: 'اليوم الجديد', en: 'New day' }, type: 'date', required: true },
            ...(fullDays ? [] : [{ name: 'time', label: { ar: 'وقت البدء', en: 'Start time' }, type: 'text' as const, defaultValue: localTime, placeholder: 'HH:MM' }]),
            { name: 'reason', label: { ar: 'سبب الطلب (اختياري)', en: 'Reason (optional)' }, type: 'textarea' },
          ]}
          run={(api, v) => api.post(`/v1/bookings/${bookingId}/reschedule`, {
            // The server reads the day (and time) in the booking country's timezone.
            date: v.date, ...(fullDays ? {} : { time: v.time ?? localTime }), reason: v.reason ?? null,
          })} />
      ) : null}>
      {list.length === 0 && <p className="muted">{tr({ ar: 'يمكنك طلب نقل الحجز لموعد آخر بنفس المدة؛ يوافق عليه صاحب الخدمة.', en: 'You can ask to move this booking to another date of the same length; the provider approves it.' })}</p>}
      {list.map((r) => (
        <div key={r.id} className="resched-row" data-testid={`reschedule-${r.status}`}>
          <div>
            <div><DateTime value={r.oldStartAt} /> ← <strong><DateTime value={r.newStartAt} /></strong></div>
            <div className="small muted">
              {r.reason && <>{r.reason} · </>}
              {r.status === 'pending' ? <>{tr({ ar: 'المهلة حتى', en: 'Answer due by' })} <DateTime value={r.deadline} /></> : r.decisionReason}
            </div>
          </div>
          <div className="row gap">
            <span className={`badge badge-${TONE[r.status] ?? 'neutral'}`}>{tr(STATUS[r.status] ?? { ar: r.status, en: r.status })}</span>
            {r.status === 'pending' && audience === 'customer' && (
              <ActionButton label={tr({ ar: 'سحب الطلب', en: 'Withdraw' })} run={(api) => api.post(`/v1/reschedule-requests/${r.id}/withdraw`)} />
            )}
            {r.status === 'pending' && audience !== 'customer' && <>
              <ActionButton variant="primary" label={tr({ ar: 'موافقة', en: 'Approve' })}
                note={tr({ ar: 'يُنقل الحجز للموعد الجديد ويُحرر الموعد القديم، ويُبلّغ العميل.', en: 'The booking moves to the new date, the old one is freed, and the customer is notified.' })}
                run={(api) => api.post(`${decide}/${r.id}/approve`)} />
              <ActionButton label={tr({ ar: 'رفض', en: 'Decline' })} fields={[reasonField()]} run={(api, v) => api.post(`${decide}/${r.id}/reject`, v)} />
            </>}
          </div>
        </div>
      ))}
    </Card>
  );
}
