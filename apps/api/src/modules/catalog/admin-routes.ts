import { z } from 'zod';
import type { App, Deps } from '../../deps.js';
import { actorOf, assertCan, can, countryScope, requireKind, requirePermission, requireUser } from '../../auth/guard.js';
import { withTx } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { badRequest, conflict, mapUniqueViolation, notFound } from '../../lib/errors.js';
import { enqueueMessage } from '../../lib/outbox.js';
import { i18nTextSchema, idParams, paginationQuery, reasonSchema } from '../common.js';
import { checkFieldDefinition, DATA_TYPES, optionSchema, validationSchema } from './fields.js';
import { POLICY_COLUMNS, policyBody, policyParams } from './policies.js';
import { serviceDetail } from './queries.js';
import { importStarterCatalog, STARTER_CATALOG } from './starter.js';
import { MODERATION, PRICING_UNITS, recordServiceStatus, type ModerationAction, type ServiceStatus } from './shared.js';

const sec = [{ bearer: [] }];

const categoryBody = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,79}$/),
  parentId: z.uuid().nullable(),
  name: i18nTextSchema,
  description: i18nTextSchema.nullable(),
  icon: z.string().max(100).nullable(),
  sortOrder: z.number().int(),
  isActive: z.boolean(),
  countryIds: z.array(z.uuid()),
});

const fieldBody = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{1,49}$/),
  label: i18nTextSchema,
  helpText: i18nTextSchema.nullable().default(null),
  dataType: z.enum(DATA_TYPES),
  isRequired: z.boolean().default(false),
  validation: validationSchema,
  options: z.array(optionSchema).max(200).default([]),
  isSearchable: z.boolean().default(false),
  isReportable: z.boolean().default(false),
  isPublic: z.boolean().default(true),
  sortOrder: z.number().int().default(0),
});

const typeFields = z.object({
  categoryId: z.uuid(),
  code: z.string().regex(/^[a-z][a-z0-9_]{2,49}$/),
  name: i18nTextSchema,
  description: i18nTextSchema.nullable(),
  icon: z.string().max(100).nullable(),
  bookingMode: z.enum(['time_slot', 'full_day', 'date_range', 'quantity_rental']),
  capacityMode: z.enum(['none', 'guests', 'units']),
  defaultRequiresApproval: z.boolean(),
  defaultDurationMinutes: z.number().int().positive().nullable(),
  bufferBeforeMinutes: z.number().int().min(0).max(24 * 60),
  bufferAfterMinutes: z.number().int().min(0).max(24 * 60),
  pricingUnits: z.array(z.enum(PRICING_UNITS)).min(1),
  allowsPackages: z.boolean(),
  minImages: z.number().int().min(0).max(50),
  maxImages: z.number().int().min(1).max(100),
  allowsVideo: z.boolean(),
  requiredDocuments: z.array(z.string().regex(/^[a-z_]{2,50}$/)).max(20),
  depositRequired: z.boolean(),
  minDepositPercent: z.number().min(0).max(100).nullable(),
  providerCanCreate: z.boolean(),
  isActive: z.boolean(),
  /** Platform policy applied to services of this type whose provider picks none. */
  defaultCancellationPolicyId: z.uuid().nullable(),
});
const typeCreate = typeFields.extend({
  description: i18nTextSchema.nullable().default(null), icon: z.string().max(100).nullable().default(null),
  capacityMode: z.enum(['none', 'guests', 'units']).default('none'), defaultRequiresApproval: z.boolean().default(true),
  defaultDurationMinutes: z.number().int().positive().nullable().default(null), bufferBeforeMinutes: z.number().int().min(0).default(0),
  bufferAfterMinutes: z.number().int().min(0).default(0), allowsPackages: z.boolean().default(true), minImages: z.number().int().min(0).max(50).default(0),
  maxImages: z.number().int().min(1).max(100).default(30), allowsVideo: z.boolean().default(true), requiredDocuments: z.array(z.string().regex(/^[a-z_]{2,50}$/)).max(20).default([]),
  depositRequired: z.boolean().default(false), minDepositPercent: z.number().min(0).max(100).nullable().default(null),
  providerCanCreate: z.boolean().default(true), isActive: z.boolean().default(true), defaultCancellationPolicyId: z.uuid().nullable().default(null),
  fields: z.array(fieldBody).max(100).default([]),
});

