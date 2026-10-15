import type pg from 'pg';
import { z } from 'zod';
import type { App, Deps } from '../../deps.js';
import { actorOf, requireKind, requireUser } from '../../auth/guard.js';
import { withTx, type Executor } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { badRequest, conflict, forbidden, mapUniqueViolation, notFound } from '../../lib/errors.js';
import { pickLang } from '../../lib/i18n.js';
import { IMAGE_TYPES, VIDEO_TYPES } from '../../lib/storage.js';
import { i18nTextSchema, idParams } from '../common.js';
import { getSetting } from '../settings/registry.js';
import { validateAttributes } from './fields.js';
import { POLICY_COLUMNS, policyBody, policyParams } from './policies.js';
import { serviceDetail } from './queries.js';
import {
  addOnSchema, assertCurrencyAllowed, assertDepositRules, assertDepositShape, assertPlanShape, conflictStatus, currencyCode, depositFields, i18nList,
  loadFields, loadType, moneySchema, PRICING_UNITS, providerOf, recordServiceStatus, type ProviderRow, type TypeRow,
} from './shared.js';

const sec = [{ bearer: [] }];

const serviceFields = z.object({
  title: i18nTextSchema,
  description: i18nTextSchema,
  terms: i18nTextSchema.nullable(),
  city: z.string().trim().min(2).max(100),
  address: z.string().trim().max(500).nullable(),
  latitude: z.number().min(-90).max(90).nullable(),
  longitude: z.number().min(-180).max(180).nullable(),
  basePrice: moneySchema,
  currency: currencyCode,
  pricingUnit: z.enum(PRICING_UNITS),
  durationMinutes: z.number().int().positive().max(60 * 24 * 30).nullable(),
  capacity: z.number().int().positive().nullable(),
  requiresProviderApproval: z.boolean(),
  cancellationPolicyId: z.uuid().nullable(),
  attributes: z.record(z.string(), z.unknown()),
  maxConcurrentBookings: z.number().int().min(1).max(1000),
  slotStepMinutes: z.number().int().min(5).max(1440).nullable(),
  ...depositFields,
});

const serviceCreate = serviceFields.extend({
  serviceTypeId: z.uuid(),
  terms: i18nTextSchema.nullable().default(null),
  address: z.string().trim().max(500).nullable().default(null),
  latitude: z.number().min(-90).max(90).nullable().default(null),
  longitude: z.number().min(-180).max(180).nullable().default(null),
  durationMinutes: z.number().int().positive().nullable().optional(),
  capacity: z.number().int().positive().nullable().default(null),
  // Omitted = use the type's default (D5); explicit value overrides it for this service only.
  requiresProviderApproval: z.boolean().optional(),
  cancellationPolicyId: z.uuid().nullable().default(null),
  attributes: z.record(z.string(), z.unknown()).default({}),
  maxConcurrentBookings: z.number().int().min(1).max(1000).default(1),
  slotStepMinutes: z.number().int().min(5).max(1440).nullable().default(null),
  depositType: z.enum(['none', 'fixed', 'percent']).default('none'),
  depositValue: moneySchema.default('0'),
  balanceDueDaysBefore: z.number().int().min(0).max(365).default(0),
  instalmentPlan: depositFields.instalmentPlan.default(null),
});

const packageFields = z.object({
  name: i18nTextSchema,
  description: i18nTextSchema.nullable(),
  price: moneySchema,
  currency: currencyCode,
  pricingUnit: z.enum(PRICING_UNITS),
  durationMinutes: z.number().int().positive().nullable(),
  inclusions: i18nList,
  addOns: z.array(addOnSchema).max(50).refine((a) => new Set(a.map((x) => x.code)).size === a.length, 'duplicate add-on codes'),
  terms: i18nTextSchema.nullable(),
  availableWeekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  maxBookingsPerSlot: z.number().int().positive().max(10_000),
  validFrom: z.iso.date().nullable(),
  validTo: z.iso.date().nullable(),
  sortOrder: z.number().int(),
  status: z.enum(['active', 'inactive']),
  ...depositFields,
});
const packageCreate = packageFields.extend({
  description: i18nTextSchema.nullable().default(null), durationMinutes: z.number().int().positive().nullable().default(null),
  inclusions: i18nList.default([]), addOns: packageFields.shape.addOns.default([]), terms: i18nTextSchema.nullable().default(null),
  availableWeekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7).default([0, 1, 2, 3, 4, 5, 6]),
  maxBookingsPerSlot: z.number().int().positive().max(10_000).default(1), validFrom: z.iso.date().nullable().default(null),
  validTo: z.iso.date().nullable().default(null), sortOrder: z.number().int().default(0), status: z.enum(['active', 'inactive']).default('active'),
  depositType: z.enum(['none', 'fixed', 'percent']).default('none'), depositValue: moneySchema.default('0'),
  balanceDueDaysBefore: z.number().int().min(0).max(365).default(0),
  instalmentPlan: depositFields.instalmentPlan.default(null),
});

