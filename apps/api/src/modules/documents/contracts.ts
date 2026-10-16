import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import type { App, Deps } from '../../deps.js';
import { actorOf, assertCan, can, requirePermission, requireUser } from '../../auth/guard.js';
import { withTx, type Executor } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { embeddedFontCss, htmlToPdf } from '../../lib/pdf.js';
import { i18nTextSchema, idParams, reasonSchema } from '../common.js';
import { getSetting } from '../settings/registry.js';

const sec = [{ bearer: [] }];
type Lang = 'ar' | 'en';

/** Placeholders a template may use; anything else is rejected when saving so a typo never reaches a customer. */
export const PLACEHOLDERS = [
  'platformName', 'bookingNumber', 'bookingDate', 'customerName', 'customerPhone', 'providerName', 'service', 'package',
  'startAt', 'endAt', 'guests', 'total', 'currency', 'upfrontAmount', 'balanceDueAt', 'instalments', 'cancellationPolicy', 'serviceTerms', 'packageTerms',
] as const;

const templateBody = z.object({
  countryId: z.uuid().nullable().default(null),
  title: i18nTextSchema,
  body: i18nTextSchema,
  reason: reasonSchema,
});

function unknownPlaceholders(text: string) {
  return [...text.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)].map((m) => m[1]!).filter((k) => !(PLACEHOLDERS as readonly string[]).includes(k));
}

/** The template in force for a country now: its own latest version, else the latest general one. */
export async function currentTemplate(c: Executor, countryId: string) {
  return (await c.query<{ id: string }>(
    `SELECT id FROM contract_templates WHERE country_id = $1 OR country_id IS NULL
      ORDER BY (country_id IS NULL), version DESC LIMIT 1`, [countryId])).rows[0] ?? null;
}

