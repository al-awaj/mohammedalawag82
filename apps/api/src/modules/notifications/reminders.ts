import type { Db } from '../../db/pool.js';
import { enqueueMessage } from '../../lib/outbox.js';

/**
 * Automatic reminders (clause 48), once per booking and rule. Amounts are the verified remaining
 * balance, so a reminder never suggests money was received when it was not.
 */
export async function sendReminders(db: Db): Promise<number> {
  const rules = (await db.query<{ id: string; kind: string; days_before: number; country_id: string | null; service_type_id: string | null; template_key: string }>(
    'SELECT * FROM reminder_rules WHERE is_active')).rows;
  let sent = 0;
  for (const r of rules) {
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
        const target = b.phone ?? b.email;
        if (!target) continue;
        await enqueueMessage(client, {
          channel: b.phone ? 'sms' : 'email', recipientUserId: b.customer_id, target, templateKey: r.template_key, language: b.lang,
          payload: { bookingId: b.id, number: b.number, remaining: b.remaining, currency: b.currency.trim(), dueDate: b.balance_due_at?.toISOString().slice(0, 10) ?? null, startDate: b.start_at.toISOString().slice(0, 10) },
        });
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