const TYPE_COLUMNS: Record<string, string> = {
  categoryId: 'category_id', name: 'name', description: 'description', icon: 'icon', bookingMode: 'booking_mode',
  capacityMode: 'capacity_mode', defaultRequiresApproval: 'default_requires_approval', defaultDurationMinutes: 'default_duration_minutes',
  bufferBeforeMinutes: 'buffer_before_minutes', bufferAfterMinutes: 'buffer_after_minutes', pricingUnits: 'pricing_units',
  allowsPackages: 'allows_packages', minImages: 'min_images', maxImages: 'max_images', allowsVideo: 'allows_video',
  requiredDocuments: 'required_documents', depositRequired: 'deposit_required', minDepositPercent: 'min_deposit_percent',
  providerCanCreate: 'provider_can_create', isActive: 'is_active', defaultCancellationPolicyId: 'default_cancellation_policy_id',
};

/** A type default must be an active platform policy (not one owned by a provider). */
async function assertPlatformPolicy(c: { query: Deps['db']['query'] }, id: string | null | undefined) {
  if (!id) return;
  const r = await c.query('SELECT 1 FROM cancellation_policies WHERE id = $1 AND provider_id IS NULL AND is_active', [id]);
  if (!r.rowCount) throw badRequest('VALIDATION_FAILED', [{ path: '/defaultCancellationPolicyId', message: 'must be an active platform policy' }]);
}
const JSON_COLUMNS = new Set(['name', 'description']);

function validateFieldDef(f: z.infer<typeof fieldBody>) {
  const err = checkFieldDefinition({ data_type: f.dataType, options: f.options, validation: f.validation });
  if (err) throw badRequest('FIELD_DEFINITION_INVALID', { key: f.key, message: err });
}

