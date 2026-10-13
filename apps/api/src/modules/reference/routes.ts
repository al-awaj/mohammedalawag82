import { z } from 'zod';
import type { App, Deps } from '../../deps.js';
import { actorOf, assertCan, countryScope, requirePermission, requireUser } from '../../auth/guard.js';
import { withTx, type Executor } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { badRequest, conflict, mapUniqueViolation, notFound } from '../../lib/errors.js';
import { i18nTextSchema, idParams, langSchema, reasonSchema } from '../common.js';

const currencyCode = z.string().regex(/^[A-Z]{3}$/);
const decimalString = z.string().regex(/^\d{1,14}(\.\d{1,10})?$/, 'positive decimal as string, e.g. "3.7500"');

const countryFields = z.object({
  code: z.string().regex(/^[A-Z]{2}$/),
  name: i18nTextSchema,
  baseCurrency: currencyCode,
  timezone: z.string().refine((tz) => Intl.supportedValuesOf('timeZone').includes(tz) || tz === 'UTC', 'unknown IANA timezone'),
  defaultLanguage: langSchema,
  phonePrefix: z.string().regex(/^\+[0-9]{1,4}$/),
  dateFormat: z.string().max(20).optional(),
  timeFormat: z.string().max(20).optional(),
  taxSettings: z.record(z.string(), z.unknown()).optional(),
  invoiceSettings: z.record(z.string(), z.unknown()).optional(),
  messagingSettings: z.record(z.string(), z.unknown()).optional(),
  isActive: z.boolean(),
  currencies: z.array(currencyCode),
});
// Defaults only on create: a PATCH must never reset fields the caller did not send.
const countryBody = countryFields.extend({ isActive: z.boolean().default(false), currencies: z.array(currencyCode).default([]) });
const countryPatch = countryFields.omit({ code: true }).partial().extend({ reason: reasonSchema.optional() });

const COUNTRY_COLUMNS = `c.id, c.code, c.name, c.base_currency AS "baseCurrency", c.timezone, c.default_language AS "defaultLanguage",
  c.phone_prefix AS "phonePrefix", c.date_format AS "dateFormat", c.time_format AS "timeFormat", c.is_active AS "isActive",
  coalesce((SELECT json_agg(cc.currency_code ORDER BY cc.currency_code) FROM country_currencies cc
             WHERE cc.country_id = c.id AND cc.is_active), '[]') AS currencies`;

async function assertCurrenciesActive(c: Executor, codes: string[]) {
  if (!codes.length) return;
  const { rows } = await c.query<{ code: string }>('SELECT code FROM currencies WHERE code = ANY($1) AND is_active', [codes]);
  const found = new Set(rows.map((r) => r.code.trim()));
  const missing = codes.filter((x) => !found.has(x));
  if (missing.length) throw badRequest('CURRENCY_NOT_FOUND', { missing });
}

async function replaceCountryCurrencies(c: Executor, countryId: string, base: string, codes: string[]) {
  const all = [...new Set([base, ...codes])];
  await assertCurrenciesActive(c, all);
  await c.query('UPDATE country_currencies SET is_active = false WHERE country_id = $1 AND NOT (currency_code = ANY($2))', [countryId, all]);
  await c.query(
    `INSERT INTO country_currencies (country_id, currency_code) SELECT $1, unnest($2::char(3)[])
     ON CONFLICT (country_id, currency_code) DO UPDATE SET is_active = true`,
    [countryId, all],
  );
}

/** Latest rate effective at `at`; tries the inverse pair when only that one was entered. */
export async function findRate(exec: Executor, base: string, quote: string, at: Date = new Date()) {
  if (base === quote) return { rate: '1', effectiveAt: at, source: 'identity', id: null as string | null, inverted: false };
  const { rows } = await exec.query<{ id: string; base_currency: string; rate: string; effective_at: Date; source: string }>(
    `SELECT id, base_currency, rate, effective_at, source FROM exchange_rates
      WHERE ((base_currency = $1 AND quote_currency = $2) OR (base_currency = $2 AND quote_currency = $1))
        AND effective_at <= $3
      ORDER BY effective_at DESC, (base_currency = $1) DESC, created_at DESC LIMIT 1`,
    [base, quote, at],
  );
  const r = rows[0];
  if (!r) return null;
  const inverted = r.base_currency.trim() !== base;
  return {
    id: r.id,
    // Inverse kept at full DB precision; computed in SQL to avoid float rounding.
    rate: inverted ? (await exec.query<{ v: string }>('SELECT round(1 / $1::numeric, 10)::text AS v', [r.rate])).rows[0]!.v : r.rate,
    effectiveAt: r.effective_at,
    source: r.source,
    inverted,
  };
}

