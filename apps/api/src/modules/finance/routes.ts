import { z } from 'zod';
import type { App, Deps } from '../../deps.js';
import { actorOf, assertCan, can, countryScope, requireKind, requirePermission, requireUser } from '../../auth/guard.js';
import { withTx } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { badRequest, conflict, mapUniqueViolation, notFound } from '../../lib/errors.js';
import { fromUnits, toUnits } from '../../lib/money.js';
import { DOCUMENT_TYPES } from '../../lib/storage.js';
import { i18nTextSchema, idParams, optionalBody, paginationQuery, reasonSchema } from '../common.js';
import { providerOf } from '../catalog/shared.js';
import { approveEarningReview } from './earnings.js';
import { adapterFor, SUPPORTED_PROVIDERS, type IntegrationRow } from './gateways.js';
import { CHART, NATURAL_SIGN_SQL, type AccountKind } from './ledger.js';
import { cancelPayment, createPayment, handleWebhook, paymentOptions, reviewPayment } from './payments.js';
import { approveRefund, executeRefund, failRefund, refundableFor, rejectRefund, requestRefunds } from './refunds.js';
import { approveSettlement, closeSettlementUnpaid, createSettlement, eligibleEarnings, markSettlementPaid } from './settlements.js';

const sec = [{ bearer: [] }];
const money = z.string().regex(/^\d{1,16}(\.\d{1,4})?$/);
const currency = z.string().regex(/^[A-Z]{3}$/);
const FUND_KINDS = Object.entries(CHART).filter(([, d]) => d.fund).map(([k]) => k) as [AccountKind, ...AccountKind[]];

const PAYMENT_COLUMNS = `p.id, p.number, p.order_id AS "orderId", p.model, p.method, p.purpose, p.amount, p.currency_code AS currency,
  p.reported_amount AS "reportedAmount", p.verified_amount AS "verifiedAmount", p.gateway_fee AS "gatewayFee", p.status,
  p.checkout_url AS "checkoutUrl", p.failure_reason AS "failureReason", p.needs_attention AS "needsAttention", p.review_note AS "reviewNote",
  p.verified_at AS "verifiedAt", p.succeeded_at AS "succeededAt", p.created_at AS "createdAt",
  coalesce((SELECT json_agg(json_build_object('bookingId', a.booking_id, 'amount', a.amount, 'verifiedAmount', a.verified_amount))
              FROM payment_allocations a WHERE a.payment_id = p.id), '[]') AS allocations,
  (SELECT count(*)::int FROM payment_proofs pp WHERE pp.payment_id = p.id) AS "proofCount",
  -- Where to send a manual payment: only the receiving fund's customer-facing instructions, never its other details.
  (SELECT a.details->'paymentInstructions' FROM ledger_accounts a WHERE a.id = p.account_id AND p.method IN ('bank_transfer', 'wallet', 'cash')) AS instructions`;

