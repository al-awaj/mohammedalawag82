import { z } from 'zod';
import type { App, Deps } from '../../deps.js';
import { actorOf, assertCan, countryScope, requirePermission, requireUser } from '../../auth/guard.js';
import { withTx } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { badRequest, conflict, mapUniqueViolation, notFound } from '../../lib/errors.js';
import { idParams, langSchema, paginationQuery, reasonSchema } from '../common.js';

const sec = [{ bearer: [] }];
const CHANNELS = ['sms', 'email', 'whatsapp', 'push', 'web'] as const;

export async function notificationRoutes(app: App, deps: Deps) {
  const { db } = deps;
  const staff = { onRequest: deps.authenticate, preValidation: requirePermission('notifications.manage') };

  // ---------------- In-app inbox (any signed-in user) ----------------
  app.get('/me/notifications', {
    onRequest: deps.authenticate, schema: { tags: ['me'], security: sec, querystring: paginationQuery.extend({ unread: z.enum(['true']).optional() }) },
  }, async (req) => {
    const u = requireUser(req);
    const items = (await db.query(
      `SELECT id, template_key AS "type", subject, body, payload, created_at AS "createdAt", read_at AS "readAt"
         FROM message_outbox WHERE channel = 'web' AND recipient_user_id = $1 AND status = 'sent' AND ($2::boolean IS NULL OR read_at IS NULL)
        ORDER BY created_at DESC LIMIT $3 OFFSET $4`, [u.id, req.query.unread ? true : null, req.query.limit, req.query.offset])).rows;
    const unread = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM message_outbox WHERE channel = 'web' AND recipient_user_id = $1 AND status = 'sent' AND read_at IS NULL`, [u.id])).rows[0]!.n;
    return { unread, items };
  });

  app.post('/me/notifications/:id/read', { onRequest: deps.authenticate, schema: { tags: ['me'], security: sec, params: idParams } }, async (req, reply) => {
    const r = await db.query(`UPDATE message_outbox SET read_at = coalesce(read_at, now()) WHERE id = $1 AND channel = 'web' AND recipient_user_id = $2`, [req.params.id, requireUser(req).id]);
    if (!r.rowCount) throw notFound();
    return reply.status(204).send();
  });

  app.post('/me/notifications/read-all', { onRequest: deps.authenticate, schema: { tags: ['me'], security: sec } }, async (req, reply) => {
    await db.query(`UPDATE message_outbox SET read_at = now() WHERE channel = 'web' AND recipient_user_id = $1 AND read_at IS NULL`, [requireUser(req).id]);
    return reply.status(204).send();
  });

  // ---------------- Templates (clause 53: manageable and translatable) ----------------
  app.get('/admin/notification-templates', { ...staff, schema: { tags: ['admin:notifications'], security: sec, querystring: z.object({ key: z.string().optional() }) } }, async (req) =>
    (await db.query(
      `SELECT id, key, channel, language, subject, body, is_active AS "isActive", updated_at AS "updatedAt" FROM notification_templates
        WHERE ($1::text IS NULL OR key = $1) ORDER BY key, channel, language`, [req.query.key ?? null])).rows);

  app.put('/admin/notification-templates', {
    ...staff,
    schema: {
      tags: ['admin:notifications'], security: sec,
      body: z.object({ key: z.string().regex(/^[a-z][a-z0-9_.]{2,100}$/), channel: z.enum(CHANNELS), language: langSchema, subject: z.string().max(200).nullable().default(null), body: z.string().min(1).max(5000), isActive: z.boolean().default(true) }),
    },
  }, async (req) => {
    assertCan(requireUser(req), 'notifications.manage');
    const b = req.body;
    return withTx(db, async (c) => {
      const before = (await c.query('SELECT subject, body, is_active FROM notification_templates WHERE key = $1 AND channel = $2 AND language = $3', [b.key, b.channel, b.language])).rows[0];
      const row = (await c.query<{ id: string }>(
        `INSERT INTO notification_templates (key, channel, language, subject, body, is_active, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (key, channel, language) DO UPDATE SET subject = EXCLUDED.subject, body = EXCLUDED.body, is_active = EXCLUDED.is_active, updated_by = EXCLUDED.updated_by
         RETURNING id`, [b.key, b.channel, b.language, b.subject, b.body, b.isActive, requireUser(req).id])).rows[0]!;
      await audit(c, actorOf(req), { action: 'notification_template.saved', entityType: 'notification_template', entityId: row.id, before, after: b });
      return { id: row.id };
    });
  });

  // ---------------- Channels per country (clause 9: SMS / WhatsApp settings) ----------------
  app.get('/admin/messaging-channels', { ...staff, schema: { tags: ['admin:notifications'], security: sec } }, async (req) => {
    const scope = countryScope(requireUser(req), 'notifications.manage');
    return (await db.query(
      `SELECT id, country_id AS "countryId", channel, driver, endpoint, secret_ref AS "secretRef", sender_id AS "senderId", is_active AS "isActive",
              ($2::text[] @> ARRAY[secret_ref]) AS "secretConfigured"
         FROM messaging_channels WHERE ($1::uuid[] IS NULL OR country_id IS NULL OR country_id = ANY($1)) ORDER BY country_id NULLS FIRST, channel`,
      [scope, Object.keys(process.env)])).rows;
  });

  app.post('/admin/messaging-channels', {
    ...staff,
    schema: {
      tags: ['admin:notifications'], security: sec,
      body: z.object({ countryId: z.uuid().nullable().default(null), channel: z.enum(['sms', 'email', 'whatsapp', 'push']), driver: z.enum(['http_json']).default('http_json'),
        endpoint: z.url(), secretRef: z.string().regex(/^[A-Z][A-Z0-9_]{2,100}$/), senderId: z.string().max(100).nullable().default(null) }),
    },
  }, async (req, reply) => {
    assertCan(requireUser(req), 'notifications.manage', req.body.countryId);
    const b = req.body;
    if (deps.config.NODE_ENV === 'production' && !b.endpoint.startsWith('https://')) throw badRequest('VALIDATION_FAILED', [{ path: '/endpoint', message: 'https is required in production' }]);
    const id = await withTx(db, async (c) => {
      let cid: string;
      try {
        cid = (await c.query<{ id: string }>(
          'INSERT INTO messaging_channels (country_id, channel, driver, endpoint, secret_ref, sender_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
          [b.countryId, b.channel, b.driver, b.endpoint, b.secretRef, b.senderId])).rows[0]!.id;
      } catch (err) { mapUniqueViolation(err, { messaging_channels_country_id_channel: 'CODE_TAKEN' }); }
      await audit(c, actorOf(req), { action: 'messaging_channel.created', entityType: 'messaging_channel', entityId: cid, after: b });
      return cid;
    });
    return reply.status(201).send({ id });
  });

  app.patch('/admin/messaging-channels/:id', {
    ...staff, schema: { tags: ['admin:notifications'], security: sec, params: idParams, body: z.object({ isActive: z.boolean().optional(), endpoint: z.url().optional(), senderId: z.string().max(100).nullable().optional(), reason: reasonSchema }) },
  }, async (req) => withTx(db, async (c) => {
    const before = (await c.query<{ country_id: string | null }>('SELECT * FROM messaging_channels WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
    if (!before) throw notFound();
    assertCan(requireUser(req), 'notifications.manage', before.country_id);
    await c.query(`UPDATE messaging_channels SET is_active = coalesce($2, is_active), endpoint = coalesce($3, endpoint),
                     sender_id = CASE WHEN $4 THEN $5 ELSE sender_id END WHERE id = $1`,
      [req.params.id, req.body.isActive ?? null, req.body.endpoint ?? null, req.body.senderId !== undefined, req.body.senderId ?? null]);
    await audit(c, actorOf(req), { action: 'messaging_channel.updated', entityType: 'messaging_channel', entityId: req.params.id, before, after: req.body, reason: req.body.reason });
    return { id: req.params.id };
  }));

  // ---------------- Delivery log (clause 54) ----------------
  app.get('/admin/notifications', {
    ...staff,
    schema: { tags: ['admin:notifications'], security: sec, querystring: paginationQuery.extend({ status: z.enum(['pending', 'sent', 'failed']).optional(), channel: z.enum(CHANNELS).optional(), recipientId: z.uuid().optional(), templateKey: z.string().optional() }) },
  }, async (req) => {
    const scope = countryScope(requireUser(req), 'notifications.manage');
    const q = req.query;
    // The stored body has one-time codes masked; the raw payload is not exposed here.
    return (await db.query(
      `SELECT o.id, o.channel, o.recipient_user_id AS "recipientId", o.target, o.template_key AS "templateKey", o.language, o.subject, o.body, o.status,
              o.attempts, o.last_error AS "lastError", o.provider_ref AS "providerRef", o.created_at AS "createdAt", o.sent_at AS "sentAt"
         FROM message_outbox o LEFT JOIN users u ON u.id = o.recipient_user_id
        WHERE ($1::uuid[] IS NULL OR u.country_id = ANY($1)) AND ($2::text IS NULL OR o.status = $2) AND ($3::text IS NULL OR o.channel = $3)
          AND ($4::uuid IS NULL OR o.recipient_user_id = $4) AND ($5::text IS NULL OR o.template_key = $5)
        ORDER BY o.created_at DESC LIMIT $6 OFFSET $7`, [scope, q.status ?? null, q.channel ?? null, q.recipientId ?? null, q.templateKey ?? null, q.limit, q.offset])).rows;
  });

  app.post('/admin/notifications/:id/retry', { ...staff, schema: { tags: ['admin:notifications'], security: sec, params: idParams } }, async (req) => withTx(db, async (c) => {
    const m = (await c.query<{ status: string; template_key: string }>('SELECT status, template_key FROM message_outbox WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
    if (!m) throw notFound();
    if (m.status !== 'failed') throw conflict('INVALID_STATUS_TRANSITION', { from: m.status });
    // One-time codes are not resent: their code was removed after the first attempt.
    if (m.template_key.startsWith('auth.')) throw conflict('INVALID_STATUS_TRANSITION', { reason: 'request a new code instead' });
    await c.query(`UPDATE message_outbox SET status = 'pending', next_attempt_at = now(), attempts = 0 WHERE id = $1`, [req.params.id]);
    await audit(c, actorOf(req), { action: 'notification.retried', entityType: 'message', entityId: req.params.id });
    return { status: 'pending' };
  }));

  // ---------------- Reminder rules (clause 48) ----------------
  app.get('/admin/reminder-rules', { ...staff, schema: { tags: ['admin:notifications'], security: sec } }, async () =>
    (await db.query(`SELECT id, kind, days_before AS "daysBefore", country_id AS "countryId", service_type_id AS "serviceTypeId", template_key AS "templateKey", channel, is_active AS "isActive" FROM reminder_rules ORDER BY created_at`)).rows);

  app.post('/admin/reminder-rules', {
    ...staff,
    schema: {
      tags: ['admin:notifications'], security: sec,
      body: z.object({ kind: z.enum(['before_balance_due', 'balance_overdue', 'before_event']), daysBefore: z.number().int().min(0).max(365).default(0),
        countryId: z.uuid().nullable().default(null), serviceTypeId: z.uuid().nullable().default(null), templateKey: z.string().regex(/^[a-z][a-z0-9_.]{2,100}$/),
        channel: z.enum(['auto', 'sms', 'email', 'whatsapp']).default('auto') }),
    },
  }, async (req, reply) => {
    assertCan(requireUser(req), 'notifications.manage', req.body.countryId);
    const b = req.body;
    const id = await withTx(db, async (c) => {
      const rid = (await c.query<{ id: string }>('INSERT INTO reminder_rules (kind, days_before, country_id, service_type_id, template_key, channel) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
        [b.kind, b.daysBefore, b.countryId, b.serviceTypeId, b.templateKey, b.channel])).rows[0]!.id;
      await audit(c, actorOf(req), { action: 'reminder_rule.created', entityType: 'reminder_rule', entityId: rid, after: b });
      return rid;
    });
    return reply.status(201).send({ id });
  });

  app.patch('/admin/reminder-rules/:id', { ...staff, schema: { tags: ['admin:notifications'], security: sec, params: idParams, body: z.object({ isActive: z.boolean(), reason: reasonSchema }) } }, async (req) =>
    withTx(db, async (c) => {
      const r = await c.query('UPDATE reminder_rules SET is_active = $2 WHERE id = $1', [req.params.id, req.body.isActive]);
      if (!r.rowCount) throw notFound();
      await audit(c, actorOf(req), { action: 'reminder_rule.updated', entityType: 'reminder_rule', entityId: req.params.id, after: req.body, reason: req.body.reason });
      return { id: req.params.id };
    }));
}
