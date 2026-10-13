import { z } from 'zod';
import type { App, Deps } from '../../deps.js';
import { actorOf, can, countryScope, requirePermission, requireUser } from '../../auth/guard.js';
import { audit } from '../../lib/audit.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { withTx } from '../../db/pool.js';
import { idParams, langSchema } from '../common.js';

/** Help centre and FAQ (clause 60): written by staff, read by customers on the website/app and by providers in their panel. */
const longText = z.record(langSchema, z.string().trim().min(1).max(20_000))
  .refine((v) => typeof v.ar === 'string' || typeof v.en === 'string', 'must include "ar" or "en"');
const AUDIENCES = ['customer', 'provider', 'all'] as const;
const fields = z.object({
  countryId: z.uuid().nullable(),
  audience: z.enum(AUDIENCES),
  topic: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
  question: longText,
  answer: longText,
  sortOrder: z.number().int(),
  isPublished: z.boolean(),
});
const COLUMNS = `h.id, h.country_id AS "countryId", co.code AS "countryCode", h.audience, h.topic, h.question, h.answer,
                 h.sort_order AS "sortOrder", h.is_published AS "isPublished", h.updated_at AS "updatedAt"`;

export async function helpRoutes(app: App, deps: Deps) {
  const { db } = deps;

  /** Published articles for one audience in a country (articles for every country included). */
  app.get('/help', {
    schema: { tags: ['help'], querystring: z.object({ country: z.string().length(2).toUpperCase(), audience: z.enum(['customer', 'provider']).default('customer') }) },
  }, async (req) => {
    return (await db.query(
      `SELECT h.id, h.topic, h.question, h.answer FROM help_articles h
        WHERE h.is_published AND h.audience IN ($2, 'all')
          AND (h.country_id IS NULL OR h.country_id = (SELECT id FROM countries WHERE code = $1 AND is_active))
        ORDER BY h.topic, h.sort_order, h.created_at`, [req.query.country, req.query.audience])).rows;
  });

  const staff = { onRequest: deps.authenticate, preValidation: requirePermission('content.manage') };

  app.get('/admin/help-articles', { ...staff, schema: { tags: ['admin:help'], security: [{ bearer: [] }] } }, async (req) => {
    const scope = countryScope(requireUser(req), 'content.manage');
    return (await db.query(
      `SELECT ${COLUMNS} FROM help_articles h LEFT JOIN countries co ON co.id = h.country_id
        WHERE $1::uuid[] IS NULL OR h.country_id IS NULL OR h.country_id = ANY($1) ORDER BY h.audience, h.topic, h.sort_order, h.created_at`, [scope])).rows;
  });

  app.post('/admin/help-articles', {
    ...staff,
    schema: { tags: ['admin:help'], security: [{ bearer: [] }], body: fields.extend({ countryId: z.uuid().nullable().default(null), sortOrder: z.number().int().default(0), isPublished: z.boolean().default(false) }) },
  }, async (req, reply) => {
    const user = requireUser(req);
    const b = req.body;
    // Country-scoped staff write for their countries only; platform-wide articles need a global grant.
    if (!can(user, 'content.manage', b.countryId)) throw forbidden('PERMISSION_DENIED');
    const id = await withTx(db, async (c) => {
      const row = (await c.query<{ id: string }>(
        `INSERT INTO help_articles (country_id, audience, topic, question, answer, sort_order, is_published, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [b.countryId, b.audience, b.topic, JSON.stringify(b.question), JSON.stringify(b.answer), b.sortOrder, b.isPublished, user.id])).rows[0]!;
      await audit(c, actorOf(req), { action: 'help.created', entityType: 'help_article', entityId: row.id, after: b });
      return row.id;
    });
    return reply.status(201).send({ id });
  });

  app.patch('/admin/help-articles/:id', {
    ...staff, schema: { tags: ['admin:help'], security: [{ bearer: [] }], params: idParams, body: fields.omit({ countryId: true }).partial() },
  }, async (req) => {
    const user = requireUser(req);
    if (!Object.keys(req.body).length) throw badRequest('VALIDATION_FAILED', [{ path: '/', message: 'nothing to change' }]);
    return withTx(db, async (c) => {
      const before = (await c.query('SELECT * FROM help_articles WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
      if (!before) throw notFound();
      if (!can(user, 'content.manage', before.country_id)) throw forbidden('PERMISSION_DENIED');
      const b = req.body;
      await c.query(
        `UPDATE help_articles SET audience = coalesce($2, audience), topic = coalesce($3, topic), question = coalesce($4, question),
           answer = coalesce($5, answer), sort_order = coalesce($6, sort_order), is_published = coalesce($7, is_published) WHERE id = $1`,
        [req.params.id, b.audience ?? null, b.topic ?? null, b.question ? JSON.stringify(b.question) : null, b.answer ? JSON.stringify(b.answer) : null,
          b.sortOrder ?? null, b.isPublished ?? null]);
      await audit(c, actorOf(req), { action: 'help.updated', entityType: 'help_article', entityId: req.params.id, before, after: b });
      return { id: req.params.id };
    });
  });
}
