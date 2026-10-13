import { z } from 'zod';
import type { App, Deps } from '../../deps.js';
import { actorOf, assertCan, countryScope, requireKind, requirePermission, requireUser } from '../../auth/guard.js';
import { withTx } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { idParams, reasonSchema } from '../common.js';
import { providerOf } from '../catalog/shared.js';
import { getAvailability, MAX_RANGE_DAYS } from './calendar.js';
import { releaseBlock, reserve } from './engine.js';

const sec = [{ bearer: [] }];
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$|^24:00$/, 'HH:mm, 00:00-24:00');
const instant = z.iso.datetime({ offset: true }).transform((v) => new Date(v));
const date = z.iso.date();

const ruleSchema = z.object({ weekday: z.number().int().min(0).max(6), start: time, end: time });
const blockBody = z.object({
  kind: z.enum(['external', 'closed']),
  start: instant,
  end: instant,
  rentalItemId: z.uuid().nullable().default(null),
  units: z.number().int().positive().max(1000).default(1),
  reason: z.string().trim().min(2).max(500),
  internalNotes: z.string().trim().max(2000).nullable().default(null),
});
const rangeQuery = z.object({ from: date, to: date });

const toMinutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/** Calendar rows for staff and owners: kinds and internal notes, never customer personal data. */
const BLOCK_COLUMNS = `b.id, b.service_id AS "serviceId", s.title AS "serviceTitle", b.rental_item_id AS "rentalItemId", b.kind,
  lower(b.period) AS start, upper(b.period) AS "end", lower(b.blocked_period) AS "blockedStart", upper(b.blocked_period) AS "blockedEnd",
  b.units, b.expires_at AS "expiresAt", b.booking_ref AS "bookingRef", b.reason, b.internal_notes AS "internalNotes", b.created_at AS "createdAt"`;

