import type { Executor } from '../db/pool.js';

export interface OutboundMessage {
  channel: 'sms' | 'email' | 'whatsapp' | 'push' | 'web';
  recipientUserId: string | null;
  target: string;
  templateKey: string;
  language: string;
  payload: Record<string, unknown>;
}

/**
 * Queues a message in the same transaction as the business change.
 * Delivery is done by the notification worker (phase 8); nothing here claims it was sent.
 */
export async function enqueueMessage(exec: Executor, msg: OutboundMessage): Promise<string> {
  const { rows } = await exec.query<{ id: string }>(
    `INSERT INTO message_outbox (channel, recipient_user_id, target, template_key, language, payload)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [msg.channel, msg.recipientUserId, msg.target, msg.templateKey, msg.language, JSON.stringify(msg.payload)],
  );
  // Every account notice also lands in the in-app inbox; one-time codes never do.
  if (msg.channel !== 'web' && msg.recipientUserId && !msg.templateKey.startsWith('auth.')) {
    await exec.query(
      `INSERT INTO message_outbox (channel, recipient_user_id, target, template_key, language, payload) VALUES ('web', $1, $2, $3, $4, $5)`,
      [msg.recipientUserId, `user:${msg.recipientUserId}`, msg.templateKey, msg.language, JSON.stringify(msg.payload)]);
  }
  return rows[0]!.id;
}