const rentalFields = z.object({
  sku: z.string().trim().regex(/^[A-Za-z0-9._-]{1,50}$/),
  name: i18nTextSchema,
  attributes: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,49}$/), z.union([z.string().max(100), z.number()])),
  quantityTotal: z.number().int().min(0).max(100_000),
  condition: z.enum(['new', 'excellent', 'good', 'fair']),
  pricePerDay: moneySchema,
  pricePerPeriod: moneySchema.nullable(),
  periodDays: z.number().int().positive().max(365).nullable(),
  currency: currencyCode,
  securityDeposit: moneySchema,
  lateFeePerDay: moneySchema,
  damageTerms: i18nTextSchema.nullable(),
  status: z.enum(['active', 'inactive']),
});
const rentalCreate = rentalFields.extend({
  attributes: rentalFields.shape.attributes.default({}), condition: z.enum(['new', 'excellent', 'good', 'fair']).default('good'),
  pricePerPeriod: moneySchema.nullable().default(null), periodDays: z.number().int().positive().max(365).nullable().default(null),
  securityDeposit: moneySchema.default('0'), lateFeePerDay: moneySchema.default('0'), damageTerms: i18nTextSchema.nullable().default(null),
  status: z.enum(['active', 'inactive']).default('active'),
});

interface ServiceRow {
  id: string; provider_id: string; service_type_id: string; country_id: string; status: string; base_price: string;
  attributes: Record<string, unknown>; capacity: number | null; latitude: string | null; deposit_type: string; deposit_value: string; instalment_plan: unknown[] | null;
}

async function lockOwnService(c: Executor, provider: ProviderRow, id: string): Promise<ServiceRow> {
  const s = (await c.query<ServiceRow>('SELECT * FROM services WHERE id = $1 FOR UPDATE', [id])).rows[0];
  // Same answer for "missing" and "someone else's" (clause 8: no access to other providers' data).
  if (!s || s.provider_id !== provider.id) throw notFound();
  if (s.status === 'suspended') throw conflictStatus(s.status, 'edit');
  return s;
}

/** A media item can only illustrate a package of its own service. */
async function assertPackageOf(c: Executor, packageId: string | null, serviceId: string) {
  if (!packageId) return;
  const r = await c.query('SELECT 1 FROM packages WHERE id = $1 AND service_id = $2', [packageId, serviceId]);
  if (!r.rowCount) throw badRequest('VALIDATION_FAILED', [{ path: '/packageId', message: 'package not found on this service' }]);
}

async function assertTypeGranted(c: Executor, provider: ProviderRow, type: TypeRow) {
  if (!type.is_active) throw badRequest('SERVICE_TYPE_INACTIVE');
  if (!type.provider_can_create) throw forbidden('SERVICE_TYPE_NOT_ALLOWED');
  const g = await c.query('SELECT 1 FROM provider_service_types WHERE provider_id = $1 AND service_type_id = $2', [provider.id, type.id]);
  if (!g.rowCount) throw forbidden('SERVICE_TYPE_NOT_ALLOWED');
  const cat = await c.query('SELECT 1 FROM service_category_countries WHERE category_id = $1 AND country_id = $2', [type.category_id, provider.country_id]);
  if (!cat.rowCount) throw badRequest('CATEGORY_NOT_AVAILABLE');
}

function assertCapacity(type: TypeRow, capacity: number | null) {
  if (type.capacity_mode === 'none' && capacity !== null) throw badRequest('CAPACITY_NOT_APPLICABLE');
  if (type.capacity_mode !== 'none' && capacity === null) throw badRequest('CAPACITY_REQUIRED');
}

async function assertPolicyUsable(c: Executor, provider: ProviderRow, policyId: string | null) {
  if (!policyId) return;
  const ok = await c.query('SELECT 1 FROM cancellation_policies WHERE id = $1 AND is_active AND (provider_id IS NULL OR provider_id = $2)', [policyId, provider.id]);
  if (!ok.rowCount) throw badRequest('POLICY_NOT_USABLE');
}

async function ownedServiceForChild(c: pg.PoolClient, provider: ProviderRow, serviceId: string) {
  const s = await lockOwnService(c, provider, serviceId);
  return { service: s, type: await loadType(c, s.service_type_id) };
}