export async function catalogAdminRoutes(app: App, deps: Deps) {
  const { db } = deps;
  const auth = { onRequest: deps.authenticate };

  // ---------------- Categories ----------------
  app.get('/admin/categories', { ...auth, preValidation: requirePermission('categories.manage'), schema: { tags: ['admin:catalog'], security: sec } },
    async () => (await db.query(
      `SELECT c.id, c.slug, c.parent_id AS "parentId", c.name, c.description, c.icon, c.image_key AS "imageKey", c.sort_order AS "sortOrder",
              c.is_active AS "isActive",
              coalesce((SELECT json_agg(cc.country_id) FROM service_category_countries cc WHERE cc.category_id = c.id), '[]') AS "countryIds",
              (SELECT count(*)::int FROM service_types t WHERE t.category_id = c.id) AS "typeCount"
         FROM service_categories c ORDER BY c.sort_order, c.slug`)).rows);

  async function saveCategory(categoryId: string | null, b: Partial<z.infer<typeof categoryBody>>, req: Parameters<typeof actorOf>[0]) {
    return withTx(db, async (c) => {
      let id = categoryId;
      const before = id ? (await c.query('SELECT * FROM service_categories WHERE id = $1 FOR UPDATE', [id])).rows[0] : null;
      if (id && !before) throw notFound();
      if (b.parentId && id) {
        // Walk up from the new parent; reaching this category means a cycle.
        const cyc = await c.query(
          `WITH RECURSIVE up AS (SELECT id, parent_id FROM service_categories WHERE id = $1
             UNION ALL SELECT p.id, p.parent_id FROM service_categories p JOIN up ON p.id = up.parent_id)
           SELECT 1 FROM up WHERE id = $2`, [b.parentId, id]);
        if (cyc.rowCount) throw badRequest('CATEGORY_CYCLE');
      }
      try {
        if (!id) {
          id = (await c.query<{ id: string }>(
            `INSERT INTO service_categories (slug, parent_id, name, description, icon, sort_order, is_active)
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
            [b.slug, b.parentId ?? null, JSON.stringify(b.name), b.description ? JSON.stringify(b.description) : null, b.icon ?? null,
              b.sortOrder ?? 0, b.isActive ?? true])).rows[0]!.id;
        } else {
          const has = (k: string) => Object.hasOwn(b, k);
          await c.query(
            `UPDATE service_categories SET slug = coalesce($2, slug),
               parent_id = CASE WHEN $3 THEN $4::uuid ELSE parent_id END, name = coalesce($5, name),
               description = CASE WHEN $6 THEN $7::jsonb ELSE description END, icon = CASE WHEN $8 THEN $9 ELSE icon END,
               sort_order = coalesce($10, sort_order), is_active = coalesce($11, is_active)
             WHERE id = $1`,
            [id, b.slug ?? null, has('parentId'), b.parentId ?? null, b.name ? JSON.stringify(b.name) : null,
              has('description'), b.description ? JSON.stringify(b.description) : null, has('icon'), b.icon ?? null,
              b.sortOrder ?? null, b.isActive ?? null]);
        }
      } catch (err) { mapUniqueViolation(err, { service_categories_slug: 'CODE_TAKEN' }); }
      if (b.countryIds) {
        await c.query('DELETE FROM service_category_countries WHERE category_id = $1', [id]);
        for (const countryId of new Set(b.countryIds)) {
          await c.query('INSERT INTO service_category_countries (category_id, country_id) VALUES ($1, $2)', [id, countryId]);
        }
      }
      await audit(c, actorOf(req), { action: categoryId ? 'category.updated' : 'category.created', entityType: 'service_category', entityId: id, before, after: b });
      return id!;
    });
  }

  app.post('/admin/categories', {
    ...auth, preValidation: requirePermission('categories.manage'),
    schema: { tags: ['admin:catalog'], security: sec, body: categoryBody.extend({ parentId: z.uuid().nullable().default(null), description: i18nTextSchema.nullable().default(null), icon: z.string().max(100).nullable().default(null), sortOrder: z.number().int().default(0), isActive: z.boolean().default(true), countryIds: z.array(z.uuid()).default([]) }) },
  }, async (req, reply) => {
    assertCan(requireUser(req), 'categories.manage');
    return reply.status(201).send({ id: await saveCategory(null, req.body, req) });
  });

  app.patch('/admin/categories/:id', {
    ...auth, preValidation: requirePermission('categories.manage'),
    schema: { tags: ['admin:catalog'], security: sec, params: idParams, body: categoryBody.partial() },
  }, async (req) => {
    assertCan(requireUser(req), 'categories.manage');
    if (req.body.parentId === req.params.id) throw badRequest('CATEGORY_CYCLE');
    return { id: await saveCategory(req.params.id, req.body, req) };
  });

  app.post('/admin/categories/:id/image', {
    ...auth, preValidation: requirePermission('categories.manage'), schema: { tags: ['admin:catalog'], security: sec, params: idParams, consumes: ['multipart/form-data'] },
  }, async (req) => {
    assertCan(requireUser(req), 'categories.manage');
    const file = await req.file();
    if (!file) throw badRequest('VALIDATION_FAILED', [{ path: '/file', message: 'file is required' }]);
    const stored = await deps.storage.save(`categories/${req.params.id}`, await file.toBuffer(), ['image/png', 'image/jpeg', 'image/webp']);
    return withTx(db, async (c) => {
      const before = (await c.query('SELECT image_key FROM service_categories WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
      if (!before) { await deps.storage.remove(stored.key); throw notFound(); }
      await c.query('UPDATE service_categories SET image_key = $2 WHERE id = $1', [req.params.id, stored.key]);
      await audit(c, actorOf(req), { action: 'category.image_changed', entityType: 'service_category', entityId: req.params.id, before, after: { image_key: stored.key } });
      return { imageKey: stored.key };
    });
  });

  // ---------------- Starter catalog ----------------
  /** What the starter set contains and which parts already exist here. */
  app.get('/admin/catalog/starter', { ...auth, preValidation: requirePermission('categories.manage'), schema: { tags: ['admin:catalog'], security: sec } }, async () => {
    const cats = new Set((await db.query<{ slug: string }>('SELECT slug FROM service_categories')).rows.map((r) => r.slug));
    const types = new Set((await db.query<{ code: string }>('SELECT code FROM service_types')).rows.map((r) => r.code));
    return STARTER_CATALOG.map((c) => ({
      slug: c.slug, name: c.name, exists: cats.has(c.slug),
      types: c.types.map((t) => ({ code: t.code, name: t.name, bookingMode: t.bookingMode, requiredDocuments: t.requiredDocuments ?? [], fields: t.fields.length, exists: types.has(t.code) })),
    }));
  });

  app.post('/admin/catalog/starter', {
    ...auth, preValidation: requirePermission('categories.manage'),
    schema: { tags: ['admin:catalog'], security: sec, body: z.object({ countryIds: z.array(z.uuid()).min(1).max(50), reason: reasonSchema }) },
  }, async (req) => {
    assertCan(requireUser(req), 'categories.manage');
    assertCan(requireUser(req), 'service_types.manage');
    return withTx(db, async (c) => {
      const found = (await c.query('SELECT id FROM countries WHERE id = ANY($1)', [req.body.countryIds])).rowCount;
      if (found !== new Set(req.body.countryIds).size) throw badRequest('VALIDATION_FAILED', [{ path: '/countryIds', message: 'unknown country' }]);
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['catalog:starter']);
      return importStarterCatalog(c, req.body.countryIds, actorOf(req), req.body.reason);
    });
  });

  // ---------------- Service types and their dynamic fields ----------------
  app.get('/admin/service-types', { ...auth, preValidation: requirePermission('service_types.manage'), schema: { tags: ['admin:catalog'], security: sec } },
    async () => (await db.query(
      `SELECT t.id, t.code, t.name, t.category_id AS "categoryId", t.booking_mode AS "bookingMode", t.is_active AS "isActive",
              (SELECT count(*)::int FROM services s WHERE s.service_type_id = t.id) AS "serviceCount"
         FROM service_types t ORDER BY t.code`)).rows);

  app.get('/admin/service-types/:id', { ...auth, preValidation: requirePermission('service_types.manage'), schema: { tags: ['admin:catalog'], security: sec, params: idParams } },
    async (req) => {
      const t = (await db.query('SELECT * FROM service_types WHERE id = $1', [req.params.id])).rows[0];
      if (!t) throw notFound();
      t.fields = (await db.query(
        `SELECT id, key, label, help_text AS "helpText", data_type AS "dataType", is_required AS "isRequired", validation, options,
                is_searchable AS "isSearchable", is_reportable AS "isReportable", is_public AS "isPublic", sort_order AS "sortOrder", is_active AS "isActive"
           FROM service_type_fields WHERE service_type_id = $1 ORDER BY sort_order, key`, [req.params.id])).rows;
      return t;
    });

  app.post('/admin/service-types', {
    ...auth, preValidation: requirePermission('service_types.manage'), schema: { tags: ['admin:catalog'], security: sec, body: typeCreate },
  }, async (req, reply) => {
    assertCan(requireUser(req), 'service_types.manage');
    const b = req.body;
    if (b.minImages > b.maxImages) throw badRequest('VALIDATION_FAILED', [{ path: '/minImages', message: 'must be <= maxImages' }]);
    if (b.depositRequired && b.minDepositPercent === null) throw badRequest('VALIDATION_FAILED', [{ path: '/minDepositPercent', message: 'required when depositRequired' }]);
    b.fields.forEach(validateFieldDef);
    if (new Set(b.fields.map((f) => f.key)).size !== b.fields.length) throw badRequest('FIELD_DEFINITION_INVALID', { message: 'duplicate field keys' });
    const id = await withTx(db, async (c) => {
      await assertPlatformPolicy(c, b.defaultCancellationPolicyId);
      let typeId: string;
      try {
        typeId = (await c.query<{ id: string }>(
          `INSERT INTO service_types (category_id, code, name, description, icon, booking_mode, capacity_mode, default_requires_approval,
             default_duration_minutes, buffer_before_minutes, buffer_after_minutes, pricing_units, allows_packages, min_images, max_images,
             allows_video, required_documents, deposit_required, min_deposit_percent, provider_can_create, is_active, default_cancellation_policy_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) RETURNING id`,
          [b.categoryId, b.code, JSON.stringify(b.name), b.description ? JSON.stringify(b.description) : null, b.icon, b.bookingMode, b.capacityMode,
            b.defaultRequiresApproval, b.defaultDurationMinutes, b.bufferBeforeMinutes, b.bufferAfterMinutes, b.pricingUnits, b.allowsPackages,
            b.minImages, b.maxImages, b.allowsVideo, b.requiredDocuments, b.depositRequired, b.minDepositPercent, b.providerCanCreate, b.isActive,
            b.defaultCancellationPolicyId],
        )).rows[0]!.id;
      } catch (err) { mapUniqueViolation(err, { service_types_code: 'CODE_TAKEN' }); }
      for (const f of b.fields) await insertField(c, typeId, f);
      await audit(c, actorOf(req), { action: 'service_type.created', entityType: 'service_type', entityId: typeId, after: b });
      return typeId;
    });
    return reply.status(201).send({ id });
  });

  async function insertField(c: { query: typeof db.query }, typeId: string, f: z.infer<typeof fieldBody>) {
    try {
      return (await c.query<{ id: string }>(
        `INSERT INTO service_type_fields (service_type_id, key, label, help_text, data_type, is_required, validation, options,
                                          is_searchable, is_reportable, is_public, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
        [typeId, f.key, JSON.stringify(f.label), f.helpText ? JSON.stringify(f.helpText) : null, f.dataType, f.isRequired,
          JSON.stringify(f.validation), JSON.stringify(f.options), f.isSearchable, f.isReportable, f.isPublic, f.sortOrder])).rows[0]!.id;
    } catch (err) { mapUniqueViolation(err, { service_type_fields_service_type_id_key: 'CODE_TAKEN' }); }
  }

  app.patch('/admin/service-types/:id', {
    ...auth, preValidation: requirePermission('service_types.manage'),
    schema: { tags: ['admin:catalog'], security: sec, params: idParams, body: typeFields.omit({ code: true }).partial().extend({ reason: reasonSchema.optional() }) },
  }, async (req) => {
    assertCan(requireUser(req), 'service_types.manage');
    const { reason, ...b } = req.body;
    return withTx(db, async (c) => {
      const before = (await c.query('SELECT * FROM service_types WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
      if (!before) throw notFound();
      // Booking mode decides how calendars reserve time; changing it under existing services would corrupt them.
      if (b.bookingMode && b.bookingMode !== before.booking_mode) {
        const used = await c.query('SELECT 1 FROM services WHERE service_type_id = $1 LIMIT 1', [req.params.id]);
        if (used.rowCount) throw conflict('FIELD_TYPE_LOCKED', { field: 'bookingMode' });
      }
      await assertPlatformPolicy(c, b.defaultCancellationPolicyId);
      const sets: string[] = [];
      const params: unknown[] = [req.params.id];
      for (const [k, v] of Object.entries(b)) {
        const col = TYPE_COLUMNS[k];
        if (!col || v === undefined) continue;
        params.push(JSON_COLUMNS.has(col) && v !== null ? JSON.stringify(v) : v);
        sets.push(`${col} = $${params.length}`);
      }
      if (sets.length) await c.query(`UPDATE service_types SET ${sets.join(', ')} WHERE id = $1`, params);
      const after = (await c.query('SELECT * FROM service_types WHERE id = $1', [req.params.id])).rows[0];
      if (after.min_images > after.max_images) throw badRequest('VALIDATION_FAILED', [{ path: '/minImages', message: 'must be <= maxImages' }]);
      if (after.deposit_required && after.min_deposit_percent === null) throw badRequest('VALIDATION_FAILED', [{ path: '/minDepositPercent', message: 'required when depositRequired' }]);
      await audit(c, actorOf(req), { action: 'service_type.updated', entityType: 'service_type', entityId: req.params.id, before, after, reason: reason ?? null });
      return { id: req.params.id };
    });
  });

  app.post('/admin/service-types/:id/fields', {
    ...auth, preValidation: requirePermission('service_types.manage'), schema: { tags: ['admin:catalog'], security: sec, params: idParams, body: fieldBody },
  }, async (req, reply) => {
    assertCan(requireUser(req), 'service_types.manage');
    validateFieldDef(req.body);
    const id = await withTx(db, async (c) => {
      if (!(await c.query('SELECT 1 FROM service_types WHERE id = $1', [req.params.id])).rowCount) throw notFound();
      const fieldId = await insertField(c, req.params.id, req.body);
      await audit(c, actorOf(req), { action: 'service_type.field_added', entityType: 'service_type', entityId: req.params.id, after: req.body });
      return fieldId;
    });
    return reply.status(201).send({ id });
  });

  app.patch('/admin/service-types/:id/fields/:fieldId', {
    ...auth, preValidation: requirePermission('service_types.manage'),
    schema: { tags: ['admin:catalog'], security: sec, params: z.object({ id: z.uuid(), fieldId: z.uuid() }), body: fieldBody.omit({ key: true }).partial().extend({ isActive: z.boolean().optional() }) },
  }, async (req) => {
    assertCan(requireUser(req), 'service_types.manage');
    return withTx(db, async (c) => {
      const before = (await c.query('SELECT * FROM service_type_fields WHERE id = $1 AND service_type_id = $2 FOR UPDATE', [req.params.fieldId, req.params.id])).rows[0];
      if (!before) throw notFound();
      const b = req.body;
      const merged = {
        key: before.key, label: b.label ?? before.label, helpText: b.helpText !== undefined ? b.helpText : before.help_text,
        dataType: b.dataType ?? before.data_type, isRequired: b.isRequired ?? before.is_required, validation: b.validation ?? before.validation,
        options: b.options ?? before.options, isSearchable: b.isSearchable ?? before.is_searchable, isReportable: b.isReportable ?? before.is_reportable,
        isPublic: b.isPublic ?? before.is_public, sortOrder: b.sortOrder ?? before.sort_order,
      };
      validateFieldDef(merged);
      // Stored values were validated under the old type; changing it would make them unreadable.
      if (merged.dataType !== before.data_type) {
        const used = await c.query('SELECT 1 FROM services WHERE service_type_id = $1 AND attributes ? $2 LIMIT 1', [req.params.id, before.key]);
        if (used.rowCount) throw conflict('FIELD_TYPE_LOCKED', { field: before.key });
      }
      await c.query(
        `UPDATE service_type_fields SET label = $2, help_text = $3, data_type = $4, is_required = $5, validation = $6, options = $7,
                is_searchable = $8, is_reportable = $9, is_public = $10, sort_order = $11, is_active = coalesce($12, is_active)
          WHERE id = $1`,
        [req.params.fieldId, JSON.stringify(merged.label), merged.helpText ? JSON.stringify(merged.helpText) : null, merged.dataType,
          merged.isRequired, JSON.stringify(merged.validation), JSON.stringify(merged.options), merged.isSearchable, merged.isReportable,
          merged.isPublic, merged.sortOrder, b.isActive ?? null]);
      await audit(c, actorOf(req), { action: 'service_type.field_updated', entityType: 'service_type', entityId: req.params.id, before, after: b });
      return { id: req.params.fieldId };
    });
  });

  // ---------------- Which types each provider may offer ----------------
  app.get('/admin/providers/:id/service-types', {
    ...auth, preValidation: requirePermission('providers.view'), schema: { tags: ['admin:catalog'], security: sec, params: idParams },
  }, async (req) => {
    const p = (await db.query<{ country_id: string }>('SELECT country_id FROM providers WHERE id = $1', [req.params.id])).rows[0];
    if (!p || !can(requireUser(req), 'providers.view', p.country_id)) throw notFound();
    return (await db.query(
      `SELECT t.id, t.code, t.name, g.granted_at AS "grantedAt" FROM provider_service_types g JOIN service_types t ON t.id = g.service_type_id
        WHERE g.provider_id = $1 ORDER BY t.code`, [req.params.id])).rows;
  });

  app.put('/admin/providers/:id/service-types', {
    ...auth, preValidation: requirePermission('providers.manage'),
    schema: { tags: ['admin:catalog'], security: sec, params: idParams, body: z.object({ serviceTypeIds: z.array(z.uuid()).max(200), reason: reasonSchema.optional() }) },
  }, async (req) => {
    const user = requireUser(req);
    return withTx(db, async (c) => {
      const p = (await c.query<{ country_id: string }>('SELECT country_id FROM providers WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
      if (!p) throw notFound();
      assertCan(user, 'providers.manage', p.country_id);
      const before = (await c.query<{ service_type_id: string }>('SELECT service_type_id FROM provider_service_types WHERE provider_id = $1', [req.params.id])).rows.map((r) => r.service_type_id);
      const next = [...new Set(req.body.serviceTypeIds)];
      // Revoking a type the provider still has live services of would leave orphans; unpublish those first.
      const removed = before.filter((t) => !next.includes(t));
      if (removed.length) {
        const live = await c.query(`SELECT 1 FROM services WHERE provider_id = $1 AND service_type_id = ANY($2) AND status IN ('pending_review','published') LIMIT 1`, [req.params.id, removed]);
        if (live.rowCount) throw conflict('INVALID_STATUS_TRANSITION', { reason: 'provider has live services of a removed type' });
      }
      await c.query('DELETE FROM provider_service_types WHERE provider_id = $1 AND NOT (service_type_id = ANY($2))', [req.params.id, next]);
      for (const t of next) {
        await c.query('INSERT INTO provider_service_types (provider_id, service_type_id, granted_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [req.params.id, t, user.id]);
      }
      await audit(c, actorOf(req), { action: 'provider.service_types_changed', entityType: 'provider', entityId: req.params.id, before, after: next, reason: req.body.reason ?? null });
      return { serviceTypeIds: next };
    });
  });

  // ---------------- Service moderation ----------------
  app.get('/admin/services', {
    ...auth, preValidation: requirePermission('services.view'),
    schema: {
      tags: ['admin:catalog'], security: sec,
      querystring: paginationQuery.extend({ status: z.enum(['draft', 'pending_review', 'published', 'unpublished', 'suspended']).optional(), providerId: z.uuid().optional(), typeId: z.uuid().optional(), q: z.string().max(100).optional() }),
    },
  }, async (req) => {
    const scope = countryScope(requireUser(req), 'services.view');
    const q = req.query;
    const { rows } = await db.query(
      `SELECT s.id, s.title, s.status, s.status_reason AS "statusReason", s.base_price AS "basePrice", s.currency_code AS "currency",
              s.city, co.code AS "countryCode", t.code AS "typeCode", p.id AS "providerId", p.business_name AS "providerName",
              s.updated_at AS "updatedAt", count(*) OVER() AS total
         FROM services s JOIN providers p ON p.id = s.provider_id JOIN service_types t ON t.id = s.service_type_id
         JOIN countries co ON co.id = s.country_id
        WHERE ($1::uuid[] IS NULL OR s.country_id = ANY($1)) AND ($2::text IS NULL OR s.status = $2)
          AND ($3::uuid IS NULL OR s.provider_id = $3) AND ($4::uuid IS NULL OR s.service_type_id = $4)
          AND ($5::text IS NULL OR s.title::text ILIKE '%' || $5 || '%')
        ORDER BY s.updated_at DESC LIMIT $6 OFFSET $7`,
      [scope, q.status ?? null, q.providerId ?? null, q.typeId ?? null, q.q ?? null, q.limit, q.offset]);
    return { total: Number(rows[0]?.total ?? 0), items: rows.map(({ total: _t, ...r }) => r) };
  });

  app.get('/admin/services/:id', {
    ...auth, preValidation: requirePermission('services.view'), schema: { tags: ['admin:catalog'], security: sec, params: idParams },
  }, async (req) => {
    const s = await serviceDetail(db, req.params.id, { audience: 'staff', lang: 'ar' });
    if (!s || !can(requireUser(req), 'services.view', s.countryId)) throw notFound();
    return s;
  });

  app.post('/admin/services/:id/actions', {
    // The exact permission depends on the action and country (checked in the handler); staff only before validation.
    ...auth, preValidation: requireKind('staff'),
    schema: {
      tags: ['admin:catalog'], security: sec, params: idParams,
      body: z.object({ action: z.enum(Object.keys(MODERATION) as [ModerationAction, ...ModerationAction[]]), reason: reasonSchema.optional() }),
    },
  }, async (req) => {
    const user = requireUser(req);
    if (user.kind !== 'staff') throw notFound();
    const rule = MODERATION[req.body.action];
    return withTx(db, async (c) => {
      const s = (await c.query<{ status: ServiceStatus; country_id: string; provider_id: string }>(
        'SELECT status, country_id, provider_id FROM services WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
      if (!s) throw notFound();
      assertCan(user, rule.perm, s.country_id);
      if (!rule.from.includes(s.status)) throw conflict('INVALID_STATUS_TRANSITION', { from: s.status, action: req.body.action });
      if (rule.reason && !req.body.reason) throw badRequest('REASON_REQUIRED');
      await c.query(
        `UPDATE services SET status = $2, status_reason = $3, published_at = CASE WHEN $2 = 'published' THEN now() ELSE published_at END WHERE id = $1`,
        [req.params.id, rule.to, req.body.reason ?? null]);
      await recordServiceStatus(c, req.params.id, s.status, rule.to, user.id, req.body.reason ?? null);
      await audit(c, actorOf(req), { action: `service.${req.body.action}`, entityType: 'service', entityId: req.params.id, before: { status: s.status }, after: { status: rule.to }, reason: req.body.reason ?? null });
      const owner = (await c.query<{ id: string; phone: string | null; preferred_language: string }>(
        'SELECT u.id, u.phone, u.preferred_language FROM providers p JOIN users u ON u.id = p.user_id WHERE p.id = $1', [s.provider_id])).rows[0]!;
      if (owner.phone) {
        await enqueueMessage(c, { channel: 'sms', recipientUserId: owner.id, target: owner.phone, templateKey: `service.${req.body.action}`, language: owner.preferred_language, payload: { serviceId: req.params.id, reason: req.body.reason ?? null } });
      }
      return { status: rule.to };
    });
  });

  // ---------------- Platform-wide cancellation policies ----------------
  app.get('/admin/cancellation-policies', { ...auth, preValidation: requirePermission('services.manage'), schema: { tags: ['admin:catalog'], security: sec } },
    async () => (await db.query(`SELECT ${POLICY_COLUMNS} FROM cancellation_policies WHERE provider_id IS NULL ORDER BY created_at`)).rows);

  app.post('/admin/cancellation-policies', {
    ...auth, preValidation: requirePermission('services.manage'), schema: { tags: ['admin:catalog'], security: sec, body: policyBody },
  }, async (req, reply) => {
    assertCan(requireUser(req), 'services.manage');
    const id = await withTx(db, async (c) => {
      const policyId = (await c.query<{ id: string }>(
        `INSERT INTO cancellation_policies (provider_id, name, description, tiers, deposit_refundable, self_cancel_allowed, requires_manual_review, is_active)
         VALUES (NULL, $1, $2, $3, $4, $5, $6, $7) RETURNING id`, policyParams(req.body))).rows[0]!.id;
      await audit(c, actorOf(req), { action: 'cancellation_policy.created', entityType: 'cancellation_policy', entityId: policyId, after: req.body });
      return policyId;
    });
    return reply.status(201).send({ id });
  });
}