export async function availabilityRoutes(app: App, deps: Deps) {
  const { db } = deps;
  const providerGuard = { onRequest: deps.authenticate, preValidation: requireKind('provider') };

  // ---------------- Public availability ----------------
  app.get('/services/:id/availability', {
    schema: { tags: ['catalog'], params: idParams, querystring: rangeQuery.extend({ rentalItemId: z.uuid().optional() }) },
  }, async (req) => {
    const pub = await db.query(
      `SELECT 1 FROM services s JOIN providers p ON p.id = s.provider_id WHERE s.id = $1 AND s.status = 'published' AND p.status = 'active'`, [req.params.id]);
    if (!pub.rowCount) throw notFound();
    return getAvailability(db, req.params.id, req.query.from, req.query.to, req.query.rentalItemId);
  });

  // ---------------- Provider: opening hours ----------------
  app.get('/provider/services/:id/availability-rules', { ...providerGuard, schema: { tags: ['provider-panel'], security: sec, params: idParams } }, async (req) => {
    const p = await providerOf(db, req, { forWrite: false });
    const owns = await db.query('SELECT 1 FROM services WHERE id = $1 AND provider_id = $2', [req.params.id, p.id]);
    if (!owns.rowCount) throw notFound();
    return (await db.query(
      `SELECT weekday, to_char(start_time, 'HH24:MI') AS start, CASE WHEN end_time = '24:00' THEN '24:00' ELSE to_char(end_time, 'HH24:MI') END AS "end"
         FROM availability_rules WHERE service_id = $1 ORDER BY weekday, start_time`, [req.params.id])).rows;
  });

  app.put('/provider/services/:id/availability-rules', {
    ...providerGuard, schema: { tags: ['provider-panel'], security: sec, params: idParams, body: z.object({ rules: z.array(ruleSchema).max(7 * 6) }) },
  }, async (req) => {
    const rules = req.body.rules;
    for (const r of rules) if (toMinutes(r.end) <= toMinutes(r.start)) throw badRequest('PERIOD_INVALID', { rule: r });
    for (let d = 0; d < 7; d++) {
      const day = rules.filter((r) => r.weekday === d).sort((a, b) => toMinutes(a.start) - toMinutes(b.start));
      for (let i = 1; i < day.length; i++) {
        if (toMinutes(day[i]!.start) < toMinutes(day[i - 1]!.end)) throw badRequest('RULES_OVERLAP', { weekday: d });
      }
    }
    return withTx(db, async (c) => {
      const p = await providerOf(c, req, { forWrite: true });
      const owns = await c.query('SELECT 1 FROM services WHERE id = $1 AND provider_id = $2 FOR UPDATE', [req.params.id, p.id]);
      if (!owns.rowCount) throw notFound();
      const before = (await c.query('SELECT weekday, start_time, end_time FROM availability_rules WHERE service_id = $1', [req.params.id])).rows;
      await c.query('DELETE FROM availability_rules WHERE service_id = $1', [req.params.id]);
      for (const r of rules) {
        await c.query('INSERT INTO availability_rules (service_id, weekday, start_time, end_time) VALUES ($1, $2, $3, $4)', [req.params.id, r.weekday, r.start, r.end]);
      }
      // Existing reservations stay valid; new hours apply to new reservations only.
      await audit(c, actorOf(req), { action: 'service.availability_rules_changed', entityType: 'service', entityId: req.params.id, before, after: rules });
      return { rules };
    });
  });

  // ---------------- Provider: external bookings and closures (clause 27) ----------------
  app.post('/provider/services/:id/blocks', {
    ...providerGuard, schema: { tags: ['provider-panel'], security: sec, params: idParams, body: blockBody },
  }, async (req, reply) => {
    const b = req.body;
    const r = await withTx(db, async (c) => {
      const p = await providerOf(c, req, { forWrite: true });
      const owns = await c.query('SELECT 1 FROM services WHERE id = $1 AND provider_id = $2', [req.params.id, p.id]);
      if (!owns.rowCount) throw notFound();
      const res = await reserve(c, {
        serviceId: req.params.id, rentalItemId: b.rentalItemId, start: b.start, end: b.end, units: b.units, kind: b.kind,
        enforceSchedule: false, reason: b.reason, internalNotes: b.internalNotes, actorId: requireUser(req).id,
      });
      await audit(c, actorOf(req), { action: `calendar.${b.kind}_created`, entityType: 'calendar_block', entityId: res.id, after: { serviceId: req.params.id, ...b } });
      return res;
    });
    return reply.status(201).send({ id: r.id });
  });

  app.delete('/provider/blocks/:id', {
    ...providerGuard, schema: { tags: ['provider-panel'], security: sec, params: idParams, body: z.object({ reason: reasonSchema }) },
  }, async (req, reply) => {
    await withTx(db, async (c) => {
      const p = await providerOf(c, req, { forWrite: true });
      const b = (await c.query<{ kind: string; provider_id: string }>(
        'SELECT b.kind, s.provider_id FROM calendar_blocks b JOIN services s ON s.id = b.service_id WHERE b.id = $1 FOR UPDATE OF b', [req.params.id])).rows[0];
      if (!b || b.provider_id !== p.id) throw notFound();
      // Holds and confirmed bookings are released through the booking flow, never by deleting calendar rows.
      if (b.kind !== 'external' && b.kind !== 'closed') throw conflict('BLOCK_NOT_RELEASABLE');
      await releaseBlock(c, req.params.id, requireUser(req).id, req.body.reason);
      await audit(c, actorOf(req), { action: 'calendar.block_released', entityType: 'calendar_block', entityId: req.params.id, reason: req.body.reason });
    });
    return reply.status(204).send();
  });

  app.get('/provider/calendar', {
    ...providerGuard,
    schema: { tags: ['provider-panel'], security: sec, querystring: rangeQuery.extend({ serviceId: z.uuid().optional(), kinds: z.string().regex(/^(hold|booking|external|closed)(,(hold|booking|external|closed))*$/).optional() }) },
  }, async (req) => {
    const p = await providerOf(db, req, { forWrite: false });
    const q = req.query;
    const span = (await db.query<{ n: number }>('SELECT ($2::date - $1::date) AS n', [q.from, q.to])).rows[0]!.n;
    if (span < 0 || span >= MAX_RANGE_DAYS) throw badRequest('PERIOD_INVALID', { maxDays: MAX_RANGE_DAYS });
    return (await db.query(
      `SELECT ${BLOCK_COLUMNS} FROM calendar_blocks b JOIN services s ON s.id = b.service_id JOIN countries co ON co.id = s.country_id
        WHERE s.provider_id = $1 AND b.status = 'active' AND NOT (b.kind = 'hold' AND b.expires_at <= now())
          AND b.blocked_period && tstzrange($2::date::timestamp AT TIME ZONE co.timezone, ($3::date + 1)::timestamp AT TIME ZONE co.timezone)
          AND ($4::uuid IS NULL OR b.service_id = $4) AND ($5::text[] IS NULL OR b.kind = ANY($5))
        ORDER BY lower(b.period)`,
      [p.id, q.from, q.to, q.serviceId ?? null, q.kinds ? q.kinds.split(',') : null])).rows;
  });

  // ---------------- Admin: central calendar (clause 26) ----------------
  app.get('/admin/calendar', {
    onRequest: deps.authenticate, preValidation: requirePermission('bookings.view'),
    schema: {
      tags: ['admin:calendar'], security: sec,
      querystring: rangeQuery.extend({
        countryCode: z.string().length(2).toUpperCase().optional(), city: z.string().max(100).optional(), typeId: z.uuid().optional(),
        providerId: z.uuid().optional(), serviceId: z.uuid().optional(),
        kinds: z.string().regex(/^(hold|booking|external|closed)(,(hold|booking|external|closed))*$/).optional(),
      }),
    },
  }, async (req) => {
    const scope = countryScope(requireUser(req), 'bookings.view');
    const q = req.query;
    const span = (await db.query<{ n: number }>('SELECT ($2::date - $1::date) AS n', [q.from, q.to])).rows[0]!.n;
    if (span < 0 || span >= MAX_RANGE_DAYS) throw badRequest('PERIOD_INVALID', { maxDays: MAX_RANGE_DAYS });
    return (await db.query(
      `SELECT ${BLOCK_COLUMNS}, p.id AS "providerId", p.business_name AS "providerName", co.code AS "countryCode", s.city, t.code AS "typeCode"
         FROM calendar_blocks b JOIN services s ON s.id = b.service_id JOIN providers p ON p.id = s.provider_id
         JOIN service_types t ON t.id = s.service_type_id JOIN countries co ON co.id = s.country_id
        WHERE b.status = 'active' AND NOT (b.kind = 'hold' AND b.expires_at <= now())
          AND b.blocked_period && tstzrange($1::date::timestamp AT TIME ZONE co.timezone, ($2::date + 1)::timestamp AT TIME ZONE co.timezone)
          AND ($3::uuid[] IS NULL OR s.country_id = ANY($3)) AND ($4::text IS NULL OR co.code = $4)
          AND ($5::text IS NULL OR lower(s.city) = lower($5)) AND ($6::uuid IS NULL OR s.service_type_id = $6)
          AND ($7::uuid IS NULL OR s.provider_id = $7) AND ($8::uuid IS NULL OR s.id = $8) AND ($9::text[] IS NULL OR b.kind = ANY($9))
        ORDER BY lower(b.period) LIMIT 5000`,
      [q.from, q.to, scope, q.countryCode ?? null, q.city ?? null, q.typeId ?? null, q.providerId ?? null, q.serviceId ?? null,
        q.kinds ? q.kinds.split(',') : null])).rows;
  });

  app.post('/admin/services/:id/blocks', {
    onRequest: deps.authenticate, preValidation: requirePermission('bookings.manage'),
    schema: { tags: ['admin:calendar'], security: sec, params: idParams, body: blockBody },
  }, async (req, reply) => {
    const b = req.body;
    const r = await withTx(db, async (c) => {
      const s = (await c.query<{ country_id: string }>('SELECT country_id FROM services WHERE id = $1', [req.params.id])).rows[0];
      if (!s) throw notFound();
      assertCan(requireUser(req), 'bookings.manage', s.country_id);
      const res = await reserve(c, {
        serviceId: req.params.id, rentalItemId: b.rentalItemId, start: b.start, end: b.end, units: b.units, kind: b.kind,
        enforceSchedule: false, reason: b.reason, internalNotes: b.internalNotes, actorId: requireUser(req).id,
      });
      await audit(c, actorOf(req), { action: `calendar.${b.kind}_created`, entityType: 'calendar_block', entityId: res.id, after: { serviceId: req.params.id, ...b } });
      return res;
    });
    return reply.status(201).send({ id: r.id });
  });

  app.delete('/admin/blocks/:id', {
    onRequest: deps.authenticate, preValidation: requirePermission('bookings.manage'),
    schema: { tags: ['admin:calendar'], security: sec, params: idParams, body: z.object({ reason: reasonSchema }) },
  }, async (req, reply) => {
    await withTx(db, async (c) => {
      const b = (await c.query<{ kind: string; country_id: string }>(
        'SELECT b.kind, s.country_id FROM calendar_blocks b JOIN services s ON s.id = b.service_id WHERE b.id = $1 FOR UPDATE OF b', [req.params.id])).rows[0];
      if (!b) throw notFound();
      assertCan(requireUser(req), 'bookings.manage', b.country_id);
      // Confirmed bookings are cancelled through the booking module (phase 5), which handles money and notifications.
      if (b.kind === 'booking') throw conflict('BLOCK_NOT_RELEASABLE');
      await releaseBlock(c, req.params.id, requireUser(req).id, req.body.reason);
      await audit(c, actorOf(req), { action: 'calendar.block_released', entityType: 'calendar_block', entityId: req.params.id, reason: req.body.reason });
    });
    return reply.status(204).send();
  });
}
