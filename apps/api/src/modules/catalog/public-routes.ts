import { z } from 'zod';
import type { App, Deps } from '../../deps.js';
import { can, loadAuthUser } from '../../auth/guard.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { pickLang } from '../../lib/i18n.js';
import { identityVisible, serviceDetail } from './queries.js';
import { currencyCode, moneySchema } from './shared.js';

const searchQuery = z.object({
  country: z.string().length(2).toUpperCase(),
  city: z.string().max(100).optional(),
  category: z.string().max(80).optional(),          // category slug (includes sub-categories)
  type: z.string().max(50).optional(),              // service type code
  q: z.string().trim().min(2).max(100).optional(),
  currency: currencyCode.optional(),
  minPrice: moneySchema.optional(),
  maxPrice: moneySchema.optional(),
  minCapacity: z.coerce.number().int().positive().optional(),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
  radiusKm: z.coerce.number().positive().max(500).optional(),
  // JSON object of searchable type fields, e.g. {"style":"modern","seats":{"min":100}}. Requires `type`.
  attrs: z.string().max(2000).optional(),
  sort: z.enum(['newest', 'price_asc', 'price_desc', 'distance']).default('newest'),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export async function catalogPublicRoutes(app: App, deps: Deps) {
  const { db } = deps;

  /** Active category tree available in a country, with the active types under each category. */
  app.get('/categories', {
    schema: { tags: ['catalog'], querystring: z.object({ country: z.string().length(2).toUpperCase() }) },
  }, async (req) => {
    const rows = (await db.query(
      `SELECT c.id, c.slug, c.parent_id AS "parentId", c.name, c.description, c.icon,
              CASE WHEN c.image_key IS NULL THEN NULL ELSE '/v1/categories/' || c.id || '/image' END AS "imageUrl",
              coalesce((SELECT json_agg(json_build_object('id', t.id, 'code', t.code, 'name', t.name, 'icon', t.icon, 'bookingMode', t.booking_mode) ORDER BY t.code)
                          FROM service_types t WHERE t.category_id = c.id AND t.is_active), '[]') AS types
         FROM service_categories c
         JOIN service_category_countries cc ON cc.category_id = c.id
         JOIN countries co ON co.id = cc.country_id AND co.code = $1 AND co.is_active
        WHERE c.is_active ORDER BY c.sort_order, c.slug`, [req.query.country])).rows;
    // Build the tree; a child whose parent is hidden is not shown either.
    const byId = new Map(rows.map((r) => [r.id, { ...r, children: [] as unknown[] }]));
    const roots: unknown[] = [];
    for (const node of byId.values()) {
      if (!node.parentId) roots.push(node);
      else byId.get(node.parentId)?.children.push(node);
    }
    return roots;
  });

  app.get('/categories/:id/image', { schema: { tags: ['catalog'], params: z.object({ id: z.uuid() }) } }, async (req, reply) => {
    const c = (await db.query<{ image_key: string | null }>('SELECT image_key FROM service_categories WHERE id = $1 AND is_active', [req.params.id])).rows[0];
    if (!c?.image_key) throw notFound();
    const f = await deps.storage.open(c.image_key);
    return reply.header('cache-control', 'public, max-age=86400').type(c.image_key.endsWith('.png') ? 'image/png' : c.image_key.endsWith('.webp') ? 'image/webp' : 'image/jpeg').send(f.stream);
  });

  app.get('/services', { schema: { tags: ['catalog'], querystring: searchQuery } }, async (req) => {
    const q = req.query;
    if ((q.minPrice || q.maxPrice || q.sort.startsWith('price')) && !q.currency) throw badRequest('CURRENCY_REQUIRED_FOR_PRICE_FILTER');
    const geo = q.lat !== undefined && q.lng !== undefined;
    if ((q.radiusKm || q.sort === 'distance') && !geo) throw badRequest('VALIDATION_FAILED', [{ path: '/lat', message: 'lat and lng are required for distance' }]);

    const params: unknown[] = [q.country];
    const where: string[] = [
      `co.code = $1`, `s.status = 'published'`, `p.status = 'active'`, `t.is_active`, `cat.is_active`,
      `EXISTS (SELECT 1 FROM service_category_countries cc WHERE cc.category_id = t.category_id AND cc.country_id = s.country_id)`,
    ];
    const add = (sql: (n: string) => string, v: unknown) => { params.push(v); where.push(sql(`$${params.length}`)); };
    if (q.city) add((n) => `lower(s.city) = lower(${n})`, q.city);
    if (q.type) add((n) => `t.code = ${n}`, q.type);
    if (q.category) {
      add((n) => `t.category_id IN (WITH RECURSIVE sub AS (SELECT id FROM service_categories WHERE slug = ${n} AND is_active
                    UNION ALL SELECT c.id FROM service_categories c JOIN sub ON c.parent_id = sub.id WHERE c.is_active) SELECT id FROM sub)`, q.category);
    }
    if (q.q) add((n) => `(s.title::text ILIKE '%' || ${n} || '%' OR s.description::text ILIKE '%' || ${n} || '%')`, q.q);
    if (q.currency) add((n) => `s.currency_code = ${n}`, q.currency);
    // Price filters match the base price or any active package, in the requested currency only (no implicit FX).
    const priceExpr = `LEAST(s.base_price, coalesce((SELECT min(pk.price) FROM packages pk WHERE pk.service_id = s.id AND pk.status = 'active'
                         AND pk.currency_code = s.currency_code AND (pk.valid_to IS NULL OR pk.valid_to >= current_date)), s.base_price))`;
    if (q.minPrice) add((n) => `${priceExpr} >= ${n}::numeric`, q.minPrice);
    if (q.maxPrice) add((n) => `${priceExpr} <= ${n}::numeric`, q.maxPrice);
    if (q.minCapacity) add((n) => `s.capacity >= ${n}`, q.minCapacity);

    if (q.attrs) {
      if (!q.type) throw badRequest('VALIDATION_FAILED', [{ path: '/attrs', message: 'attribute filters require `type`' }]);
      let filters: Record<string, unknown>;
      try { filters = z.record(z.string(), z.unknown()).parse(JSON.parse(q.attrs)); } catch { throw badRequest('VALIDATION_FAILED', [{ path: '/attrs', message: 'must be a JSON object' }]); }
      const searchable = new Map((await db.query<{ key: string; data_type: string }>(
        `SELECT f.key, f.data_type FROM service_type_fields f JOIN service_types t ON t.id = f.service_type_id
          WHERE t.code = $1 AND f.is_active AND f.is_searchable AND f.is_public`, [q.type])).rows.map((r) => [r.key, r.data_type]));
      for (const [key, value] of Object.entries(filters)) {
        const dt = searchable.get(key);
        if (!dt) throw badRequest('VALIDATION_FAILED', [{ path: `/attrs/${key}`, message: 'not a searchable field' }]);
        if ((dt === 'number' || dt === 'integer') && value && typeof value === 'object') {
          const range = z.object({ min: z.number().optional(), max: z.number().optional() }).parse(value);
          params.push(key);
          const k = `$${params.length}`;
          if (range.min !== undefined) add((n) => `jsonb_typeof(s.attributes->${k}) = 'number' AND (s.attributes->>${k})::numeric >= ${n}`, range.min);
          if (range.max !== undefined) add((n) => `jsonb_typeof(s.attributes->${k}) = 'number' AND (s.attributes->>${k})::numeric <= ${n}`, range.max);
        } else if (dt === 'multiselect') {
          const values = z.array(z.string()).parse(Array.isArray(value) ? value : [value]);
          add((n) => `s.attributes @> ${n}::jsonb`, JSON.stringify({ [key]: values }));
        } else {
          add((n) => `s.attributes @> ${n}::jsonb`, JSON.stringify({ [key]: value }));
        }
      }
    }

    let distance = 'NULL::float8';
    if (geo) {
      params.push(q.lat, q.lng);
      const [la, ln] = [`$${params.length - 1}`, `$${params.length}`];
      // Haversine, km.
      distance = `CASE WHEN s.latitude IS NULL THEN NULL ELSE 6371 * 2 * asin(sqrt(
        power(sin(radians((s.latitude::float8 - ${la}::float8) / 2)), 2) +
        cos(radians(${la}::float8)) * cos(radians(s.latitude::float8)) * power(sin(radians((s.longitude::float8 - ${ln}::float8) / 2)), 2))) END`;
      if (q.radiusKm) add((n) => `(${distance}) <= ${n}`, q.radiusKm);
    }
    const order = { newest: 's.published_at DESC', price_asc: 'from_price ASC', price_desc: 'from_price DESC', distance: 'distance_km ASC NULLS LAST' }[q.sort];
    params.push(q.limit, q.offset);
    const { rows } = await db.query(
      `SELECT s.id, s.title, s.city, s.base_price AS "basePrice", ${priceExpr} AS from_price, s.currency_code AS currency,
              s.pricing_unit AS "pricingUnit", s.capacity, s.requires_provider_approval AS "requiresProviderApproval",
              t.code AS "typeCode", t.name AS "typeName", s.country_id, p.business_name AS provider_name, p.show_identity,
              (${distance}) AS distance_km,
              (SELECT m.id FROM service_media m WHERE m.service_id = s.id AND m.kind = 'image' ORDER BY m.sort_order LIMIT 1) AS cover_id,
              count(*) OVER() AS total
         FROM services s JOIN service_types t ON t.id = s.service_type_id JOIN service_categories cat ON cat.id = t.category_id
         JOIN providers p ON p.id = s.provider_id JOIN countries co ON co.id = s.country_id
        WHERE ${where.join(' AND ')}
        ORDER BY ${order}, s.id LIMIT $${params.length - 1} OFFSET $${params.length}`, params);

    const countryId = rows[0]?.country_id;
    const platformShows = countryId ? await identityVisible(db, countryId, true) : false;
    return {
      total: Number(rows[0]?.total ?? 0),
      items: rows.map((r) => ({
        id: r.id, title: r.title, city: r.city, basePrice: r.basePrice, fromPrice: r.from_price, currency: r.currency,
        pricingUnit: r.pricingUnit, capacity: r.capacity, requiresProviderApproval: r.requiresProviderApproval,
        typeCode: r.typeCode, typeName: r.typeName,
        providerName: platformShows && r.show_identity ? r.provider_name : null,
        distanceKm: r.distance_km === null ? null : Math.round(r.distance_km * 10) / 10,
        coverUrl: r.cover_id ? `/v1/media/${r.cover_id}` : null,
      })),
    };
  });

  app.get('/services/:id', { schema: { tags: ['catalog'], params: z.object({ id: z.uuid() }) } }, async (req) => {
    const s = await serviceDetail(db, req.params.id, { audience: 'public', lang: pickLang(req.headers['accept-language']) });
    if (!s) throw notFound();
    const { status: _s, statusReason: _r, providerStatus: _p, typeActive: _t, ...pub } = s;
    return pub;
  });

  /** Media of published services is public; otherwise only the owner and staff who can view services see it. */
  app.get('/media/:id', { schema: { tags: ['catalog'], params: z.object({ id: z.uuid() }) } }, async (req, reply) => {
    const m = (await db.query<{ file_key: string; mime_type: string; status: string; provider_status: string; country_id: string; owner_user_id: string }>(
      `SELECT m.file_key, m.mime_type, s.status, p.status AS provider_status, s.country_id, p.user_id AS owner_user_id
         FROM service_media m JOIN services s ON s.id = m.service_id JOIN providers p ON p.id = s.provider_id WHERE m.id = $1`, [req.params.id])).rows[0];
    if (!m) throw notFound();
    const isPublic = m.status === 'published' && m.provider_status === 'active';
    if (!isPublic) {
      let allowed = false;
      if (req.headers.authorization?.startsWith('Bearer ')) {
        try {
          const claims = await deps.tokens.verifyAccess(req.headers.authorization.slice(7));
          const user = await loadAuthUser(db, claims.sub);
          allowed = !!user && (user.id === m.owner_user_id || can(user, 'services.view', m.country_id));
        } catch { /* fall through to 404 */ }
      }
      if (!allowed) throw notFound();
    }
    const f = await deps.storage.open(m.file_key);
    return reply.header('cache-control', isPublic ? 'public, max-age=3600' : 'private, no-store')
      .header('content-length', f.size).type(m.mime_type).send(f.stream);
  });
}
