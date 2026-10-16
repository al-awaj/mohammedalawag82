import type { Db } from '../../db/pool.js';
import { notifyUser, type NoticeChannel } from '../../lib/notify.js';

/**
 * Automatic reminders (clause 48), once per booking and rule. Amounts are the verified remaining
 * balance, so a reminder never suggests money was received when it was not.
 */
export async function sendReminders(db: Db): Promise<number> {
  const rules = (await db.query<{ id: string; kind: string; days_before: number; country_id: string | null; service_type_id: string | null; template_key: string; channel: NoticeChannel }>(
    'SELECT * FROM reminder_rules WHERE is_active')).rows;
  let sent = 0;
  for (const r of rules) {
    if (r.kind === 'before_instalment_due') { sent += await instalmentReminders(db, r); continue; }
    const cond = r.kind === 'before_balance_due'
      ? `b.balance_due_at IS NOT NULL AND b.balance_due_at > now() AND b.balance_due_at <= now() + make_interval(days => $2) AND pd.remaining > 0`
      : r.kind === 'balance_overdue'
        ? `b.balance_due_at IS NOT NULL AND b.balance_due_at <= now() AND pd.remaining > 0`
        : `b.start_at > now() AND b.start_at <= now() + make_interval(days => $2)`;
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const due = (await client.query<{ id: string; number: string; customer_id: string; remaining: string; currency: string; balance_due_at: Date | null; start_at: Date; phone: string | null; email: string | null; lang: string }>(
        `WITH pd AS (
           SELECT b.id, b.total - coalesce((SELECT sum(a.verified_amount) FROM payment_allocations a JOIN payments p ON p.id = a.payment_id
                                             WHERE a.booking_id = b.id AND p.status = 'succeeded'), 0) AS remaining
             FROM bookings b WHERE b.status IN ('confirmed', 'in_progress'))
         SELECT b.id, b.number, b.customer_id, pd.remaining::numeric(20,4)::text AS remaining, b.currency_code AS currency, b.balance_due_at, b.start_at,
                u.phone, u.email, u.preferred_language AS lang
           FROM bookings b JOIN pd ON pd.id = b.id JOIN users u ON u.id = b.customer_id JOIN services s ON s.id = b.service_id
          WHERE ${cond}
            AND ($3::uuid IS NULL OR b.country_id = $3) AND ($4::uuid IS NULL OR s.service_type_id = $4)
            AND NOT EXISTS (SELECT 1 FROM booking_reminders br WHERE br.booking_id = b.id AND br.rule_id = $1)
          LIMIT 500`, [r.id, r.days_before, r.country_id, r.service_type_id])).rows;
      for (const b of due) {
        await client.query('INSERT INTO booking_reminders (booking_id, rule_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [b.id, r.id]);
        await notifyUser(client, b.customer_id, r.template_key,
          { bookingId: b.id, number: b.number, remaining: b.remaining, currency: b.currency.trim(), dueDate: b.balance_due_at?.toISOString().slice(0, 10) ?? null, startDate: b.start_at.toISOString().slice(0, 10) },
          r.channel);
        sent++;
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
  return sent;
}

type Rule = { id: string; days_before: number; country_id: string | null; service_type_id: string | null; template_key: string; channel: NoticeChannel };

/** One reminder per instalment that falls due within the rule's window and is not yet covered by verified payments. */
async function instalmentReminders(db: Db, r: Rule): Promise<number> {
  const client = await db.connect();
  let sent = 0;
  try {
    await client.query('BEGIN');
    const due = (await client.query<{ id: string; number: string; customer_id: string; currency: string; seq: number; due_at: Date; owed: string; start_at: Date }>(
      `WITH paid AS (
         SELECT b.id, coalesce((SELECT sum(a.verified_amount) FROM payment_allocations a JOIN payments p ON p.id = a.payment_id
                                 WHERE a.booking_id = b.id AND p.status = 'succeeded'), 0) AS paid
           FROM bookings b WHERE b.status IN ('confirmed', 'in_progress') AND b.instalment_plan IS NOT NULL),
       inst AS (
         SELECT b.id, (x->>'seq')::int AS seq, (x->>'dueAt')::timestamptz AS due_at,
                b.upfront_amount + sum((x->>'amount')::numeric) OVER (PARTITION BY b.id ORDER BY (x->>'seq')::int) AS target
           FROM bookings b JOIN paid ON paid.id = b.id, jsonb_array_elements(b.instalment_plan) x)
       SELECT b.id, b.number, b.customer_id, b.currency_code AS currency, i.seq, i.due_at, b.start_at,
              (i.target - paid.paid)::numeric(20,4)::text AS owed
         FROM inst i JOIN bookings b ON b.id = i.id JOIN paid ON paid.id = b.id JOIN services s ON s.id = b.service_id
        WHERE i.target > paid.paid AND i.due_at > now() AND i.due_at <= now() + make_interval(days => $2)
          AND ($3::uuid IS NULL OR b.country_id = $3) AND ($4::uuid IS NULL OR s.service_type_id = $4)
          AND NOT EXISTS (SELECT 1 FROM booking_instalment_reminders br WHERE br.booking_id = b.id AND br.rule_id = $1 AND br.seq = i.seq)
        LIMIT 500`, [r.id, r.days_before, r.country_id, r.service_type_id])).rows;
    for (const b of due) {
      await client.query('INSERT INTO booking_instalment_reminders (booking_id, rule_id, seq) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [b.id, r.id, b.seq]);
      await notifyUser(client, b.customer_id, r.template_key,
        { bookingId: b.id, number: b.number, remaining: b.owed, currency: b.currency.trim(), instalment: b.seq, dueDate: b.due_at.toISOString().slice(0, 10), startDate: b.start_at.toISOString().slice(0, 10) },
        r.channel);
      sent++;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return sent;
}
