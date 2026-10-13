import type { Executor } from '../db/pool.js';
import { enqueueMessage } from './outbox.js';

/** How a notice reaches a person: `auto` = SMS when there is a phone, else email. */
export type NoticeChannel = 'auto' | 'sms' | 'email' | 'whatsapp';
export const NOTICE_CHANNELS: NoticeChannel[] = ['auto', 'sms', 'email', 'whatsapp'];

/**
 * Sends a templated notice to a user on one channel (plus the in-app inbox copy added by the outbox).
 * If the requested channel has no address for this user, it falls back to the other one.
 */
export async function notifyUser(c: Executor, userId: string, templateKey: string, payload: Record<string, unknown>, channel: NoticeChannel = 'auto') {
  const u = (await c.query<{ phone: string | null; email: string | null; preferred_language: string }>(
    'SELECT phone, email, preferred_language FROM users WHERE id = $1', [userId])).rows[0];
  if (!u) return;
  let ch: Exclude<NoticeChannel, 'auto'> = channel === 'auto' ? (u.phone ? 'sms' : 'email') : channel;
  if ((ch === 'sms' || ch === 'whatsapp') && !u.phone) ch = 'email';
  if (ch === 'email' && !u.email) ch = 'sms';
  const target = ch === 'email' ? u.email : u.phone;
  if (!target) return;
  await enqueueMessage(c, { channel: ch, recipientUserId: userId, target, templateKey, language: u.preferred_language, payload });
}

export async function notifyUsers(c: Executor, userIds: string[], templateKey: string, payload: Record<string, unknown>) {
  for (const id of [...new Set(userIds)]) await notifyUser(c, id, templateKey, payload);
}