export async function catalogProviderRoutes(app: App, deps: Deps) {
  const { db } = deps;
  const guard = { onRequest: deps.authenticate, preValidation: requireKind('provider') };

  app.get('/provider/service-types', { ...guard, schema: { tags: ['provider-panel'], security: sec } }, async (req) => {
    const p = await providerOf(db, req, { forWrite: false });
    const types = (await db.query(
      `SELECT t.id, t.code, t.name, t.description, t.icon, t.booking_mode AS "bookingMode", t.capacity_mode AS "capacityMode",
              t.default_requires_approval AS "defaultRequiresApproval", t.default_duration_minutes AS "defaultDurationMinutes",
              t.pricing_units AS "pricingUnits", t.allows_packages AS "allowsPackages", t.min_images AS "minImages", t.max_images AS "maxImages",
              t.allows_video AS "allowsVideo", t.deposit_required AS "depositRequired", t.min_deposit_percent AS "minDepositPercent"
         FROM provider_service_types g JOIN service_types t ON t.id = g.service_type_id
        WHERE g.provider_id = $1 AND t.is_active AND t.provider_can_create ORDER BY t.code`, [p.id])).rows;
    for (const t of types) {
      t.fields = (await db.query(
        `SELECT key, label, help_text AS "helpText", data_type AS "dataType", is_required AS "isRequired", validation, options
           FROM service_type_fields WHERE service_type_id = $1 AND is_active ORDER BY sort_order, key`, [t.id])).rows;
    }
    return types;
  });

  // ---------------- Cancellation policies ----------------
  app.get('/provider/cancellation-policies', { ...guard, schema: { tags: ['provider-panel'], security: sec } }, async (req) => {
    const p = await providerOf(db, req, { forWrite: false });
    return (await db.query(`SELECT ${POLICY_COLUMNS} FROM cancellation_policies WHERE (provider_id = $1 OR provider_id IS NULL) ORDER BY provider_id NULLS FIRST, created_at`, [p.id])).rows;
  });

  app.post('/provider/cancellation-policies', { ...guard, schema: { tags: ['provider-panel'], security: sec, body: policyBody } }, async (req, reply) => {
    const id = await withTx(db, async (c) => {
      const p = await providerOf(c, req, { forWrite: true });
      const policyId = (await c.query<{ id: string }>(
        `INSERT INTO cancellation_policies (provider_id, name, description, tiers, deposit_refundable, self_cancel_allowed, requires_manual_review, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`, [p.id, ...policyParams(req.body)])).rows[0]!.id;
      await audit(c, actorOf(req), { action: 'cancellation_policy.created', entityType: 'cancellation_policy', entityId: policyId, after: req.body });
      return policyId;
    });
    return reply.status(201).send({ id });
  });

  // ---------------- Services ----------------
  app.get('/provider/services', { ...guard, schema: { tags: ['provider-panel'], security: sec } }, async (req) => {
    const p = await providerOf(db, req, { forWrite: false });
    return (await db.query(
      `SELECT s.id, s.title, s.status, s.status_reason AS "statusReason", s.base_price AS "basePrice", s.currency_code AS currency,
              t.code AS "typeCode", s.requires_provider_approval AS "requiresProviderApproval", s.updated_at AS "updatedAt"
         FROM services s JOIN service_types t ON t.id = s.service_type_id WHERE s.provider_id = $1 ORDER BY s.created_at DESC`, [p.id])).rows;
  });

  app.get('/provider/services/:id', { ...guard, schema: { tags: ['provider-panel'], security: sec, params: idParams } }, async (req) => {
    const p = await providerOf(db, req, { forWrite: false });
    const s = await serviceDetail(db, req.params.id, { audience: 'owner', lang: pickLang(req.headers['accept-language']) });
    if (!s || s.providerId !== p.id) throw notFound();
    return s;
  });

  app.post('/provider/services', { ...guard, schema: { tags: ['provider-panel'], security: sec, body: serviceCreate } }, async (req, reply) => {
    const b = req.body;
    const id = await withTx(db, async (c) => {
      const p = await providerOf(c, req, { forWrite: true });
      const type = await loadType(c, b.serviceTypeId);
      await assertTypeGranted(c, p, type);
      if (!type.pricing_units.includes(b.pricingUnit)) throw badRequest('PRICING_UNIT_NOT_ALLOWED');
      assertCapacity(type, b.capacity);
      await assertCurrencyAllowed(c, p.country_id, b.currency);
      await assertPolicyUsable(c, p, b.cancellationPolicyId);
      const deposit = { type: b.depositType, value: b.depositValue };
      assertDepositShape(deposit, b.basePrice);
      assertDepositRules(type, deposit, b.basePrice);
      assertPlanShape(b.depositType, b.instalmentPlan);
      if ((b.latitude === null) !== (b.longitude === null)) throw badRequest('VALIDATION_FAILED', [{ path: '/latitude', message: 'latitude and longitude go together' }]);
      const { active } = await loadFields(c, type.id);
      // Drafts may be incomplete: required-ness is enforced at submission, types and rules always.
      const v = validateAttributes(active.map((f) => ({ ...f, is_required: false })), b.attributes);
      if (!v.ok) throw badRequest('ATTRIBUTES_INVALID', v.issues);

      const serviceId = (await c.query<{ id: string }>(
        `INSERT INTO services (provider_id, service_type_id, country_id, city, address, latitude, longitude, title, description, terms,
           base_price, currency_code, pricing_unit, duration_minutes, capacity, requires_provider_approval, cancellation_policy_id,
           deposit_type, deposit_value, balance_due_days_before, attributes, max_concurrent_bookings, slot_step_minutes, instalment_plan)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24) RETURNING id`,
        [p.id, type.id, p.country_id, b.city, b.address, b.latitude, b.longitude, JSON.stringify(b.title), JSON.stringify(b.description),
          b.terms ? JSON.stringify(b.terms) : null, b.basePrice, b.currency, b.pricingUnit, b.durationMinutes ?? type.default_duration_minutes,
          b.capacity, b.requiresProviderApproval ?? type.default_requires_approval, b.cancellationPolicyId, b.depositType, b.depositValue,
          b.balanceDueDaysBefore, JSON.stringify(v.value), b.maxConcurrentBookings, b.slotStepMinutes,
          b.instalmentPlan ? JSON.stringify(b.instalmentPlan) : null])).rows[0]!.id;
      await recordServiceStatus(c, serviceId, null, 'draft', requireUser(req).id, null);
      await audit(c, actorOf(req), { action: 'service.created', entityType: 'service', entityId: serviceId, after: b });
      return serviceId;
    });
    return reply.status(201).send({ id });
  });

  app.patch('/provider/services/:id', {
    ...guard, schema: { tags: ['provider-panel'], security: sec, params: idParams, body: serviceFields.partial() },
  }, async (req) => {
    const b = req.body;
    return withTx(db, async (c) => {
      const p = await providerOf(c, req, { forWrite: true });
      const before = await lockOwnService(c, p, req.params.id);
      const type = await loadType(c, before.service_type_id);
      if (b.pricingUnit && !type.pricing_units.includes(b.pricingUnit)) throw badRequest('PRICING_UNIT_NOT_ALLOWED');
      if (b.capacity !== undefined) assertCapacity(type, b.capacity);
      if (b.currency) await assertCurrencyAllowed(c, p.country_id, b.currency);
      if (b.cancellationPolicyId !== undefined) await assertPolicyUsable(c, p, b.cancellationPolicyId);
      const price = b.basePrice ?? before.base_price;
      const deposit = { type: b.depositType ?? before.deposit_type, value: b.depositValue ?? (b.depositType === 'none' ? '0' : before.deposit_value) };
      assertDepositShape(deposit, price);
      assertDepositRules(type, deposit, price);
      const plan = Object.hasOwn(b, 'instalmentPlan') ? b.instalmentPlan ?? null : before.instalment_plan;
      assertPlanShape(deposit.type, plan);

      let attributes: Record<string, unknown> | null = null;
      if (b.attributes) {
        const { active, inactiveKeys } = await loadFields(c, type.id);
        // A live service must keep satisfying required fields; drafts may stay partial.
        const enforceRequired = before.status === 'published' || before.status === 'pending_review';
        const v = validateAttributes(enforceRequired ? active : active.map((f) => ({ ...f, is_required: false })), b.attributes, before.attributes, inactiveKeys);
        if (!v.ok) throw badRequest('ATTRIBUTES_INVALID', v.issues);
        attributes = v.value;
      }
      const has = (k: string) => Object.hasOwn(b, k);
      await c.query(
        `UPDATE services SET title = coalesce($2, title), description = coalesce($3, description),
           terms = CASE WHEN $4 THEN $5::jsonb ELSE terms END, city = coalesce($6, city),
           address = CASE WHEN $7 THEN $8 ELSE address END,
           latitude = CASE WHEN $9 THEN $10::numeric ELSE latitude END, longitude = CASE WHEN $9 THEN $11::numeric ELSE longitude END,
           base_price = coalesce($12, base_price), currency_code = coalesce($13, currency_code), pricing_unit = coalesce($14, pricing_unit),
           duration_minutes = CASE WHEN $15 THEN $16::int ELSE duration_minutes END, capacity = CASE WHEN $17 THEN $18::int ELSE capacity END,
           requires_provider_approval = coalesce($19, requires_provider_approval),
           cancellation_policy_id = CASE WHEN $20 THEN $21::uuid ELSE cancellation_policy_id END,
           deposit_type = $22, deposit_value = $23, balance_due_days_before = coalesce($24, balance_due_days_before),
           attributes = coalesce($25, attributes), max_concurrent_bookings = coalesce($26, max_concurrent_bookings),
           slot_step_minutes = CASE WHEN $27 THEN $28::int ELSE slot_step_minutes END, instalment_plan = $29::jsonb
         WHERE id = $1`,
        [req.params.id, b.title ? JSON.stringify(b.title) : null, b.description ? JSON.stringify(b.description) : null,
          has('terms'), b.terms ? JSON.stringify(b.terms) : null, b.city ?? null, has('address'), b.address ?? null,
          has('latitude') || has('longitude'), b.latitude ?? null, b.longitude ?? null, b.basePrice ?? null, b.currency ?? null,
          b.pricingUnit ?? null, has('durationMinutes'), b.durationMinutes ?? null, has('capacity'), b.capacity ?? null,
          b.requiresProviderApproval ?? null, has('cancellationPolicyId'), b.cancellationPolicyId ?? null, deposit.type, deposit.value,
          b.balanceDueDaysBefore ?? null, attributes ? JSON.stringify(attributes) : null, b.maxConcurrentBookings ?? null,
          has('slotStepMinutes'), b.slotStepMinutes ?? null, plan ? JSON.stringify(plan) : null]);
      const after = (await c.query('SELECT latitude, longitude FROM services WHERE id = $1', [req.params.id])).rows[0];
      if ((after.latitude === null) !== (after.longitude === null)) throw badRequest('VALIDATION_FAILED', [{ path: '/latitude', message: 'latitude and longitude go together' }]);
      // Price and terms changes are audited with before/after; existing bookings keep their own snapshot (phase 5).
      await audit(c, actorOf(req), { action: 'service.updated', entityType: 'service', entityId: req.params.id, before, after: b });
      return { id: req.params.id };
    });
  });

  app.post('/provider/services/:id/submit', { ...guard, schema: { tags: ['provider-panel'], security: sec, params: idParams } }, async (req) => {
    return withTx(db, async (c) => {
      const p = await providerOf(c, req, { forWrite: true });
      const s = await lockOwnService(c, p, req.params.id);
      if (!['draft', 'unpublished'].includes(s.status)) throw conflictStatus(s.status, 'submit');
      const type = await loadType(c, s.service_type_id);
      await assertTypeGranted(c, p, type);

      const { active, inactiveKeys } = await loadFields(c, type.id);
      const v = validateAttributes(active, Object.fromEntries(Object.entries(s.attributes).filter(([k]) => !inactiveKeys.includes(k))), s.attributes, inactiveKeys);
      if (!v.ok) throw badRequest('ATTRIBUTES_INVALID', v.issues);
      const images = Number((await c.query<{ n: string }>(`SELECT count(*) AS n FROM service_media WHERE service_id = $1 AND kind = 'image'`, [s.id])).rows[0]!.n);
      if (images < type.min_images) throw badRequest('MIN_IMAGES_REQUIRED', { minImages: type.min_images, current: images });
      if (type.booking_mode === 'quantity_rental') {
        const items = await c.query(`SELECT 1 FROM rental_items WHERE service_id = $1 AND status = 'active' AND quantity_total > 0`, [s.id]);
        if (!items.rowCount) throw badRequest('VALIDATION_FAILED', [{ path: '/rentalItems', message: 'at least one active item with stock is required' }]);
      }
      assertDepositRules(type, { type: s.deposit_type, value: s.deposit_value }, s.base_price);

      const needsReview = await getSetting(c, 'services.require_review', p.country_id);
      const to = needsReview ? 'pending_review' : 'published';
      await c.query(`UPDATE services SET status = $2, status_reason = NULL, published_at = CASE WHEN $2 = 'published' THEN now() ELSE published_at END WHERE id = $1`, [s.id, to]);
      await recordServiceStatus(c, s.id, s.status, to, requireUser(req).id, null);
      await audit(c, actorOf(req), { action: 'service.submitted', entityType: 'service', entityId: s.id, before: { status: s.status }, after: { status: to } });
      return { status: to };
    });
  });

  app.post('/provider/services/:id/unpublish', { ...guard, schema: { tags: ['provider-panel'], security: sec, params: idParams } }, async (req) => {
    return withTx(db, async (c) => {
      // Unpublishing is allowed even while suspended as a provider: it only reduces exposure.
      const p = await providerOf(c, req, { forWrite: false });
      const s = await lockOwnService(c, p, req.params.id);
      if (!['published', 'pending_review'].includes(s.status)) throw conflictStatus(s.status, 'unpublish');
      await c.query(`UPDATE services SET status = 'unpublished' WHERE id = $1`, [s.id]);
      await recordServiceStatus(c, s.id, s.status, 'unpublished', requireUser(req).id, null);
      await audit(c, actorOf(req), { action: 'service.unpublished_by_provider', entityType: 'service', entityId: s.id, before: { status: s.status }, after: { status: 'unpublished' } });
      return { status: 'unpublished' };
    });
  });

  // ---------------- Packages ----------------
  async function checkPackage(c: Executor, p: ProviderRow, type: TypeRow, b: { price: string; currency: string; pricingUnit: string; depositType: string; depositValue: string; validFrom: string | null; validTo: string | null }) {
    if (!type.allows_packages) throw badRequest('PACKAGES_NOT_ALLOWED');
    if (!type.pricing_units.includes(b.pricingUnit)) throw badRequest('PRICING_UNIT_NOT_ALLOWED');
    await assertCurrencyAllowed(c, p.country_id, b.currency);
    const deposit = { type: b.depositType, value: b.depositValue };
    assertDepositShape(deposit, b.price);
    assertDepositRules(type, deposit, b.price);
    if (b.validFrom && b.validTo && b.validTo < b.validFrom) throw badRequest('VALIDATION_FAILED', [{ path: '/validTo', message: 'must be on or after validFrom' }]);
  }

  app.post('/provider/services/:id/packages', { ...guard, schema: { tags: ['provider-panel'], security: sec, params: idParams, body: packageCreate } }, async (req, reply) => {
    const b = req.body;
    const id = await withTx(db, async (c) => {
      const p = await providerOf(c, req, { forWrite: true });
      const { type } = await ownedServiceForChild(c, p, req.params.id);
      await checkPackage(c, p, type, b);
      assertPlanShape(b.depositType, b.instalmentPlan);
      const pkgId = (await c.query<{ id: string }>(
        `INSERT INTO packages (service_id, name, description, price, currency_code, pricing_unit, duration_minutes, inclusions, add_ons, terms,
           available_weekdays, max_bookings_per_slot, deposit_type, deposit_value, balance_due_days_before, valid_from, valid_to, sort_order, status, instalment_plan)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING id`,
        [req.params.id, JSON.stringify(b.name), b.description ? JSON.stringify(b.description) : null, b.price, b.currency, b.pricingUnit,
          b.durationMinutes, JSON.stringify(b.inclusions), JSON.stringify(b.addOns), b.terms ? JSON.stringify(b.terms) : null,
          [...new Set(b.availableWeekdays)], b.maxBookingsPerSlot, b.depositType, b.depositValue, b.balanceDueDaysBefore, b.validFrom, b.validTo,
          b.sortOrder, b.status, b.instalmentPlan ? JSON.stringify(b.instalmentPlan) : null])).rows[0]!.id;
      await audit(c, actorOf(req), { action: 'package.created', entityType: 'package', entityId: pkgId, after: { serviceId: req.params.id, ...b } });
      return pkgId;
    });
    return reply.status(201).send({ id });
  });

  app.patch('/provider/packages/:id', { ...guard, schema: { tags: ['provider-panel'], security: sec, params: idParams, body: packageFields.partial() } }, async (req) => {
    return withTx(db, async (c) => {
      const p = await providerOf(c, req, { forWrite: true });
      const before = (await c.query('SELECT * FROM packages WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
      if (!before) throw notFound();
      const { type } = await ownedServiceForChild(c, p, before.service_id);
      const b = req.body;
      const merged = {
        price: b.price ?? before.price, currency: b.currency ?? before.currency_code.trim(), pricingUnit: b.pricingUnit ?? before.pricing_unit,
        depositType: b.depositType ?? before.deposit_type, depositValue: b.depositValue ?? (b.depositType === 'none' ? '0' : before.deposit_value),
        validFrom: b.validFrom !== undefined ? b.validFrom : before.valid_from,
        validTo: b.validTo !== undefined ? b.validTo : before.valid_to,
      };
      await checkPackage(c, p, type, merged);
      const has = (k: string) => Object.hasOwn(b, k);
      const plan = has('instalmentPlan') ? b.instalmentPlan ?? null : before.instalment_plan;
      assertPlanShape(merged.depositType, plan);
      await c.query(
        `UPDATE packages SET name = coalesce($2, name), description = CASE WHEN $3 THEN $4::jsonb ELSE description END,
           price = $5, currency_code = $6, pricing_unit = $7, duration_minutes = CASE WHEN $8 THEN $9::int ELSE duration_minutes END,
           inclusions = coalesce($10, inclusions), add_ons = coalesce($11, add_ons), terms = CASE WHEN $12 THEN $13::jsonb ELSE terms END,
           available_weekdays = coalesce($14, available_weekdays), max_bookings_per_slot = coalesce($15, max_bookings_per_slot),
           deposit_type = $16, deposit_value = $17, balance_due_days_before = coalesce($18, balance_due_days_before),
           valid_from = $19, valid_to = $20, sort_order = coalesce($21, sort_order), status = coalesce($22, status), instalment_plan = $23::jsonb
         WHERE id = $1`,
        [req.params.id, b.name ? JSON.stringify(b.name) : null, has('description'), b.description ? JSON.stringify(b.description) : null,
          merged.price, merged.currency, merged.pricingUnit, has('durationMinutes'), b.durationMinutes ?? null,
          b.inclusions ? JSON.stringify(b.inclusions) : null, b.addOns ? JSON.stringify(b.addOns) : null, has('terms'),
          b.terms ? JSON.stringify(b.terms) : null, b.availableWeekdays ? [...new Set(b.availableWeekdays)] : null, b.maxBookingsPerSlot ?? null,
          merged.depositType, merged.depositValue, b.balanceDueDaysBefore ?? null, merged.validFrom, merged.validTo, b.sortOrder ?? null, b.status ?? null,
          plan ? JSON.stringify(plan) : null]);
      await audit(c, actorOf(req), { action: 'package.updated', entityType: 'package', entityId: req.params.id, before, after: b });
      return { id: req.params.id };
    });
  });

  // ---------------- Rentable items ----------------
  app.post('/provider/services/:id/rental-items', { ...guard, schema: { tags: ['provider-panel'], security: sec, params: idParams, body: rentalCreate } }, async (req, reply) => {
    const b = req.body;
    const id = await withTx(db, async (c) => {
      const p = await providerOf(c, req, { forWrite: true });
      const { type } = await ownedServiceForChild(c, p, req.params.id);
      if (type.booking_mode !== 'quantity_rental') throw badRequest('RENTAL_ITEMS_NOT_ALLOWED');
      await assertCurrencyAllowed(c, p.country_id, b.currency);
      if ((b.pricePerPeriod === null) !== (b.periodDays === null)) throw badRequest('VALIDATION_FAILED', [{ path: '/periodDays', message: 'pricePerPeriod and periodDays go together' }]);
      let itemId: string;
      try {
        itemId = (await c.query<{ id: string }>(
          `INSERT INTO rental_items (service_id, sku, name, attributes, quantity_total, condition, price_per_day, price_per_period, period_days,
             currency_code, security_deposit, late_fee_per_day, damage_terms, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
          [req.params.id, b.sku, JSON.stringify(b.name), JSON.stringify(b.attributes), b.quantityTotal, b.condition, b.pricePerDay, b.pricePerPeriod,
            b.periodDays, b.currency, b.securityDeposit, b.lateFeePerDay, b.damageTerms ? JSON.stringify(b.damageTerms) : null, b.status])).rows[0]!.id;
      } catch (err) { mapUniqueViolation(err, { rental_items_service_id_sku: 'CODE_TAKEN' }); }
      await audit(c, actorOf(req), { action: 'rental_item.created', entityType: 'rental_item', entityId: itemId, after: { serviceId: req.params.id, ...b } });
      return itemId;
    });
    return reply.status(201).send({ id });
  });

  app.patch('/provider/rental-items/:id', { ...guard, schema: { tags: ['provider-panel'], security: sec, params: idParams, body: rentalFields.omit({ sku: true }).partial() } }, async (req) => {
    return withTx(db, async (c) => {
      const p = await providerOf(c, req, { forWrite: true });
      const before = (await c.query('SELECT * FROM rental_items WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
      if (!before) throw notFound();
      await ownedServiceForChild(c, p, before.service_id);
      const b = req.body;
      if (b.currency) await assertCurrencyAllowed(c, p.country_id, b.currency);
      const has = (k: string) => Object.hasOwn(b, k);
      await c.query(
        `UPDATE rental_items SET name = coalesce($2, name), attributes = coalesce($3, attributes), quantity_total = coalesce($4, quantity_total),
           condition = coalesce($5, condition), price_per_day = coalesce($6, price_per_day),
           price_per_period = CASE WHEN $7 THEN $8::numeric ELSE price_per_period END, period_days = CASE WHEN $7 THEN $9::int ELSE period_days END,
           currency_code = coalesce($10, currency_code), security_deposit = coalesce($11, security_deposit), late_fee_per_day = coalesce($12, late_fee_per_day),
           damage_terms = CASE WHEN $13 THEN $14::jsonb ELSE damage_terms END, status = coalesce($15, status)
         WHERE id = $1`,
        [req.params.id, b.name ? JSON.stringify(b.name) : null, b.attributes ? JSON.stringify(b.attributes) : null, b.quantityTotal ?? null,
          b.condition ?? null, b.pricePerDay ?? null, has('pricePerPeriod') || has('periodDays'), b.pricePerPeriod ?? null, b.periodDays ?? null,
          b.currency ?? null, b.securityDeposit ?? null, b.lateFeePerDay ?? null, has('damageTerms'), b.damageTerms ? JSON.stringify(b.damageTerms) : null, b.status ?? null])
        .catch((err) => { if (err.code === '23514') throw badRequest('VALIDATION_FAILED', [{ path: '/periodDays', message: 'pricePerPeriod and periodDays go together' }]); throw err; });
      await audit(c, actorOf(req), { action: 'rental_item.updated', entityType: 'rental_item', entityId: req.params.id, before, after: b });
      return { id: req.params.id };
    });
  });

  // ---------------- Media ----------------
  app.post('/provider/services/:id/media', {
    ...guard, schema: { tags: ['provider-panel'], security: sec, params: idParams, consumes: ['multipart/form-data'] },
  }, async (req, reply) => {
    // Cheap ownership/state check before reading the upload.
    const p0 = await providerOf(db, req, { forWrite: true });
    const owner = (await db.query<{ provider_id: string }>('SELECT provider_id FROM services WHERE id = $1', [req.params.id])).rows[0];
    if (!owner || owner.provider_id !== p0.id) throw notFound();

    const file = await req.file();
    if (!file) throw badRequest('VALIDATION_FAILED', [{ path: '/file', message: 'file is required' }]);
    const field = (name: string) => { const f = file.fields[name] as { value?: unknown } | undefined; return typeof f?.value === 'string' ? f.value : undefined; };
    const isPastWork = field('isPastWork') === 'true';
    const packageId = field('packageId') || null;
    if (packageId && !z.uuid().safeParse(packageId).success) throw badRequest('VALIDATION_FAILED', [{ path: '/packageId', message: 'invalid id' }]);
    const stored = await deps.storage.save(`services/${req.params.id}`, await file.toBuffer(), [...IMAGE_TYPES, ...VIDEO_TYPES]);
    const kind = VIDEO_TYPES.includes(stored.mime) ? 'video' : 'image';
    try {
      const id = await withTx(db, async (c) => {
        const p = await providerOf(c, req, { forWrite: true });
        const { type } = await ownedServiceForChild(c, p, req.params.id);
        if (kind === 'video' && !type.allows_video) throw badRequest('VIDEO_NOT_ALLOWED');
        await assertPackageOf(c, packageId, req.params.id);
        if (kind === 'image') {
          const n = Number((await c.query<{ n: string }>(`SELECT count(*) AS n FROM service_media WHERE service_id = $1 AND kind = 'image'`, [req.params.id])).rows[0]!.n);
          if (n >= type.max_images) throw conflict('MEDIA_LIMIT_REACHED', { maxImages: type.max_images });
        }
        const mediaId = (await c.query<{ id: string }>(
          `INSERT INTO service_media (service_id, kind, file_key, mime_type, size_bytes, sha256, is_past_work, package_id, sort_order)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, (SELECT coalesce(max(sort_order), -1) + 1 FROM service_media WHERE service_id = $1)) RETURNING id`,
          [req.params.id, kind, stored.key, stored.mime, stored.size, stored.sha256, isPastWork, packageId])).rows[0]!.id;
        await audit(c, actorOf(req), { action: 'service.media_added', entityType: 'service', entityId: req.params.id, after: { mediaId, kind, sha256: stored.sha256, packageId } });
        return mediaId;
      });
      return reply.status(201).send({ id, kind, mimeType: stored.mime, url: `/v1/media/${id}` });
    } catch (err) {
      await deps.storage.remove(stored.key); // do not leave orphan files behind a rejected upload
      throw err;
    }
  });

  app.patch('/provider/media/:id', {
    ...guard, schema: { tags: ['provider-panel'], security: sec, params: idParams, body: z.object({ sortOrder: z.number().int().optional(), isPastWork: z.boolean().optional(), caption: i18nTextSchema.nullable().optional(), packageId: z.uuid().nullable().optional() }) },
  }, async (req) => {
    return withTx(db, async (c) => {
      const p = await providerOf(c, req, { forWrite: true });
      const m = (await c.query('SELECT * FROM service_media WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
      if (!m) throw notFound();
      await ownedServiceForChild(c, p, m.service_id);
      if (req.body.packageId) await assertPackageOf(c, req.body.packageId, m.service_id);
      await c.query(
        `UPDATE service_media SET sort_order = coalesce($2, sort_order), is_past_work = coalesce($3, is_past_work),
           caption = CASE WHEN $4 THEN $5::jsonb ELSE caption END, package_id = CASE WHEN $6 THEN $7::uuid ELSE package_id END WHERE id = $1`,
        [req.params.id, req.body.sortOrder ?? null, req.body.isPastWork ?? null, req.body.caption !== undefined, req.body.caption ? JSON.stringify(req.body.caption) : null,
          req.body.packageId !== undefined, req.body.packageId ?? null]);
      await audit(c, actorOf(req), { action: 'service.media_updated', entityType: 'service', entityId: m.service_id, before: m, after: req.body });
      return { id: req.params.id };
    });
  });

  app.delete('/provider/media/:id', { ...guard, schema: { tags: ['provider-panel'], security: sec, params: idParams } }, async (req, reply) => {
    const key = await withTx(db, async (c) => {
      const p = await providerOf(c, req, { forWrite: true });
      const m = (await c.query('SELECT * FROM service_media WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
      if (!m) throw notFound();
      const { service, type } = await ownedServiceForChild(c, p, m.service_id);
      // A live service must keep its minimum images.
      if (m.kind === 'image' && ['published', 'pending_review'].includes(service.status)) {
        const n = Number((await c.query<{ n: string }>(`SELECT count(*) AS n FROM service_media WHERE service_id = $1 AND kind = 'image'`, [m.service_id])).rows[0]!.n);
        if (n - 1 < type.min_images) throw badRequest('MIN_IMAGES_REQUIRED', { minImages: type.min_images });
      }
      await c.query('DELETE FROM service_media WHERE id = $1', [req.params.id]);
      await audit(c, actorOf(req), { action: 'service.media_removed', entityType: 'service', entityId: m.service_id, before: m });
      return m.file_key as string;
    });
    await deps.storage.remove(key);
    return reply.status(204).send();
  });
}