/** Called when a booking is created: records the template version it is made under (none if no template exists yet). */
export async function attachContract(c: Executor, bookingId: string, countryId: string) {
  const t = await currentTemplate(c, countryId);
  if (t) await c.query('INSERT INTO booking_contracts (booking_id, template_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [bookingId, t.id]);
}

const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
const loc = (v: unknown, lang: Lang) => (v && typeof v === 'object' ? String((v as Record<string, string>)[lang] ?? (v as Record<string, string>).ar ?? (v as Record<string, string>).en ?? '') : String(v ?? ''));

/** The contract of a booking as HTML, filled only from the booking's frozen snapshot and the recorded template version. */
export async function contractHtml(c: Executor, bookingId: string, lang: Lang): Promise<string | null> {
  const r = (await c.query(
    `SELECT t.title, t.body, t.version, b.number, b.created_at, b.start_at, b.end_at, b.guests, b.total, b.currency_code, b.upfront_amount, b.balance_due_at,
            b.instalment_plan, b.service_title, b.package_name, b.cancellation_policy, b.terms_snapshot, b.country_id, co.timezone,
            u.full_name AS customer_name, u.phone AS customer_phone, p.business_name AS provider_name
       FROM booking_contracts bc JOIN contract_templates t ON t.id = bc.template_id JOIN bookings b ON b.id = bc.booking_id
       JOIN countries co ON co.id = b.country_id JOIN users u ON u.id = b.customer_id JOIN providers p ON p.id = b.provider_id
      WHERE bc.booking_id = $1`, [bookingId])).rows[0];
  if (!r) return null;
  const locale = lang === 'ar' ? 'ar' : 'en-GB';
  const when = (d: Date | null, time = true) => (d ? new Date(d).toLocaleString(locale, { timeZone: r.timezone, dateStyle: 'long', ...(time ? { timeStyle: 'short' } : {}) }) : '');
  const cur = String(r.currency_code).trim();
  const plan = (r.instalment_plan ?? []) as { seq: number; amount: string; dueAt: string }[];
  const policy = r.cancellation_policy as { description?: unknown; tiers?: { hoursBefore: number; refundPercentOfPaid: number }[] } | null;
  const tiers = (policy?.tiers ?? []).map((t) => (lang === 'ar'
    ? `الإلغاء قبل ${t.hoursBefore} ساعة أو أكثر: استرداد ${t.refundPercentOfPaid}% من المدفوع`
    : `Cancelling ${t.hoursBefore}+ hours ahead: ${t.refundPercentOfPaid}% of the amount paid is refunded`));
  const values: Record<string, string> = {
    platformName: loc(await getSetting(c, 'documents.platform_name', r.country_id), lang),
    bookingNumber: r.number, bookingDate: when(r.created_at, false), customerName: r.customer_name ?? '', customerPhone: r.customer_phone ?? '',
    providerName: r.provider_name, service: loc(r.service_title, lang), package: r.package_name ? loc(r.package_name, lang) : '',
    startAt: when(r.start_at), endAt: when(r.end_at), guests: r.guests ? String(r.guests) : '', total: `${r.total} ${cur}`, currency: cur,
    upfrontAmount: `${r.upfront_amount} ${cur}`, balanceDueAt: when(r.balance_due_at, false),
    instalments: plan.map((i) => `${lang === 'ar' ? 'القسط' : 'Instalment'} ${i.seq}: ${i.amount} ${cur} — ${when(new Date(i.dueAt), false)}`).join('\n'),
    cancellationPolicy: [policy?.description ? loc(policy.description, lang) : '', ...tiers].filter(Boolean).join('\n'),
    serviceTerms: loc(r.terms_snapshot?.service, lang), packageTerms: loc(r.terms_snapshot?.package, lang),
  };
  const fill = (text: string) => esc(text).replace(/\{\{\s*([a-zA-Z]+)\s*\}\}/g, (_, k: string) => esc(values[k] ?? '').replace(/\n/g, '<br>'));
  const paragraphs = loc(r.body, lang).split(/\n{2,}/).map((p) => `<p>${fill(p).replace(/\n/g, '<br>')}</p>`).join('\n');
  const dir = lang === 'ar' ? 'rtl' : 'ltr';
  return `<!doctype html><html lang="${lang}" dir="${dir}"><head><meta charset="utf-8"><title>${fill(loc(r.title, lang))} ${esc(r.number)}</title>
<style>${embeddedFontCss()}body{font-family:'Plex Arabic',system-ui,sans-serif;margin:28px;color:#111;line-height:1.8;font-size:14px}
h1{font-size:20px;margin:0 0 4px}.meta{color:#555;font-size:12px;margin-bottom:18px}.sign{display:flex;gap:48px;margin-top:40px}
.sign div{flex:1;border-top:1px solid #999;padding-top:6px;font-size:12px;color:#555}@media print{body{margin:0}}</style></head>
<body><h1>${fill(loc(r.title, lang))}</h1><div class="meta">${esc(values.platformName)} · ${esc(r.number)} · v${r.version}</div>
${paragraphs}
<div class="sign"><div>${lang === 'ar' ? 'العميل' : 'Customer'}: ${esc(values.customerName)}</div><div>${lang === 'ar' ? 'صاحب الخدمة' : 'Provider'}: ${esc(values.providerName)}</div></div>
</body></html>`;
}

export async function contractRoutes(app: App, deps: Deps) {
  const { db } = deps;
  const auth = { onRequest: deps.authenticate };
  const view = z.object({ format: z.enum(['html', 'pdf']).default('html'), lang: z.enum(['ar', 'en']).default('ar') });

  /** The booking's customer, its provider, or staff who can view bookings in its country. */
  async function access(req: FastifyRequest, bookingId: string) {
    const u = requireUser(req);
    const b = (await db.query<{ country_id: string; customer_id: string; provider_user: string }>(
      'SELECT b.country_id, b.customer_id, p.user_id AS provider_user FROM bookings b JOIN providers p ON p.id = b.provider_id WHERE b.id = $1', [bookingId])).rows[0];
    const ok = b && (u.kind === 'staff' ? can(u, 'bookings.view', b.country_id) : u.kind === 'customer' ? b.customer_id === u.id : b.provider_user === u.id);
    if (!ok) throw notFound();
  }

  app.get('/bookings/:id/contract', { ...auth, schema: { tags: ['documents'], security: sec, params: idParams, querystring: view } }, async (req, reply) => {
    await access(req, req.params.id);
    const html = await contractHtml(db, req.params.id, req.query.lang);
    if (!html) throw notFound();
    if (req.query.format === 'pdf') {
      const number = (await db.query<{ number: string }>('SELECT number FROM bookings WHERE id = $1', [req.params.id])).rows[0]!.number;
      return reply.header('content-type', 'application/pdf').header('content-disposition', `inline; filename="contract-${number}.pdf"`)
        .header('cache-control', 'private, no-store').send(await htmlToPdf(html));
    }
    return reply.header('content-type', 'text/html; charset=utf-8').header('cache-control', 'private, no-store').send(html);
  });

  app.get('/admin/contract-templates', { ...auth, preValidation: requirePermission('content.manage'), schema: { tags: ['documents'], security: sec } }, async () => ({
    placeholders: PLACEHOLDERS,
    templates: (await db.query(
      `SELECT t.id, t.country_id AS "countryId", co.code AS "countryCode", t.version, t.title, t.body, t.created_at AS "createdAt",
              u.full_name AS "createdBy", (SELECT count(*)::int FROM booking_contracts bc WHERE bc.template_id = t.id) AS "bookings"
         FROM contract_templates t LEFT JOIN countries co ON co.id = t.country_id JOIN users u ON u.id = t.created_by
        ORDER BY co.code NULLS FIRST, t.version DESC`)).rows,
  }));

  /** Saving always adds a new version; bookings already made keep theirs. */
  app.post('/admin/contract-templates', {
    ...auth, preValidation: requirePermission('content.manage'), schema: { tags: ['documents'], security: sec, body: templateBody },
  }, async (req, reply) => {
    const b = req.body;
    assertCan(requireUser(req), 'content.manage', b.countryId);
    const bad = [...unknownPlaceholders(Object.values(b.body).join('\n')), ...unknownPlaceholders(Object.values(b.title).join('\n'))];
    if (bad.length) throw badRequest('VALIDATION_FAILED', [{ path: '/body', message: `unknown placeholders: ${[...new Set(bad)].join(', ')}` }]);
    const row = await withTx(db, async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`contract:${b.countryId ?? 'all'}`]);
      const version = Number((await c.query<{ v: string }>(
        'SELECT coalesce(max(version), 0) + 1 AS v FROM contract_templates WHERE country_id IS NOT DISTINCT FROM $1', [b.countryId])).rows[0]!.v);
      const t = (await c.query<{ id: string }>(
        'INSERT INTO contract_templates (country_id, version, title, body, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id',
        [b.countryId, version, JSON.stringify(b.title), JSON.stringify(b.body), requireUser(req).id])).rows[0]!;
      await audit(c, actorOf(req), { action: 'contract_template.created', entityType: 'contract_template', entityId: t.id, after: { countryId: b.countryId, version }, reason: b.reason });
      return { id: t.id, version };
    });
    return reply.status(201).send(row);
  });
}