export async function referenceRoutes(app: App, deps: Deps) {
  const { db } = deps;
  const auth = { onRequest: deps.authenticate };

  // ---------------- Public ----------------
  app.get('/languages', { schema: { tags: ['reference'] } }, async () =>
    (await db.query('SELECT code, name, direction FROM languages WHERE is_active ORDER BY code')).rows);

  app.get('/currencies', { schema: { tags: ['reference'] } }, async () =>
    (await db.query(`SELECT code, name, symbol, minor_units AS "minorUnits" FROM currencies WHERE is_active ORDER BY code`)).rows);

  app.get('/countries', { schema: { tags: ['reference'] } }, async () =>
    (await db.query(`SELECT ${COUNTRY_COLUMNS} FROM countries c WHERE c.is_active ORDER BY c.code`)).rows);

  app.get('/exchange-rates/latest', {
    schema: { tags: ['reference'], querystring: z.object({ base: currencyCode, quote: currencyCode }) },
  }, async (req) => {
    const r = await findRate(db, req.query.base, req.query.quote);
    if (!r) throw notFound();
    return { base: req.query.base, quote: req.query.quote, ...r };
  });

  app.get('/terms/current', {
    schema: {
      tags: ['reference'],
      querystring: z.object({ kind: z.enum(['customer_terms', 'privacy_policy', 'provider_terms']), country: z.string().length(2).toUpperCase() }),
    },
  }, async (req) => {
    const { rows } = await db.query(
      `SELECT t.id, t.kind, t.version, t.content, t.published_at AS "publishedAt"
         FROM terms_versions t JOIN countries c ON c.code = $2
        WHERE t.kind = $1 AND (t.country_id = c.id OR t.country_id IS NULL)
        ORDER BY (t.country_id IS NOT NULL) DESC, t.published_at DESC LIMIT 1`,
      [req.query.kind, req.query.country],
    );
    if (!rows[0]) throw notFound();
    return rows[0];
  });

  // ---------------- Admin: currencies (global scope) ----------------
  app.get('/admin/currencies', { ...auth, preValidation: requirePermission('currencies.manage'), schema: { tags: ['admin:reference'] } },
    async () => (await db.query(`SELECT code, name, symbol, minor_units AS "minorUnits", is_active AS "isActive" FROM currencies ORDER BY code`)).rows);

  app.post('/admin/currencies', {
    ...auth, preValidation: requirePermission('currencies.manage'),
    schema: { tags: ['admin:reference'], body: z.object({ code: currencyCode, name: i18nTextSchema, symbol: z.string().min(1).max(8), minorUnits: z.number().int().min(0).max(4).default(2), isActive: z.boolean().default(true) }) },
  }, async (req, reply) => {
    assertCan(requireUser(req), 'currencies.manage');
    const b = req.body;
    await withTx(db, async (c) => {
      try {
        await c.query('INSERT INTO currencies (code, name, symbol, minor_units, is_active) VALUES ($1, $2, $3, $4, $5)',
          [b.code, JSON.stringify(b.name), b.symbol, b.minorUnits, b.isActive]);
      } catch (err) { mapUniqueViolation(err, { currencies_pkey: 'CODE_TAKEN' }); }
      await audit(c, actorOf(req), { action: 'currency.created', entityType: 'currency', entityId: b.code, after: b });
    });
    return reply.status(201).send({ code: b.code });
  });

  app.patch('/admin/currencies/:code', {
    ...auth, preValidation: requirePermission('currencies.manage'),
    schema: {
      tags: ['admin:reference'], params: z.object({ code: currencyCode }),
      body: z.object({ name: i18nTextSchema.optional(), symbol: z.string().min(1).max(8).optional(), isActive: z.boolean().optional() }),
    },
  }, async (req) => {
    assertCan(requireUser(req), 'currencies.manage');
    return withTx(db, async (c) => {
      const before = (await c.query('SELECT name, symbol, is_active FROM currencies WHERE code = $1 FOR UPDATE', [req.params.code])).rows[0];
      if (!before) throw notFound();
      if (req.body.isActive === false) {
        const used = await c.query('SELECT 1 FROM countries WHERE base_currency = $1 AND is_active', [req.params.code]);
        if (used.rowCount) throw conflict('CURRENCY_IN_USE');
      }
      // minor_units is intentionally not editable: it would reinterpret historical amounts.
      const after = (await c.query(
        `UPDATE currencies SET name = coalesce($2, name), symbol = coalesce($3, symbol), is_active = coalesce($4, is_active)
          WHERE code = $1 RETURNING name, symbol, is_active`,
        [req.params.code, req.body.name ? JSON.stringify(req.body.name) : null, req.body.symbol ?? null, req.body.isActive ?? null],
      )).rows[0];
      await audit(c, actorOf(req), { action: 'currency.updated', entityType: 'currency', entityId: req.params.code, before, after });
      return { code: req.params.code, ...after };
    });
  });

  // ---------------- Admin: countries ----------------
  app.get('/admin/countries', { ...auth, preValidation: requirePermission('countries.manage'), schema: { tags: ['admin:reference'] } }, async (req) => {
    const scope = countryScope(requireUser(req), 'countries.manage');
    return (await db.query(
      `SELECT ${COUNTRY_COLUMNS}, c.tax_settings AS "taxSettings", c.invoice_settings AS "invoiceSettings",
              c.messaging_settings AS "messagingSettings"
         FROM countries c WHERE ($1::uuid[] IS NULL OR c.id = ANY($1)) ORDER BY c.code`,
      [scope],
    )).rows;
  });

  app.post('/admin/countries', {
    ...auth, preValidation: requirePermission('countries.manage'), schema: { tags: ['admin:reference'], body: countryBody },
  }, async (req, reply) => {
    assertCan(requireUser(req), 'countries.manage'); // creating a country needs global scope
    const b = req.body;
    const id = await withTx(db, async (c) => {
      await assertCurrenciesActive(c, [b.baseCurrency]);
      const lang = await c.query('SELECT 1 FROM languages WHERE code = $1 AND is_active', [b.defaultLanguage]);
      if (!lang.rowCount) throw badRequest('LANGUAGE_NOT_SUPPORTED');
      let countryId: string;
      try {
        countryId = (await c.query<{ id: string }>(
          `INSERT INTO countries (code, name, base_currency, timezone, default_language, phone_prefix, date_format, time_format,
                                  tax_settings, invoice_settings, messaging_settings, is_active)
           VALUES ($1, $2, $3, $4, $5, $6, coalesce($7, 'dd/MM/yyyy'), coalesce($8, 'HH:mm'), $9, $10, $11, $12) RETURNING id`,
          [b.code, JSON.stringify(b.name), b.baseCurrency, b.timezone, b.defaultLanguage, b.phonePrefix, b.dateFormat ?? null,
            b.timeFormat ?? null, JSON.stringify(b.taxSettings ?? {}), JSON.stringify(b.invoiceSettings ?? {}),
            JSON.stringify(b.messagingSettings ?? {}), b.isActive],
        )).rows[0]!.id;
      } catch (err) { mapUniqueViolation(err, { countries_code: 'CODE_TAKEN' }); }
      await replaceCountryCurrencies(c, countryId, b.baseCurrency, b.currencies);
      await audit(c, actorOf(req), { action: 'country.created', entityType: 'country', entityId: countryId, after: b });
      return countryId;
    });
    return reply.status(201).send({ id });
  });

  app.patch('/admin/countries/:id', {
    ...auth, preValidation: requirePermission('countries.manage'),
    schema: { tags: ['admin:reference'], params: idParams, body: countryPatch },
  }, async (req) => {
    assertCan(requireUser(req), 'countries.manage', req.params.id);
    const b = req.body;
    return withTx(db, async (c) => {
      const before = (await c.query(`SELECT ${COUNTRY_COLUMNS} FROM countries c WHERE c.id = $1 FOR UPDATE`, [req.params.id])).rows[0];
      if (!before) throw notFound();
      if (b.baseCurrency) await assertCurrenciesActive(c, [b.baseCurrency]);
      if (b.defaultLanguage) {
        const lang = await c.query('SELECT 1 FROM languages WHERE code = $1 AND is_active', [b.defaultLanguage]);
        if (!lang.rowCount) throw badRequest('LANGUAGE_NOT_SUPPORTED');
      }
      const j = (v: unknown) => (v === undefined ? null : JSON.stringify(v));
      await c.query(
        `UPDATE countries SET name = coalesce($2, name), base_currency = coalesce($3, base_currency), timezone = coalesce($4, timezone),
                default_language = coalesce($5, default_language), phone_prefix = coalesce($6, phone_prefix),
                date_format = coalesce($7, date_format), time_format = coalesce($8, time_format),
                tax_settings = coalesce($9, tax_settings), invoice_settings = coalesce($10, invoice_settings),
                messaging_settings = coalesce($11, messaging_settings), is_active = coalesce($12, is_active)
          WHERE id = $1`,
        [req.params.id, j(b.name), b.baseCurrency ?? null, b.timezone ?? null, b.defaultLanguage ?? null, b.phonePrefix ?? null,
          b.dateFormat ?? null, b.timeFormat ?? null, j(b.taxSettings), j(b.invoiceSettings), j(b.messagingSettings), b.isActive ?? null],
      );
      const base = b.baseCurrency ?? before.baseCurrency;
      if (b.currencies || b.baseCurrency) await replaceCountryCurrencies(c, req.params.id, base, b.currencies ?? before.currencies);
      const after = (await c.query(`SELECT ${COUNTRY_COLUMNS} FROM countries c WHERE c.id = $1`, [req.params.id])).rows[0];
      await audit(c, actorOf(req), { action: 'country.updated', entityType: 'country', entityId: req.params.id, before, after, reason: b.reason ?? null });
      return after;
    });
  });

  // ---------------- Admin: exchange rates (append-only) ----------------
  app.post('/admin/exchange-rates', {
    ...auth, preValidation: requirePermission('exchange_rates.manage'),
    schema: {
      tags: ['admin:reference'],
      body: z.object({
        base: currencyCode, quote: currencyCode, rate: decimalString,
        effectiveAt: z.coerce.date().optional(), source: z.string().trim().min(2).max(200),
      }).refine((v) => v.base !== v.quote, 'base and quote must differ'),
    },
  }, async (req, reply) => {
    assertCan(requireUser(req), 'exchange_rates.manage');
    const b = req.body;
    if (Number(b.rate) <= 0) throw badRequest('VALIDATION_FAILED', [{ path: '/rate', message: 'must be > 0' }]);
    const row = await withTx(db, async (c) => {
      await assertCurrenciesActive(c, [b.base, b.quote]);
      const r = (await c.query(
        `INSERT INTO exchange_rates (base_currency, quote_currency, rate, effective_at, source, entered_by)
         VALUES ($1, $2, $3, coalesce($4, now()), $5, $6)
         RETURNING id, base_currency AS base, quote_currency AS quote, rate, effective_at AS "effectiveAt", source`,
        [b.base, b.quote, b.rate, b.effectiveAt ?? null, b.source, requireUser(req).id],
      )).rows[0];
      await audit(c, actorOf(req), { action: 'exchange_rate.created', entityType: 'exchange_rate', entityId: r.id, after: r });
      return r;
    });
    return reply.status(201).send(row);
  });

  app.get('/admin/exchange-rates', {
    ...auth, preValidation: requirePermission('exchange_rates.manage'),
    schema: { tags: ['admin:reference'], querystring: z.object({ base: currencyCode.optional(), quote: currencyCode.optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }) },
  }, async (req) => (await db.query(
    `SELECT r.id, r.base_currency AS base, r.quote_currency AS quote, r.rate, r.effective_at AS "effectiveAt", r.source,
            r.created_at AS "createdAt", u.full_name AS "enteredBy"
       FROM exchange_rates r LEFT JOIN users u ON u.id = r.entered_by
      WHERE ($1::text IS NULL OR r.base_currency = $1) AND ($2::text IS NULL OR r.quote_currency = $2)
      ORDER BY r.effective_at DESC LIMIT $3`,
    [req.query.base ?? null, req.query.quote ?? null, req.query.limit],
  )).rows);

  // ---------------- Admin: terms (immutable versions) ----------------
  app.post('/admin/terms', {
    ...auth, preValidation: requirePermission('terms.manage'),
    schema: {
      tags: ['admin:reference'],
      body: z.object({
        kind: z.enum(['customer_terms', 'privacy_policy', 'provider_terms']),
        countryId: z.uuid().nullable().default(null),
        version: z.string().trim().min(1).max(50),
        content: i18nTextSchema,
      }),
    },
  }, async (req, reply) => {
    const user = requireUser(req);
    assertCan(user, 'terms.manage', req.body.countryId);
    const b = req.body;
    const id = await withTx(db, async (c) => {
      let termsId: string;
      try {
        termsId = (await c.query<{ id: string }>(
          'INSERT INTO terms_versions (kind, country_id, version, content, published_by) VALUES ($1, $2, $3, $4, $5) RETURNING id',
          [b.kind, b.countryId, b.version, JSON.stringify(b.content), user.id],
        )).rows[0]!.id;
      } catch (err) { mapUniqueViolation(err, { terms_versions: 'CODE_TAKEN' }); }
      await audit(c, actorOf(req), { action: 'terms.published', entityType: 'terms_version', entityId: termsId, after: { kind: b.kind, countryId: b.countryId, version: b.version } });
      return termsId;
    });
    return reply.status(201).send({ id });
  });
}
