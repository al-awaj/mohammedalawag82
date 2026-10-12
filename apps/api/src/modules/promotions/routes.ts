import { z } from 'zod';
import type { App, Deps } from '../../deps.js';
import { actorOf, assertCan, countryScope, requireKind, requirePermission, requireUser } from '../../auth/guard.js';
import { withTx, type Executor } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { badRequest, conflict, mapUniqueViolation, notFound } from '../../lib/errors.js';
import { i18nTextSchema, idParams, reasonSchema } from '../common.js';
import { providerOf } from '../catalog/shared.js';

const sec = [{ bearer: [] }];
const money = z.string().regex(/^\d{1,16}(\.\d{1,4})?$/);

const promoBody = z.object({
  code: z.string().trim().toUpperCase().pipe(z.string().regex(/^[A-Z0-9_-]{3,30}$/)),
  name: i18nTextSchema,
  terms: i18nTextSchema.nullable().default(null),
  discountType: z.enum(['percent', 'fixed']),
  discountValue: money,
  currency: z.string().regex(/^[A-Z]{3}$/).nullable().default(null),
  maxDiscount: money.nullable().default(null),
  minBookingTotal: money.nullable().default(null),
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }),
  usageLimitTotal: z.number().int().positive().nullable().default(null),
  usageLimitPerCustomer: z.number().int().positive().nullable().default(null),
  countryId: z.uuid().nullable().default(null),
  serviceTypeIds: z.array(z.uuid()).max(100).nullable().default(null),
  serviceIds: z.array(z.uuid()).max(500).nullable().default(null),
  costBearer: z.enum(['platform', 'provider', 'shared']),
  providerSharePercent: z.number().min(0).max(100).nullable().default(null),
});

const COLUMNS = `p.id, p.code, p.name, p.terms, p.discount_type AS "discountType", p.discount_value AS "discountValue", p.currency_code AS currency,
  p.max_discount AS "maxDiscount", p.min_booking_total AS "minBookingTotal", p.starts_at AS "startsAt", p.ends_at AS "endsAt",
  p.usage_limit_total AS "usageLimitTotal", p.usage_limit_per_customer AS "usageLimitPerCustomer", p.country_id AS "countryId",
  p.service_type_ids AS "serviceTypeIds", p.service_ids AS "serviceIds", p.provider_id AS "providerId", p.cost_bearer AS "costBearer",
  p.provider_share_percent AS "providerSharePercent", p.is_active AS "isActive", p.created_at AS "createdAt",
  (SELECT count(DISTINCT r.order_id)::int FROM promotion_redemptions r WHERE r.promotion_id = p.id AND r.status = 'active') AS "timesUsed",
  (SELECT coalesce(sum(r.discount_amount), 0)::numeric(20,4)::text FROM promotion_redemptions r WHERE r.promotion_id = p.id AND r.status = 'active') AS "discountGiven"`;

async function insertPromotion(c: Executor, b: z.infer<typeof promoBody>, createdBy: string, providerId: string | null) {
  try {
    return (await c.query<{ id: string }>(
      `INSERT INTO promotions (code, name, terms, discount_type, discount_value, currency_code, max_discount, min_booking_total, starts_at, ends_at,
         usage_limit_total, usage_limit_per_customer, country_id, service_type_ids, service_ids, provider_id, cost_bearer, provider_share_percent, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING id`,
      [b.code, JSON.stringify(b.name), b.terms ? JSON.stringify(b.terms) : null, b.discountType, b.discountValue, b.currency, b.maxDiscount, b.minBookingTotal,
        b.startsAt, b.endsAt, b.usageLimitTotal, b.usageLimitPerCustomer, b.countryId, b.serviceTypeIds, b.serviceIds, providerId, b.costBearer,
        b.providerSharePercent, createdBy])).rows[0]!.id;
  } catch (err) {
    if ((err as { code?: string }).code === '23514') {
      throw badRequest('VALIDATION_FAILED', [{ path: '/', message: 'ends after it starts; percent <= 100; currency only and always for fixed; share percent only and always for shared cost' }]);
    }
    mapUniqueViolation(err, { promotions_code: 'CODE_TAKEN' });
  }
}

