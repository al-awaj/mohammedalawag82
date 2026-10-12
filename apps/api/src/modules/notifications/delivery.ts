import type { Db, Executor } from '../../db/pool.js';
import { render, SECRET_PAYLOAD_KEYS } from './templates.js';

const MAX_ATTEMPTS = 5;

interface OutboxRow {
  id: string; channel: string; recipient_user_id: string | null; target: string; template_key: string; language: string;
  payload: Record<string, unknown>; attempts: number; country_id: string | null;
}

async function findTemplate(c: Executor, key: string, channel: string, language: string) {
  // Exact language first, then the other one; WhatsApp and push reuse the SMS wording when they have none.
  const channels = channel === 'whatsapp' || channel === 'push' ? [channel, 'sms'] : [channel];
  const { rows } = await c.query<{ subject: string | null; body: string }>(
    `SELECT subject, body FROM notification_templates
      WHERE key = $1 AND channel = ANY($2) AND is_active
      ORDER BY array_position($2, channel), (language = $3) DESC, language LIMIT 1`, [key, channels, language]);
  return rows[0] ?? null;
}

export interface Transport {
  send(cfg: { endpoint: string; secret: string; senderId: string | null }, msg: { id: string; channel: string; to: string; subject: string | null; body: string }): Promise<{ ok: boolean; providerRef: string | null; error: string | null }>;
}

/**
 * Generic JSON-over-HTTPS driver: one adapter shape for any SMS / email / WhatsApp / push provider
 * (or a small relay service in front of it). Authenticated with the secret from the environment.
 */
export const httpJson: Transport = {
  async send(cfg, msg) {
    try {
      const res = await fetch(cfg.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.secret}` },
        body: JSON.stringify({ messageId: msg.id, channel: msg.channel, to: msg.to, from: cfg.senderId, subject: msg.subject, body: msg.body }),
        signal: AbortSignal.timeout(10_000),
      });
      const text = await res.text();
      if (!res.ok) return { ok: false, providerRef: null, error: `HTTP ${res.status}: ${text.slice(0, 300)}` };
      let ref: string | null = null;
      try { ref = (JSON.parse(text) as { id?: string }).id ?? null; } catch { /* provider sent no JSON */ }
      return { ok: true, providerRef: ref, error: null };
    } catch (err) {
      return { ok: false, providerRef: null, error: (err as Error).message };
    }
  },
};

/**
 * Sends due messages. In-app ('web') messages are delivered by being stored rendered. A message only
 * counts as sent when the provider accepted it; failures retry with backoff, then stay failed with the reason.
 * The stored copy masks one-time codes, and the code is removed from the payload once handled.
 */
export async function deliverOutbox(db: Db, transport: Transport = httpJson, batch = 50): Promise<number> {
  const client = await db.connect();
  let handled = 0;
  try {
    await client.query('BEGIN');
    const rows = (await client.query<OutboxRow>(
      `SELECT o.id, o.channel, o.recipient_user_id, o.target, o.template_key, o.language, o.payload, o.attempts, u.country_id
         FROM message_outbox o LEFT JOIN users u ON u.id = o.recipient_user_id
        WHERE o.status = 'pending' AND o.next_attempt_at <= now()
        ORDER BY o.next_attempt_at LIMIT $1 FOR UPDATE OF o SKIP LOCKED`, [batch])).rows;
    for (const m of rows) {
      handled++;
      const tpl = await findTemplate(client, m.template_key, m.channel, m.language);
      if (!tpl) {
        await client.query(`UPDATE message_outbox SET status = 'failed', attempts = attempts + 1, last_error = 'template_missing' WHERE id = $1`, [m.id]);
        continue;
      }
      const subject = tpl.subject ? render(tpl.subject, m.payload) : null;
      const body = render(tpl.body, m.payload);
      const stored = render(tpl.body, m.payload, true);
      const scrubbed = Object.fromEntries(Object.entries(m.payload).filter(([k]) => !SECRET_PAYLOAD_KEYS.includes(k)));

      if (m.channel === 'web') {
        await client.query(`UPDATE message_outbox SET status = 'sent', sent_at = now(), attempts = attempts + 1, subject = $2, body = $3 WHERE id = $1`, [m.id, subject, stored]);
        continue;
      }
      const cfg = (await client.query<{ endpoint: string; secret_ref: string; sender_id: string | null }>(
        `SELECT endpoint, secret_ref, sender_id FROM messaging_channels
          WHERE channel = $1 AND is_active AND (country_id = $2 OR country_id IS NULL)
          ORDER BY (country_id IS NOT NULL) DESC LIMIT 1`, [m.channel, m.country_id])).rows[0];
      const secret = cfg ? process.env[cfg.secret_ref] : undefined;
      if (!cfg || !secret) {
        await client.query(
          `UPDATE message_outbox SET status = 'failed', attempts = attempts + 1, last_error = $2, subject = $3, body = $4, payload = $5 WHERE id = $1`,
          [m.id, cfg ? `secret ${cfg.secret_ref} is not set` : 'channel_not_configured', subject, stored, JSON.stringify(scrubbed)]);
        continue;
      }
      const r = await transport.send({ endpoint: cfg.endpoint, secret, senderId: cfg.sender_id }, { id: m.id, channel: m.channel, to: m.target, subject, body });
      if (r.ok) {
        await client.query(
          `UPDATE message_outbox SET status = 'sent', sent_at = now(), attempts = attempts + 1, provider_ref = $2, subject = $3, body = $4, payload = $5, last_error = NULL WHERE id = $1`,
          [m.id, r.providerRef, subject, stored, JSON.stringify(scrubbed)]);
      } else {
        const attempts = m.attempts + 1;
        const final = attempts >= MAX_ATTEMPTS;
        await client.query(
          `UPDATE message_outbox SET status = $2, attempts = $3, last_error = $4, subject = $5, body = $6,
                  next_attempt_at = now() + make_interval(mins => $7), payload = CASE WHEN $2 = 'failed' THEN $8::jsonb ELSE payload END
            WHERE id = $1`,
          [m.id, final ? 'failed' : 'pending', attempts, r.error, subject, stored, 2 ** attempts, JSON.stringify(scrubbed)]);
      }
    }
    await client.query('COMMIT');
    return handled;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