export async function financeRoutes(app: App, deps: Deps) {
  const { db, config } = deps;
  const customer = { onRequest: deps.authenticate, preValidation: requireKind('customer') };
  const staff = (perm: Parameters<typeof requirePermission>[0]) => ({ onRequest: deps.authenticate, preValidation: requirePermission(perm) });

  // =============== Provider webhooks (raw body for signature checks) ===============
  await app.register(async (hooks) => {
    hooks.removeAllContentTypeParsers();
    hooks.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
    hooks.post('/webhooks/payments/:integrationId', { schema: { hide: true } }, async (req, reply) => {
      const { integrationId } = z.object({ integrationId: z.uuid() }).parse(req.params);
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const r = await handleWebhook(db, config, integrationId, raw, req.headers);
      return reply.status(200).send(r);
    });
  });

  // =============== Customer ===============
  app.get('/orders/:id/payment-options', { ...customer, schema: { tags: ['payments'], security: sec, params: idParams } },
    async (req) => paymentOptions(db, req.params.id, requireUser(req).id));

  app.post('/orders/:id/payments', {
    ...customer,
    schema: {
      tags: ['payments'], security: sec, params: idParams,
      headers: z.object({ 'idempotency-key': z.string().min(8).max(100).optional() }).passthrough(),
      body: z.object({
        model: z.enum(['platform', 'direct']), method: z.enum(['card', 'wallet', 'bank_transfer', 'cash']), purpose: z.enum(['upfront', 'balance']),
        bookingIds: z.array(z.uuid()).min(1).max(50).optional(), reportedAmount: money.optional(),
      }),
    },
  }, async (req, reply) => {
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string') throw badRequest('IDEMPOTENCY_KEY_REQUIRED');
    const r = await createPayment(db, config, { orderId: req.params.id, customerId: requireUser(req).id, ...req.body, idempotencyKey: key }, actorOf(req));
    const p = (await db.query(`SELECT ${PAYMENT_COLUMNS} FROM payments p WHERE p.id = $1`, [r.paymentId])).rows[0];
    return reply.status(r.replayed ? 200 : 201).send(p);
  });

  app.get('/orders/:id/payments', { ...customer, schema: { tags: ['payments'], security: sec, params: idParams } }, async (req) =>
    (await db.query(`SELECT ${PAYMENT_COLUMNS} FROM payments p WHERE p.order_id = $1 AND p.customer_id = $2 ORDER BY p.created_at`, [req.params.id, requireUser(req).id])).rows);

  app.get('/payments/:id', { ...customer, schema: { tags: ['payments'], security: sec, params: idParams } }, async (req) => {
    const p = (await db.query(`SELECT ${PAYMENT_COLUMNS} FROM payments p WHERE p.id = $1 AND p.customer_id = $2`, [req.params.id, requireUser(req).id])).rows[0];
    if (!p) throw notFound();
    return p;
  });

  app.post('/payments/:id/cancel', { ...customer, schema: { tags: ['payments'], security: sec, params: idParams } },
    async (req) => cancelPayment(db, req.params.id, requireUser(req).id, actorOf(req)));

  app.post('/payments/:id/proofs', { ...customer, schema: { tags: ['payments'], security: sec, params: idParams, consumes: ['multipart/form-data'] } }, async (req, reply) => {
    const own = (await db.query<{ status: string }>('SELECT status FROM payments WHERE id = $1 AND customer_id = $2', [req.params.id, requireUser(req).id])).rows[0];
    if (!own) throw notFound();
    if (own.status !== 'awaiting_verification') throw conflict('INVALID_STATUS_TRANSITION', { from: own.status });
    const file = await req.file();
    if (!file) throw badRequest('VALIDATION_FAILED', [{ path: '/file', message: 'file is required' }]);
    const stored = await deps.storage.save(`payment-proofs/${req.params.id}`, await file.toBuffer(), DOCUMENT_TYPES);
    const id = await withTx(db, async (c) => {
      const proofId = (await c.query<{ id: string }>(
        'INSERT INTO payment_proofs (payment_id, file_key, mime_type, size_bytes, sha256, uploaded_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
        [req.params.id, stored.key, stored.mime, stored.size, stored.sha256, requireUser(req).id])).rows[0]!.id;
      await audit(c, actorOf(req), { action: 'payment.proof_uploaded', entityType: 'payment', entityId: req.params.id, after: { proofId, sha256: stored.sha256 } });
      return proofId;
    });
    return reply.status(201).send({ id });
  });

  // =============== Provider panel: earnings (clauses 42, 62) ===============
  app.get('/provider/earnings', {
    onRequest: deps.authenticate, preValidation: requireKind('provider'),
    schema: { tags: ['provider-panel'], security: sec, querystring: paginationQuery.extend({ status: z.string().max(30).optional() }) },
  }, async (req) => {
    const p = await providerOf(db, req, { forWrite: false });
    const items = (await db.query(
      `SELECT e.id, e.booking_id AS "bookingId", b.number AS "bookingNumber", b.service_title AS "serviceTitle", b.start_at AS "startAt",
              e.currency_code AS currency, e.booking_total AS "bookingTotal", e.collected_by_platform AS "collectedByPlatform",
              e.collected_directly AS "collectedDirectly", e.commission_amount AS "commission", e.net_amount AS "net", e.status, e.due_at AS "dueAt"
         FROM provider_earnings e JOIN bookings b ON b.id = e.booking_id
        WHERE e.provider_id = $1 AND ($2::text IS NULL OR e.status = $2) ORDER BY b.start_at DESC LIMIT $3 OFFSET $4`,
      [p.id, req.query.status ?? null, req.query.limit, req.query.offset])).rows;
    const totals = (await db.query(
      `SELECT currency_code AS currency, status, sum(net_amount)::numeric(20,4)::text AS net, sum(commission_amount)::numeric(20,4)::text AS commission, count(*)::int AS count
         FROM provider_earnings WHERE provider_id = $1 GROUP BY currency_code, status ORDER BY currency_code, status`, [p.id])).rows;
    return { items, totals };
  });

  // =============== Admin: integrations (clause 35) ===============
  const integrationCols = `id, provider_code AS "providerCode", name, country_id AS "countryId", kind, environment, secret_ref AS "secretRef",
    config, is_active AS "isActive", last_test_at AS "lastTestAt", last_test_status AS "lastTestStatus", last_error AS "lastError"`;

  app.get('/admin/payment-integrations', { ...staff('payment_settings.manage'), schema: { tags: ['admin:payments'], security: sec } }, async (req) => {
    const scope = countryScope(requireUser(req), 'payment_settings.manage');
    return (await db.query(`SELECT ${integrationCols}, '/v1/webhooks/payments/' || id AS "webhookUrl" FROM payment_integrations WHERE ($1::uuid[] IS NULL OR country_id = ANY($1)) ORDER BY created_at`, [scope])).rows;
  });

  app.post('/admin/payment-integrations', {
    ...staff('payment_settings.manage'),
    schema: {
      tags: ['admin:payments'], security: sec,
      body: z.object({
        providerCode: z.enum(SUPPORTED_PROVIDERS as [string, ...string[]]), name: z.string().trim().min(2).max(100), countryId: z.uuid(),
        kind: z.enum(['gateway', 'wallet', 'bank', 'transfer_service']), environment: z.enum(['test', 'production']),
        secretRef: z.string().regex(/^[A-Z][A-Z0-9_]{2,100}$/), config: z.record(z.string(), z.unknown()).default({}),
      }),
    },
  }, async (req, reply) => {
    assertCan(requireUser(req), 'payment_settings.manage', req.body.countryId);
    const b = req.body;
    const id = await withTx(db, async (c) => {
      const iid = (await c.query<{ id: string }>(
        `INSERT INTO payment_integrations (provider_code, name, country_id, kind, environment, secret_ref, config) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [b.providerCode, b.name, b.countryId, b.kind, b.environment, b.secretRef, JSON.stringify(b.config)])).rows[0]!.id;
      await audit(c, actorOf(req), { action: 'payment_integration.created', entityType: 'payment_integration', entityId: iid, after: b });
      return iid;
    });
    return reply.status(201).send({ id, webhookUrl: `/v1/webhooks/payments/${id}` });
  });

  app.patch('/admin/payment-integrations/:id', {
    ...staff('payment_settings.manage'),
    schema: { tags: ['admin:payments'], security: sec, params: idParams, body: z.object({ name: z.string().min(2).max(100).optional(), isActive: z.boolean().optional(), config: z.record(z.string(), z.unknown()).optional(), reason: reasonSchema }) },
  }, async (req) => withTx(db, async (c) => {
    const before = (await c.query<IntegrationRow & { country_id: string }>('SELECT * FROM payment_integrations WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
    if (!before) throw notFound();
    assertCan(requireUser(req), 'payment_settings.manage', before.country_id);
    // Activating requires a working configuration (secret present, adapter allowed in this environment).
    if (req.body.isActive) adapterFor(before, config.NODE_ENV);
    await c.query('UPDATE payment_integrations SET name = coalesce($2, name), is_active = coalesce($3, is_active), config = coalesce($4, config) WHERE id = $1',
      [req.params.id, req.body.name ?? null, req.body.isActive ?? null, req.body.config ? JSON.stringify(req.body.config) : null]);
    await audit(c, actorOf(req), { action: 'payment_integration.updated', entityType: 'payment_integration', entityId: req.params.id, before, after: req.body, reason: req.body.reason });
    return { id: req.params.id };
  }));

  app.post('/admin/payment-integrations/:id/test', { ...staff('payment_settings.manage'), schema: { tags: ['admin:payments'], security: sec, params: idParams } }, async (req) => {
    const i = (await db.query<IntegrationRow & { country_id: string }>('SELECT * FROM payment_integrations WHERE id = $1', [req.params.id])).rows[0];
    if (!i) throw notFound();
    assertCan(requireUser(req), 'payment_settings.manage', i.country_id);
    let result: { ok: boolean; message: string };
    try {
      const { adapter, secret } = adapterFor(i, config.NODE_ENV);
      result = await adapter.test(i, secret);
    } catch (err) {
      result = { ok: false, message: (err as { details?: { reason?: string } }).details?.reason ?? (err as Error).message };
    }
    await db.query('UPDATE payment_integrations SET last_test_at = now(), last_test_status = $2, last_error = $3 WHERE id = $1',
      [i.id, result.ok ? 'ok' : 'failed', result.ok ? null : result.message]);
    return result;
  });

  // =============== Admin: payment methods per country / type (clauses 34, 69) ===============
  app.get('/admin/payment-methods', { ...staff('payment_settings.manage'), schema: { tags: ['admin:payments'], security: sec } }, async (req) => {
    const scope = countryScope(requireUser(req), 'payment_settings.manage');
    return (await db.query(
      `SELECT id, country_id AS "countryId", service_type_id AS "serviceTypeId", model, method, integration_id AS "integrationId", account_id AS "accountId",
              proof_required AS "proofRequired", is_active AS "isActive" FROM payment_method_rules WHERE ($1::uuid[] IS NULL OR country_id = ANY($1)) ORDER BY country_id, model, method`, [scope])).rows;
  });

  app.post('/admin/payment-methods', {
    ...staff('payment_settings.manage'),
    schema: {
      tags: ['admin:payments'], security: sec,
      body: z.object({
        countryId: z.uuid(), serviceTypeId: z.uuid().nullable().default(null), model: z.enum(['platform', 'direct']),
        method: z.enum(['card', 'wallet', 'bank_transfer', 'cash']), integrationId: z.uuid().nullable().default(null),
        accountId: z.uuid().nullable().default(null), proofRequired: z.boolean().default(false), isActive: z.boolean().default(true),
      }),
    },
  }, async (req, reply) => {
    const b = req.body;
    assertCan(requireUser(req), 'payment_settings.manage', b.countryId);
    const id = await withTx(db, async (c) => {
      if (b.accountId) {
        const a = (await c.query<{ country_id: string; kind: string }>('SELECT country_id, kind FROM ledger_accounts WHERE id = $1', [b.accountId])).rows[0];
        // Platform money must land in a fund of the same country (clause 38).
        if (!a || a.country_id !== b.countryId || !FUND_KINDS.includes(a.kind as AccountKind)) throw badRequest('INVALID_REFERENCE', { field: 'accountId' });
      }
      if (b.integrationId) {
        const i = (await c.query<{ country_id: string }>('SELECT country_id FROM payment_integrations WHERE id = $1', [b.integrationId])).rows[0];
        if (!i || i.country_id !== b.countryId) throw badRequest('INVALID_REFERENCE', { field: 'integrationId' });
      }
      let rid: string;
      try {
        rid = (await c.query<{ id: string }>(
          `INSERT INTO payment_method_rules (country_id, service_type_id, model, method, integration_id, account_id, proof_required, is_active)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
          [b.countryId, b.serviceTypeId, b.model, b.method, b.integrationId, b.accountId, b.proofRequired, b.isActive])).rows[0]!.id;
      } catch (err) {
        if ((err as { code?: string }).code === '23514') throw badRequest('VALIDATION_FAILED', [{ path: '/', message: 'platform methods need a fund account; card/wallet need an integration; direct methods take neither' }]);
        mapUniqueViolation(err, { payment_method_rules_country: 'CODE_TAKEN' });
      }
      await audit(c, actorOf(req), { action: 'payment_method.created', entityType: 'payment_method_rule', entityId: rid, after: b });
      return rid;
    });
    return reply.status(201).send({ id });
  });

  app.patch('/admin/payment-methods/:id', {
    ...staff('payment_settings.manage'),
    schema: { tags: ['admin:payments'], security: sec, params: idParams, body: z.object({ isActive: z.boolean().optional(), proofRequired: z.boolean().optional(), reason: reasonSchema }) },
  }, async (req) => withTx(db, async (c) => {
    const before = (await c.query<{ country_id: string }>('SELECT * FROM payment_method_rules WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
    if (!before) throw notFound();
    assertCan(requireUser(req), 'payment_settings.manage', before.country_id);
    // Applies to new payments only; existing payment records keep their rule and history.
    await c.query('UPDATE payment_method_rules SET is_active = coalesce($2, is_active), proof_required = coalesce($3, proof_required) WHERE id = $1',
      [req.params.id, req.body.isActive ?? null, req.body.proofRequired ?? null]);
    await audit(c, actorOf(req), { action: 'payment_method.updated', entityType: 'payment_method_rule', entityId: req.params.id, before, after: req.body, reason: req.body.reason });
    return { id: req.params.id };
  }));

  // =============== Admin: funds and ledger (clauses 37-39, 64) ===============
  app.get('/admin/accounts', {
    ...staff('finance.view'), schema: { tags: ['admin:finance'], security: sec, querystring: z.object({ countryId: z.uuid().optional(), currency: currency.optional() }) },
  }, async (req) => {
    const scope = countryScope(requireUser(req), 'finance.view');
    return (await db.query(
      `SELECT a.id, a.country_id AS "countryId", a.currency_code AS currency, a.code, a.kind, a.type, a.name, a.is_system AS "isSystem",
              a.is_active AS "isActive", a.details,
              (coalesce((SELECT sum(l.debit - l.credit) FROM journal_lines l WHERE l.account_id = a.id), 0) * ${NATURAL_SIGN_SQL})::numeric(20,4)::text AS balance
         FROM ledger_accounts a
        WHERE ($1::uuid[] IS NULL OR a.country_id = ANY($1)) AND ($2::uuid IS NULL OR a.country_id = $2) AND ($3::text IS NULL OR a.currency_code = $3)
        ORDER BY a.country_id, a.currency_code, a.code`, [scope, req.query.countryId ?? null, req.query.currency ?? null])).rows;
  });

  app.post('/admin/accounts', {
    ...staff('accounts.manage'),
    schema: {
      tags: ['admin:finance'], security: sec,
      body: z.object({ countryId: z.uuid(), currency, kind: z.enum(FUND_KINDS), suffix: z.string().regex(/^[0-9A-Z]{1,10}$/), name: i18nTextSchema, details: z.record(z.string(), z.unknown()).default({}) }),
    },
  }, async (req, reply) => {
    const b = req.body;
    assertCan(requireUser(req), 'accounts.manage', b.countryId);
    const id = await withTx(db, async (c) => {
      const allowed = await c.query('SELECT 1 FROM country_currencies WHERE country_id = $1 AND currency_code = $2 AND is_active', [b.countryId, b.currency]);
      if (!allowed.rowCount) throw badRequest('CURRENCY_NOT_ALLOWED');
      let aid: string;
      try {
        // A new fund starts at zero: balances only ever come from posted entries (clause 37).
        aid = (await c.query<{ id: string }>(
          `INSERT INTO ledger_accounts (country_id, currency_code, code, kind, type, name, details) VALUES ($1, $2, $3, $4, 'asset', $5, $6) RETURNING id`,
          [b.countryId, b.currency, `${CHART[b.kind].code}-${b.suffix}`, b.kind, JSON.stringify(b.name), JSON.stringify(b.details)])).rows[0]!.id;
      } catch (err) { mapUniqueViolation(err, { ledger_accounts_country_id_currency_code_code: 'CODE_TAKEN' }); }
      await audit(c, actorOf(req), { action: 'account.created', entityType: 'ledger_account', entityId: aid, after: b });
      return aid;
    });
    return reply.status(201).send({ id });
  });

  app.patch('/admin/accounts/:id', {
    ...staff('accounts.manage'),
    schema: { tags: ['admin:finance'], security: sec, params: idParams, body: z.object({ isActive: z.boolean().optional(), name: i18nTextSchema.optional(), details: z.record(z.string(), z.unknown()).optional(), reason: reasonSchema }) },
  }, async (req) => withTx(db, async (c) => {
    const a = (await c.query<{ country_id: string; is_system: boolean }>('SELECT * FROM ledger_accounts WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
    if (!a) throw notFound();
    assertCan(requireUser(req), 'accounts.manage', a.country_id);
    if (req.body.isActive === false) {
      if (a.is_system) throw conflict('ACCOUNT_KIND_NOT_ALLOWED');
      const bal = (await c.query<{ v: string }>('SELECT coalesce(sum(debit - credit), 0)::text AS v FROM journal_lines WHERE account_id = $1', [req.params.id])).rows[0]!.v;
      const used = await c.query('SELECT 1 FROM payment_method_rules WHERE account_id = $1 AND is_active', [req.params.id]);
      if (Number(bal) !== 0 || used.rowCount) throw conflict('ACCOUNT_HAS_BALANCE');
    }
    await c.query('UPDATE ledger_accounts SET is_active = coalesce($2, is_active), name = coalesce($3, name), details = coalesce($4, details) WHERE id = $1',
      [req.params.id, req.body.isActive ?? null, req.body.name ? JSON.stringify(req.body.name) : null, req.body.details ? JSON.stringify(req.body.details) : null]);
    await audit(c, actorOf(req), { action: 'account.updated', entityType: 'ledger_account', entityId: req.params.id, before: a, after: req.body, reason: req.body.reason });
    return { id: req.params.id };
  }));

  app.get('/admin/accounts/:id/statement', {
    ...staff('finance.view'),
    schema: { tags: ['admin:finance'], security: sec, params: idParams, querystring: z.object({ from: z.iso.date().optional(), to: z.iso.date().optional() }) },
  }, async (req) => {
    const a = (await db.query<{ country_id: string; type: string; currency_code: string; code: string }>('SELECT * FROM ledger_accounts WHERE id = $1', [req.params.id])).rows[0];
    if (!a || !can(requireUser(req), 'finance.view', a.country_id)) throw notFound();
    const opening = (await db.query<{ v: string }>(
      `SELECT coalesce(sum(l.debit - l.credit), 0)::numeric(20,4)::text AS v FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
        WHERE l.account_id = $1 AND $2::date IS NOT NULL AND e.occurred_at < $2::date`, [req.params.id, req.query.from ?? null])).rows[0]!.v;
    const lines = (await db.query(
      `SELECT e.number AS "entryNumber", e.occurred_at AS "occurredAt", e.description, e.source_type AS "sourceType", e.source_id AS "sourceId",
              l.debit, l.credit, l.booking_id AS "bookingId", l.provider_id AS "providerId", l.payment_id AS "paymentId"
         FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
        WHERE l.account_id = $1 AND ($2::date IS NULL OR e.occurred_at >= $2::date) AND ($3::date IS NULL OR e.occurred_at < $3::date + 1)
        ORDER BY e.occurred_at, l.id`, [req.params.id, req.query.from ?? null, req.query.to ?? null])).rows;
    return { account: { id: req.params.id, code: a.code, currency: a.currency_code, type: a.type }, openingDebitMinusCredit: opening, lines };
  });

  app.get('/admin/ledger/trial-balance', {
    ...staff('finance.view'),
    schema: { tags: ['admin:finance'], security: sec, querystring: z.object({ countryId: z.uuid(), currency, from: z.iso.date().optional(), to: z.iso.date().optional() }) },
  }, async (req) => {
    const q = req.query;
    if (!can(requireUser(req), 'finance.view', q.countryId)) throw notFound();
    const rows = (await db.query(
      `SELECT a.code, a.kind, a.type, a.name,
              coalesce(sum(l.debit - l.credit) FILTER (WHERE $3::date IS NOT NULL AND e.occurred_at < $3::date), 0)::numeric(20,4)::text AS opening,
              coalesce(sum(l.debit) FILTER (WHERE ($3::date IS NULL OR e.occurred_at >= $3::date) AND ($4::date IS NULL OR e.occurred_at < $4::date + 1)), 0)::numeric(20,4)::text AS debit,
              coalesce(sum(l.credit) FILTER (WHERE ($3::date IS NULL OR e.occurred_at >= $3::date) AND ($4::date IS NULL OR e.occurred_at < $4::date + 1)), 0)::numeric(20,4)::text AS credit,
              coalesce(sum(l.debit - l.credit) FILTER (WHERE $4::date IS NULL OR e.occurred_at < $4::date + 1), 0)::numeric(20,4)::text AS closing_debit_minus_credit
         FROM ledger_accounts a LEFT JOIN journal_lines l ON l.account_id = a.id LEFT JOIN journal_entries e ON e.id = l.entry_id
        WHERE a.country_id = $1 AND a.currency_code = $2
        GROUP BY a.id ORDER BY a.code`, [q.countryId, q.currency, q.from ?? null, q.to ?? null])).rows;
    const items = rows.map((r) => ({
      code: r.code, kind: r.kind, type: r.type, name: r.name, debit: r.debit, credit: r.credit,
      openingDebitMinusCredit: r.opening, closingDebitMinusCredit: r.closing_debit_minus_credit,
    }));
    const td = items.reduce((s, r) => s + toUnits(r.debit), 0n);
    const tc = items.reduce((s, r) => s + toUnits(r.credit), 0n);
    return { countryId: q.countryId, currency: q.currency, from: q.from ?? null, to: q.to ?? null, items, totals: { debit: fromUnits(td), credit: fromUnits(tc), balanced: td === tc } };
  });

  // =============== Admin: payments (clauses 34, 36) ===============
  app.get('/admin/payments', {
    ...staff('finance.view'),
    schema: {
      tags: ['admin:payments'], security: sec,
      querystring: paginationQuery.extend({ status: z.enum(['pending', 'awaiting_verification', 'succeeded', 'failed', 'cancelled']).optional(), needsAttention: z.enum(['true']).optional(), orderId: z.uuid().optional() }),
    },
  }, async (req) => {
    const scope = countryScope(requireUser(req), 'finance.view');
    const q = req.query;
    return (await db.query(
      `SELECT ${PAYMENT_COLUMNS}, p.country_id AS "countryId", cu.full_name AS "customerName"
         FROM payments p JOIN users cu ON cu.id = p.customer_id
        WHERE ($1::uuid[] IS NULL OR p.country_id = ANY($1)) AND ($2::text IS NULL OR p.status = $2) AND ($3::boolean IS NULL OR p.needs_attention IS NOT NULL)
          AND ($4::uuid IS NULL OR p.order_id = $4)
        ORDER BY p.created_at DESC LIMIT $5 OFFSET $6`, [scope, q.status ?? null, q.needsAttention ? true : null, q.orderId ?? null, q.limit, q.offset])).rows;
  });

  app.get('/admin/payments/:id', { ...staff('finance.view'), schema: { tags: ['admin:payments'], security: sec, params: idParams } }, async (req) => {
    const p = (await db.query(`SELECT ${PAYMENT_COLUMNS}, p.country_id AS "countryId", p.external_ref AS "externalRef" FROM payments p WHERE p.id = $1`, [req.params.id])).rows[0];
    if (!p || !can(requireUser(req), 'finance.view', p.countryId)) throw notFound();
    p.history = (await db.query(`SELECT from_status AS "from", to_status AS "to", actor_kind AS "actorKind", reason, created_at AS at FROM payment_status_events WHERE payment_id = $1 ORDER BY created_at, id`, [p.id])).rows;
    p.proofs = (await db.query(`SELECT id, mime_type AS "mimeType", size_bytes AS "sizeBytes", sha256, created_at AS "createdAt" FROM payment_proofs WHERE payment_id = $1`, [p.id])).rows;
    p.ledgerEntries = (await db.query(`SELECT number, description, occurred_at AS "occurredAt" FROM journal_entries WHERE source_type = 'payment' AND source_id = $1`, [p.id])).rows;
    return p;
  });

  app.get('/admin/payments/:id/proofs/:proofId', {
    ...staff('payments.review'), schema: { tags: ['admin:payments'], security: sec, params: z.object({ id: z.uuid(), proofId: z.uuid() }) },
  }, async (req, reply) => {
    const r = (await db.query<{ file_key: string; mime_type: string; country_id: string }>(
      `SELECT pp.file_key, pp.mime_type, p.country_id FROM payment_proofs pp JOIN payments p ON p.id = pp.payment_id WHERE pp.id = $1 AND p.id = $2`,
      [req.params.proofId, req.params.id])).rows[0];
    if (!r || !can(requireUser(req), 'payments.review', r.country_id)) throw notFound();
    const f = await deps.storage.open(r.file_key);
    return reply.header('cache-control', 'private, no-store').type(r.mime_type).send(f.stream);
  });

  app.post('/admin/payments/:id/review', {
    ...staff('payments.review'),
    schema: { tags: ['admin:payments'], security: sec, params: idParams, body: z.object({ decision: z.enum(['approve', 'reject']), verifiedAmount: money.optional(), note: reasonSchema }) },
  }, async (req) => {
    const p = (await db.query<{ country_id: string }>('SELECT country_id FROM payments WHERE id = $1', [req.params.id])).rows[0];
    if (!p) throw notFound();
    // Reviewing and approving money are separate permissions (clause 60).
    assertCan(requireUser(req), req.body.decision === 'approve' ? 'payments.approve' : 'payments.review', p.country_id);
    return reviewPayment(db, req.params.id, req.body.decision, req.body.verifiedAmount, req.body.note, actorOf(req));
  });

  app.get('/admin/payment-events', {
    ...staff('finance.view'),
    schema: { tags: ['admin:payments'], security: sec, querystring: paginationQuery.extend({ integrationId: z.uuid().optional(), result: z.enum(['processed', 'duplicate', 'rejected', 'ignored', 'error']).optional() }) },
  }, async (req) => {
    const scope = countryScope(requireUser(req), 'finance.view');
    return (await db.query(
      `SELECT w.id, w.integration_id AS "integrationId", w.external_event_id AS "externalEventId", w.event_type AS "eventType", w.external_ref AS "externalRef",
              w.signature_valid AS "signatureValid", w.result, w.error, w.received_at AS "receivedAt"
         FROM provider_webhook_events w JOIN payment_integrations i ON i.id = w.integration_id
        WHERE ($1::uuid[] IS NULL OR i.country_id = ANY($1)) AND ($2::uuid IS NULL OR w.integration_id = $2) AND ($3::text IS NULL OR w.result = $3)
        ORDER BY w.received_at DESC LIMIT $4 OFFSET $5`, [scope, req.query.integrationId ?? null, req.query.result ?? null, req.query.limit, req.query.offset])).rows;
  });

  // =============== Admin: commission rules (clause 40) ===============
  app.get('/admin/commission-rules', { ...staff('finance.view'), schema: { tags: ['admin:finance'], security: sec } }, async () =>
    (await db.query(
      `SELECT id, scope, country_id AS "countryId", service_type_id AS "serviceTypeId", provider_id AS "providerId", service_id AS "serviceId",
              rate_type AS "rateType", rate_value AS "rateValue", currency_code AS currency, priority, valid_from AS "validFrom", valid_to AS "validTo",
              agreement_ref AS "agreementRef", is_active AS "isActive", created_at AS "createdAt",
              (SELECT count(*)::int FROM booking_commissions bc WHERE bc.rule_id = r.id) AS "bookingsApplied"
         FROM commission_rules r ORDER BY created_at DESC`)).rows);

  app.post('/admin/commission-rules', {
    ...staff('commissions.manage'),
    schema: {
      tags: ['admin:finance'], security: sec,
      body: z.object({
        scope: z.enum(['global', 'country', 'service_type', 'provider', 'service']), countryId: z.uuid().nullable().default(null),
        serviceTypeId: z.uuid().nullable().default(null), providerId: z.uuid().nullable().default(null), serviceId: z.uuid().nullable().default(null),
        rateType: z.enum(['percent', 'fixed']), rateValue: money, currency: currency.nullable().default(null), priority: z.number().int().default(0),
        validFrom: z.iso.datetime({ offset: true }).optional(), validTo: z.iso.datetime({ offset: true }).nullable().default(null), agreementRef: z.string().max(200).nullable().default(null),
      }),
    },
  }, async (req, reply) => {
    const b = req.body;
    // Global rules need global scope; others are checked against the rule's country when known.
    assertCan(requireUser(req), 'commissions.manage', b.countryId);
    const id = await withTx(db, async (c) => {
      let rid: string;
      try {
        rid = (await c.query<{ id: string }>(
          `INSERT INTO commission_rules (scope, country_id, service_type_id, provider_id, service_id, rate_type, rate_value, currency_code, priority,
             valid_from, valid_to, agreement_ref, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,coalesce($10, now()),$11,$12,$13) RETURNING id`,
          [b.scope, b.countryId, b.serviceTypeId, b.providerId, b.serviceId, b.rateType, b.rateValue, b.currency, b.priority, b.validFrom ?? null, b.validTo,
            b.agreementRef, requireUser(req).id])).rows[0]!.id;
      } catch (err) {
        if ((err as { code?: string }).code === '23514') throw badRequest('VALIDATION_FAILED', [{ path: '/', message: 'scope fields, percent <= 100, currency for fixed rates, valid_to after valid_from' }]);
        throw err;
      }
      await audit(c, actorOf(req), { action: 'commission_rule.created', entityType: 'commission_rule', entityId: rid, after: b });
      return rid;
    });
    return reply.status(201).send({ id });
  });

  app.patch('/admin/commission-rules/:id', {
    ...staff('commissions.manage'),
    schema: { tags: ['admin:finance'], security: sec, params: idParams, body: z.object({ isActive: z.boolean().optional(), validTo: z.iso.datetime({ offset: true }).nullable().optional(), agreementRef: z.string().max(200).nullable().optional(), reason: reasonSchema }) },
  }, async (req) => withTx(db, async (c) => {
    const before = (await c.query<{ country_id: string | null }>('SELECT * FROM commission_rules WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
    if (!before) throw notFound();
    assertCan(requireUser(req), 'commissions.manage', before.country_id);
    const has = (k: string) => Object.hasOwn(req.body, k);
    // Rate terms are immutable (database trigger): only the end date, status and agreement reference change.
    await c.query(
      `UPDATE commission_rules SET is_active = coalesce($2, is_active), valid_to = CASE WHEN $3 THEN $4::timestamptz ELSE valid_to END,
         agreement_ref = CASE WHEN $5 THEN $6 ELSE agreement_ref END WHERE id = $1`,
      [req.params.id, req.body.isActive ?? null, has('validTo'), req.body.validTo ?? null, has('agreementRef'), req.body.agreementRef ?? null]);
    await audit(c, actorOf(req), { action: 'commission_rule.updated', entityType: 'commission_rule', entityId: req.params.id, before, after: req.body, reason: req.body.reason });
    return { id: req.params.id };
  }));

  // =============== Admin: provider earnings (clauses 42-43) ===============
  app.get('/admin/earnings', {
    ...staff('finance.view'),
    schema: { tags: ['admin:finance'], security: sec, querystring: paginationQuery.extend({ providerId: z.uuid().optional(), status: z.string().max(30).optional() }) },
  }, async (req) => {
    const scope = countryScope(requireUser(req), 'finance.view');
    const q = req.query;
    return (await db.query(
      `SELECT e.id, e.booking_id AS "bookingId", b.number AS "bookingNumber", e.provider_id AS "providerId", p.business_name AS "providerName",
              e.currency_code AS currency, e.booking_total AS "bookingTotal", e.collected_by_platform AS "collectedByPlatform",
              e.collected_directly AS "collectedDirectly", e.commission_amount AS commission, e.net_amount AS net, e.status, e.status_reason AS "statusReason", e.due_at AS "dueAt"
         FROM provider_earnings e JOIN bookings b ON b.id = e.booking_id JOIN providers p ON p.id = e.provider_id
        WHERE ($1::uuid[] IS NULL OR e.country_id = ANY($1)) AND ($2::uuid IS NULL OR e.provider_id = $2) AND ($3::text IS NULL OR e.status = $3)
        ORDER BY e.created_at DESC LIMIT $4 OFFSET $5`, [scope, q.providerId ?? null, q.status ?? null, q.limit, q.offset])).rows;
  });

  app.post('/admin/earnings/:id/approve-review', {
    ...staff('settlements.approve'), schema: { tags: ['admin:finance'], security: sec, params: idParams, body: z.object({ note: reasonSchema }) },
  }, async (req) => withTx(db, async (c) => {
    const e = (await c.query<{ country_id: string }>('SELECT country_id FROM provider_earnings WHERE id = $1', [req.params.id])).rows[0];
    if (!e) throw notFound();
    assertCan(requireUser(req), 'settlements.approve', e.country_id);
    await approveEarningReview(c, req.params.id, actorOf(req), req.body.note);
    return { status: 'due' };
  }));

  // =============== Admin: refunds (clause 50) ===============
  const REFUND_COLUMNS = `r.id, r.number, r.booking_id AS "bookingId", b.number AS "bookingNumber", r.payment_id AS "paymentId", r.amount, r.currency_code AS currency,
    r.source, r.reason, r.method, r.status, r.external_ref AS "externalRef", r.failure_reason AS "failureReason", r.rejection_reason AS "rejectionReason",
    r.requested_by AS "requestedBy", r.requested_by_kind AS "requestedByKind", r.reviewed_by AS "reviewedBy", r.approved_by AS "approvedBy",
    r.approved_at AS "approvedAt", r.executed_by AS "executedBy", r.executed_at AS "executedAt", r.created_at AS "createdAt", b.country_id AS "countryId"`;

  app.get('/admin/refunds', {
    ...staff('finance.view'),
    schema: { tags: ['admin:finance'], security: sec, querystring: paginationQuery.extend({ status: z.enum(['requested', 'approved', 'processing', 'completed', 'rejected', 'failed']).optional(), bookingId: z.uuid().optional() }) },
  }, async (req) => {
    const scope = countryScope(requireUser(req), 'finance.view');
    return (await db.query(
      `SELECT ${REFUND_COLUMNS} FROM refunds r JOIN bookings b ON b.id = r.booking_id
        WHERE ($1::uuid[] IS NULL OR b.country_id = ANY($1)) AND ($2::text IS NULL OR r.status = $2) AND ($3::uuid IS NULL OR r.booking_id = $3)
        ORDER BY r.created_at DESC LIMIT $4 OFFSET $5`, [scope, req.query.status ?? null, req.query.bookingId ?? null, req.query.limit, req.query.offset])).rows;
  });

  app.get('/admin/refunds/:id', { ...staff('finance.view'), schema: { tags: ['admin:finance'], security: sec, params: idParams } }, async (req) => {
    const r = (await db.query(`SELECT ${REFUND_COLUMNS} FROM refunds r JOIN bookings b ON b.id = r.booking_id WHERE r.id = $1`, [req.params.id])).rows[0];
    if (!r || !can(requireUser(req), 'finance.view', r.countryId)) throw notFound();
    r.history = (await db.query(`SELECT from_status AS "from", to_status AS "to", actor_kind AS "actorKind", reason, created_at AS at FROM refund_status_events WHERE refund_id = $1 ORDER BY created_at, id`, [r.id])).rows;
    return r;
  });

  /** Manual refund on a booking that ended (e.g. money received after the slot was lost or the booking cancelled). */
  app.post('/admin/bookings/:id/refunds', {
    ...staff('refunds.execute'),
    schema: {
      tags: ['admin:finance'], security: sec, params: idParams,
      body: z.object({ amount: money, reason: reasonSchema, source: z.enum(['slot_unavailable', 'booking_cancelled', 'manual']).default('manual') }),
    },
  }, async (req, reply) => reply.status(201).send(await withTx(db, async (c) => {
    const b = (await c.query<{ country_id: string; status: string }>('SELECT country_id, status FROM bookings WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
    if (!b) throw notFound();
    assertCan(requireUser(req), 'refunds.execute', b.country_id);
    // Refunds on live or completed bookings belong to the cancellation and dispute processes.
    if (!['no_show', 'rejected', 'expired', 'cancelled_by_customer', 'cancelled_by_provider', 'cancelled_by_admin'].includes(b.status)) {
      throw conflict('INVALID_STATUS_TRANSITION', { reason: 'manual refunds are for bookings that ended without the service' });
    }
    return { refundIds: await requestRefunds(c, req.params.id, req.body.amount, req.body.source, req.body.reason, actorOf(req)) };
  })));

  app.get('/admin/bookings/:id/refundable', { ...staff('finance.view'), schema: { tags: ['admin:finance'], security: sec, params: idParams } }, async (req) => {
    const b = (await db.query<{ country_id: string }>('SELECT country_id FROM bookings WHERE id = $1', [req.params.id])).rows[0];
    if (!b || !can(requireUser(req), 'finance.view', b.country_id)) throw notFound();
    const r = await refundableFor(db, req.params.id);
    return {
      platformPaid: fromUnits(r.platformPaid), refundable: fromUnits(r.available), directPaid: fromUnits(r.directPaid),
      payments: r.items.map((i) => ({ paymentId: i.paymentId, method: i.method, verified: fromUnits(i.verified), refunded: fromUnits(i.refunded), available: fromUnits(i.available) })),
    };
  });

  const refundAction = (path: string, body: z.ZodType, run: (c: Parameters<Parameters<typeof withTx>[1]>[0], id: string, b: Record<string, string>, ctx: ReturnType<typeof actorOf>) => Promise<unknown>) =>
    app.post(`/admin/refunds/:id/${path}`, { ...staff('refunds.execute'), schema: { tags: ['admin:finance'], security: sec, params: idParams, body } }, async (req) => withTx(db, async (c) => {
      const r = (await c.query<{ country_id: string }>('SELECT b.country_id FROM refunds r JOIN bookings b ON b.id = r.booking_id WHERE r.id = $1', [(req.params as { id: string }).id])).rows[0];
      if (!r) throw notFound();
      assertCan(requireUser(req), 'refunds.execute', r.country_id);
      const result = await run(c, (req.params as { id: string }).id, (req.body ?? {}) as Record<string, string>, actorOf(req));
      return result ?? { ok: true };
    }));
  refundAction('approve', optionalBody(z.object({})), async (c, id, _b, ctx) => { await approveRefund(c, id, ctx); return { status: 'approved' }; });
  refundAction('reject', z.object({ reason: reasonSchema }), async (c, id, b, ctx) => { await rejectRefund(c, id, b.reason!, ctx); return { status: 'rejected' }; });
  refundAction('execute', optionalBody(z.object({ externalRef: z.string().trim().min(3).max(200).optional() })), (c, id, b, ctx) => executeRefund(c, config, id, b.externalRef, ctx));
  refundAction('fail', z.object({ reason: reasonSchema }), async (c, id, b, ctx) => { await failRefund(c, id, b.reason!, ctx); return { status: 'failed' }; });

  // =============== Admin: settlements (clauses 43-44) ===============
  app.patch('/admin/providers/:id/interim-settlement', {
    ...staff('settlements.approve'),
    schema: {
      tags: ['admin:finance'], security: sec, params: idParams,
      body: z.object({ eligible: z.boolean(), maxPercent: z.number().gt(0).max(100).nullable().default(null), agreementRef: z.string().trim().min(2).max(200).nullable().default(null), reason: reasonSchema }),
    },
  }, async (req) => withTx(db, async (c) => {
    const p = (await c.query<{ country_id: string }>('SELECT country_id, interim_settlement_eligible, interim_max_percent, interim_agreement_ref FROM providers WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
    if (!p) throw notFound();
    assertCan(requireUser(req), 'settlements.approve', p.country_id);
    const b = req.body;
    if (b.eligible && (!b.maxPercent || !b.agreementRef)) throw badRequest('VALIDATION_FAILED', [{ path: '/agreementRef', message: 'eligibility needs a documented agreement and a maximum percentage' }]);
    await c.query('UPDATE providers SET interim_settlement_eligible = $2, interim_max_percent = $3, interim_agreement_ref = $4 WHERE id = $1',
      [req.params.id, b.eligible, b.eligible ? b.maxPercent : null, b.eligible ? b.agreementRef : null]);
    await audit(c, actorOf(req), { action: 'provider.interim_settlement_changed', entityType: 'provider', entityId: req.params.id, before: p, after: b, reason: b.reason });
    return { eligible: b.eligible };
  }));

  app.get('/admin/settlements/preview', {
    ...staff('settlements.approve'), schema: { tags: ['admin:finance'], security: sec, querystring: z.object({ providerId: z.uuid(), currency }) },
  }, async (req) => {
    const p = (await db.query<{ country_id: string }>('SELECT country_id FROM providers WHERE id = $1', [req.query.providerId])).rows[0];
    if (!p || !can(requireUser(req), 'settlements.approve', p.country_id)) throw notFound();
    const el = await eligibleEarnings(db, req.query.providerId, req.query.currency);
    return { total: fromUnits(el.total), items: el.items.map((i) => ({ ...i, amount: fromUnits(i.amount) })) };
  });

  app.post('/admin/settlements', {
    ...staff('settlements.approve'),
    schema: {
      tags: ['admin:finance'], security: sec,
      body: z.object({
        providerId: z.uuid(), currency, accountId: z.uuid(), method: z.enum(['bank_transfer', 'cash', 'wallet']), kind: z.enum(['regular', 'interim']).default('regular'),
        bookingId: z.uuid().optional(), amount: money.optional(), notes: z.string().max(1000).optional(),
      }),
    },
  }, async (req, reply) => reply.status(201).send(await withTx(db, async (c) => {
    const p = (await c.query<{ country_id: string }>('SELECT country_id FROM providers WHERE id = $1', [req.body.providerId])).rows[0];
    if (!p) throw notFound();
    assertCan(requireUser(req), 'settlements.approve', p.country_id);
    return createSettlement(c, req.body, actorOf(req));
  })));

  const SETTLEMENT_COLUMNS = `s.id, s.number, s.provider_id AS "providerId", p.business_name AS "providerName", s.country_id AS "countryId", s.currency_code AS currency,
    s.kind, s.amount, s.method, s.account_id AS "accountId", s.status, s.created_by AS "createdBy", s.approved_by AS "approvedBy", s.approved_at AS "approvedAt",
    s.paid_at AS "paidAt", s.external_ref AS "externalRef", s.failure_reason AS "failureReason", s.notes, s.created_at AS "createdAt"`;

  app.get('/admin/settlements', {
    ...staff('finance.view'), schema: { tags: ['admin:finance'], security: sec, querystring: paginationQuery.extend({ providerId: z.uuid().optional(), status: z.string().max(30).optional() }) },
  }, async (req) => {
    const scope = countryScope(requireUser(req), 'finance.view');
    return (await db.query(
      `SELECT ${SETTLEMENT_COLUMNS} FROM settlements s JOIN providers p ON p.id = s.provider_id
        WHERE ($1::uuid[] IS NULL OR s.country_id = ANY($1)) AND ($2::uuid IS NULL OR s.provider_id = $2) AND ($3::text IS NULL OR s.status = $3)
        ORDER BY s.created_at DESC LIMIT $4 OFFSET $5`, [scope, req.query.providerId ?? null, req.query.status ?? null, req.query.limit, req.query.offset])).rows;
  });

  app.get('/admin/settlements/:id', { ...staff('finance.view'), schema: { tags: ['admin:finance'], security: sec, params: idParams } }, async (req) => {
    const st = (await db.query(`SELECT ${SETTLEMENT_COLUMNS} FROM settlements s JOIN providers p ON p.id = s.provider_id WHERE s.id = $1`, [req.params.id])).rows[0];
    if (!st || !can(requireUser(req), 'finance.view', st.countryId)) throw notFound();
    st.items = (await db.query(`SELECT i.earning_id AS "earningId", i.booking_id AS "bookingId", b.number AS "bookingNumber", i.amount, i.status FROM settlement_items i JOIN bookings b ON b.id = i.booking_id WHERE i.settlement_id = $1`, [st.id])).rows;
    st.history = (await db.query(`SELECT from_status AS "from", to_status AS "to", reason, created_at AS at FROM settlement_status_events WHERE settlement_id = $1 ORDER BY created_at, id`, [st.id])).rows;
    return st;
  });

  const settlementAction = (path: string, body: z.ZodType, run: (c: Parameters<Parameters<typeof withTx>[1]>[0], id: string, b: Record<string, string>, ctx: ReturnType<typeof actorOf>) => Promise<unknown>) =>
    app.post(`/admin/settlements/:id/${path}`, { ...staff('settlements.approve'), schema: { tags: ['admin:finance'], security: sec, params: idParams, body } }, async (req) => withTx(db, async (c) => {
      const st = (await c.query<{ country_id: string }>('SELECT country_id FROM settlements WHERE id = $1', [(req.params as { id: string }).id])).rows[0];
      if (!st) throw notFound();
      assertCan(requireUser(req), 'settlements.approve', st.country_id);
      await run(c, (req.params as { id: string }).id, (req.body ?? {}) as Record<string, string>, actorOf(req));
      return (await c.query('SELECT status FROM settlements WHERE id = $1', [(req.params as { id: string }).id])).rows[0];
    }));
  settlementAction('approve', optionalBody(z.object({})), (c, id, _b, ctx) => approveSettlement(c, id, ctx));
  settlementAction('mark-paid', z.object({ externalRef: z.string().trim().min(3).max(200) }), (c, id, b, ctx) => markSettlementPaid(c, id, b.externalRef!, ctx));
  settlementAction('mark-failed', z.object({ reason: reasonSchema }), (c, id, b, ctx) => closeSettlementUnpaid(c, id, 'failed', b.reason!, ctx));
  settlementAction('cancel', z.object({ reason: reasonSchema }), (c, id, b, ctx) => closeSettlementUnpaid(c, id, 'cancelled', b.reason!, ctx));

  // =============== Provider panel: settlements ===============
  app.get('/provider/settlements', { onRequest: deps.authenticate, preValidation: requireKind('provider'), schema: { tags: ['provider-panel'], security: sec } }, async (req) => {
    const p = await providerOf(db, req, { forWrite: false });
    return (await db.query(
      `SELECT s.id, s.number, s.kind, s.amount, s.currency_code AS currency, s.method, s.status, s.paid_at AS "paidAt", s.external_ref AS "externalRef", s.created_at AS "createdAt"
         FROM settlements s WHERE s.provider_id = $1 ORDER BY s.created_at DESC`, [p.id])).rows;
  });
}