export async function promotionRoutes(app: App, deps: Deps) {
  const { db } = deps;
  const staff = { onRequest: deps.authenticate, preValidation: requirePermission('promotions.manage') };
  const provider = { onRequest: deps.authenticate, preValidation: requireKind('provider') };

  // ---------------- Admin (platform / shared / provider-borne for any provider) ----------------
  app.get('/admin/promotions', { ...staff, schema: { tags: ['admin:promotions'], security: sec } }, async (req) => {
    const scope = countryScope(requireUser(req), 'promotions.manage');
    return (await db.query(`SELECT ${COLUMNS} FROM promotions p WHERE ($1::uuid[] IS NULL OR p.country_id = ANY($1)) ORDER BY p.created_at DESC`, [scope])).rows;
  });

  app.post('/admin/promotions', { ...staff, schema: { tags: ['admin:promotions'], security: sec, body: promoBody } }, async (req, reply) => {
    assertCan(requireUser(req), 'promotions.manage', req.body.countryId);
    const id = await withTx(db, async (c) => {
      const pid = await insertPromotion(c, req.body, requireUser(req).id, null);
      await audit(c, actorOf(req), { action: 'promotion.created', entityType: 'promotion', entityId: pid, after: req.body });
      return pid;
    });
    return reply.status(201).send({ id });
  });

  app.patch('/admin/promotions/:id', {
    ...staff,
    schema: { tags: ['admin:promotions'], security: sec, params: idParams, body: z.object({ isActive: z.boolean().optional(), endsAt: z.iso.datetime({ offset: true }).optional(), usageLimitTotal: z.number().int().positive().nullable().optional(), reason: reasonSchema }) },
  }, async (req) => withTx(db, async (c) => {
    const before = (await c.query<{ country_id: string | null }>('SELECT * FROM promotions WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
    if (!before) throw notFound();
    assertCan(requireUser(req), 'promotions.manage', before.country_id);
    // Discount terms stay as created so past redemptions remain explainable; only availability changes.
    await c.query(`UPDATE promotions SET is_active = coalesce($2, is_active), ends_at = coalesce($3, ends_at),
                     usage_limit_total = CASE WHEN $4 THEN $5::int ELSE usage_limit_total END WHERE id = $1`,
      [req.params.id, req.body.isActive ?? null, req.body.endsAt ?? null, req.body.usageLimitTotal !== undefined, req.body.usageLimitTotal ?? null])
      .catch((err) => { if (err.code === '23514') throw badRequest('VALIDATION_FAILED', [{ path: '/endsAt', message: 'must be after the start' }]); throw err; });
    await audit(c, actorOf(req), { action: 'promotion.updated', entityType: 'promotion', entityId: req.params.id, before, after: req.body, reason: req.body.reason });
    return { id: req.params.id };
  }));

  // ---------------- Provider (own services, provider pays the discount) ----------------
  app.get('/provider/promotions', { ...provider, schema: { tags: ['provider-panel'], security: sec } }, async (req) => {
    const p = await providerOf(db, req, { forWrite: false });
    return (await db.query(`SELECT ${COLUMNS} FROM promotions p WHERE p.provider_id = $1 ORDER BY p.created_at DESC`, [p.id])).rows;
  });

  app.post('/provider/promotions', {
    ...provider,
    schema: { tags: ['provider-panel'], security: sec, body: promoBody.omit({ costBearer: true, providerSharePercent: true, countryId: true, serviceTypeIds: true }).extend({ serviceIds: z.array(z.uuid()).min(1).max(500) }) },
  }, async (req, reply) => {
    const id = await withTx(db, async (c) => {
      const p = await providerOf(c, req, { forWrite: true });
      const own = await c.query<{ n: number }>('SELECT count(*)::int AS n FROM services WHERE id = ANY($1) AND provider_id = $2', [req.body.serviceIds, p.id]);
      if (own.rows[0]!.n !== new Set(req.body.serviceIds).size) throw notFound();
      const pid = await insertPromotion(c, { ...req.body, costBearer: 'provider', providerSharePercent: null, countryId: p.country_id, serviceTypeIds: null }, requireUser(req).id, p.id);
      await audit(c, actorOf(req), { action: 'promotion.created', entityType: 'promotion', entityId: pid, after: req.body });
      return pid;
    });
    return reply.status(201).send({ id });
  });

  app.post('/provider/promotions/:id/deactivate', { ...provider, schema: { tags: ['provider-panel'], security: sec, params: idParams } }, async (req) => withTx(db, async (c) => {
    const p = await providerOf(c, req, { forWrite: false });
    const r = await c.query('UPDATE promotions SET is_active = false WHERE id = $1 AND provider_id = $2 AND is_active', [req.params.id, p.id]);
    if (!r.rowCount) throw conflict('INVALID_STATUS_TRANSITION');
    await audit(c, actorOf(req), { action: 'promotion.deactivated', entityType: 'promotion', entityId: req.params.id });
    return { isActive: false };
  }));
}
