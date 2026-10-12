import { z } from 'zod';
import type { App, Deps } from '../../deps.js';
import { actorOf, assertCan, countryScope, requireKind, requirePermission, requireUser } from '../../auth/guard.js';
import { withTx } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { conflict, notFound } from '../../lib/errors.js';
import { idParams, paginationQuery, reasonSchema } from '../common.js';
import { providerOf } from '../catalog/shared.js';
import { getSetting } from '../settings/registry.js';

const sec = [{ bearer: [] }];

export async function reviewRoutes(app: App, deps: Deps) {
  const { db } = deps;

  /** Only the customer of a completed booking, once, within the review window (clause 56: no fake reviews). */
  app.post('/bookings/:id/review', {
    onRequest: deps.authenticate, preValidation: requireKind('customer'),
    schema: { tags: ['reviews'], security: sec, params: idParams, body: z.object({ rating: z.number().int().min(1).max(5), comment: z.string().trim().max(3000).optional() }) },
  }, async (req, reply) => {
    const u = requireUser(req);
    const id = await withTx(db, async (c) => {
      const b = (await c.query<{ id: string; customer_id: string; status: string; service_id: string; provider_id: string; country_id: string; in_window: boolean }>(
        `SELECT id, customer_id, status, service_id, provider_id, country_id,
                end_at >= now() - make_interval(days => (SELECT coalesce((SELECT (value)::int FROM settings WHERE key = 'reviews.window_days' AND scope_type = 'global'), 90))) AS in_window
           FROM bookings WHERE id = $1 FOR UPDATE`, [req.params.id])).rows[0];
      if (!b || b.customer_id !== u.id) throw notFound();
      if (b.status !== 'completed' || !b.in_window) throw conflict('REVIEW_NOT_ALLOWED', { status: b.status });
      const moderated = await getSetting(c, 'reviews.require_moderation', b.country_id);
      let rid: string;
      try {
        rid = (await c.query<{ id: string }>(
          'INSERT INTO reviews (booking_id, service_id, provider_id, customer_id, rating, comment, status) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
          [b.id, b.service_id, b.provider_id, u.id, req.body.rating, req.body.comment ?? null, moderated ? 'pending_moderation' : 'published'])).rows[0]!.id;
      } catch (err) {
        if ((err as { code?: string }).code === '23505') throw conflict('REVIEW_NOT_ALLOWED', { reason: 'already reviewed' });
        throw err;
      }
      await audit(c, actorOf(req), { action: 'review.created', entityType: 'review', entityId: rid, after: { bookingId: b.id, rating: req.body.rating } });
      return rid;
    });
    return reply.status(201).send({ id });
  });

  app.get('/services/:id/reviews', { schema: { tags: ['reviews'], params: idParams, querystring: paginationQuery } }, async (req) => {
    const summary = (await db.query<{ count: number; average: string | null }>(
      `SELECT count(*)::int AS count, round(avg(rating), 2)::text AS average FROM reviews WHERE service_id = $1 AND status = 'published'`, [req.params.id])).rows[0]!;
    // Reviewer shown by first name only.
    const items = (await db.query(
      `SELECT r.id, r.rating, r.comment, split_part(u.full_name, ' ', 1) AS "reviewer", r.created_at AS "createdAt"
         FROM reviews r JOIN users u ON u.id = r.customer_id WHERE r.service_id = $1 AND r.status = 'published'
        ORDER BY r.created_at DESC LIMIT $2 OFFSET $3`, [req.params.id, req.query.limit, req.query.offset])).rows;
    return { ...summary, items };
  });

  // ---------------- Provider ----------------
  app.get('/provider/reviews', { onRequest: deps.authenticate, preValidation: requireKind('provider'), schema: { tags: ['provider-panel'], security: sec } }, async (req) => {
    const p = await providerOf(db, req, { forWrite: false });
    return (await db.query(
      `SELECT r.id, r.booking_id AS "bookingId", r.service_id AS "serviceId", r.rating, r.comment, r.status, r.created_at AS "createdAt"
         FROM reviews r WHERE r.provider_id = $1 ORDER BY r.created_at DESC`, [p.id])).rows;
  });

  /** Providers can flag a review for moderation but never remove it themselves. */
  app.post('/provider/reviews/:id/report', {
    onRequest: deps.authenticate, preValidation: requireKind('provider'), schema: { tags: ['provider-panel'], security: sec, params: idParams, body: z.object({ reason: reasonSchema }) },
  }, async (req) => withTx(db, async (c) => {
    const p = await providerOf(c, req, { forWrite: false });
    const r = await c.query('UPDATE reviews SET reported_count = reported_count + 1 WHERE id = $1 AND provider_id = $2', [req.params.id, p.id]);
    if (!r.rowCount) throw notFound();
    await audit(c, actorOf(req), { action: 'review.reported', entityType: 'review', entityId: req.params.id, reason: req.body.reason });
    return { reported: true };
  }));

  // ---------------- Moderation ----------------
  app.get('/admin/reviews', {
    onRequest: deps.authenticate, preValidation: requirePermission('reviews.moderate'),
    schema: { tags: ['admin:reviews'], security: sec, querystring: paginationQuery.extend({ status: z.enum(['published', 'pending_moderation', 'hidden']).optional(), reported: z.enum(['true']).optional() }) },
  }, async (req) => {
    const scope = countryScope(requireUser(req), 'reviews.moderate');
    return (await db.query(
      `SELECT r.id, r.booking_id AS "bookingId", r.service_id AS "serviceId", r.rating, r.comment, r.status, r.reported_count AS "reportedCount",
              r.moderation_reason AS "moderationReason", r.created_at AS "createdAt"
         FROM reviews r JOIN services s ON s.id = r.service_id
        WHERE ($1::uuid[] IS NULL OR s.country_id = ANY($1)) AND ($2::text IS NULL OR r.status = $2) AND ($3::boolean IS NULL OR r.reported_count > 0)
        ORDER BY r.reported_count DESC, r.created_at DESC LIMIT $4 OFFSET $5`, [scope, req.query.status ?? null, req.query.reported ? true : null, req.query.limit, req.query.offset])).rows;
  });

  app.post('/admin/reviews/:id/moderate', {
    onRequest: deps.authenticate, preValidation: requirePermission('reviews.moderate'),
    schema: { tags: ['admin:reviews'], security: sec, params: idParams, body: z.object({ action: z.enum(['publish', 'hide']), reason: reasonSchema }) },
  }, async (req) => withTx(db, async (c) => {
    const r = (await c.query<{ status: string; country_id: string }>('SELECT r.status, s.country_id FROM reviews r JOIN services s ON s.id = r.service_id WHERE r.id = $1 FOR UPDATE OF r', [req.params.id])).rows[0];
    if (!r) throw notFound();
    assertCan(requireUser(req), 'reviews.moderate', r.country_id);
    const to = req.body.action === 'publish' ? 'published' : 'hidden';
    await c.query('UPDATE reviews SET status = $2, moderated_by = $3, moderation_reason = $4 WHERE id = $1', [req.params.id, to, requireUser(req).id, req.body.reason]);
    await audit(c, actorOf(req), { action: `review.${req.body.action}`, entityType: 'review', entityId: req.params.id, before: { status: r.status }, after: { status: to }, reason: req.body.reason });
    return { status: to };
  }));
}
