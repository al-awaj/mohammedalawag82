import { mkdirSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import autocannon from 'autocannon';
import { beforeAll, describe, expect, it } from 'vitest';
import { useApp } from '../test/helpers.js';
import { marketplace } from '../test/fixtures.js';

/**
 * Load test on production-like volume (test 40): real data created through the API, multiplied in SQL
 * to SERVICES services and SERVICES × BOOKINGS_PER_SERVICE bookings, then sustained HTTP load on the
 * hot read paths with latency budgets. Results go to perf/results.json for the test report.
 */
const ctx = useApp();
const COPIES = Number(process.env.PERF_COPIES ?? 1000);          // clones per real service
const BOOKINGS_PER_SERVICE = Number(process.env.PERF_BOOKINGS ?? 5);
const DURATION = Number(process.env.PERF_DURATION ?? 10);         // seconds per scenario
const CONNECTIONS = Number(process.env.PERF_CONNECTIONS ?? 20);

let m: Awaited<ReturnType<typeof marketplace>>;
let base = '';
let busyDay = '';
let fx: { serviceId: string; customerToken: string; providerToken: string; staffToken: string; countryCode: string; countryId: string };
const volume: Record<string, number> = {};

beforeAll(async () => {
  m = await marketplace(ctx, 'PAY_SANDBOX_PERF_SECRET');
  // Real data through the API: 20 halls, 30 customers, 200 paid bookings (some completed).
  const halls = [];
  for (let i = 0; i < 20; i++) halls.push(await m.hall());
  const customers = [];
  for (let i = 0; i < 30; i++) customers.push(await m.customer());
  let template = '';
  for (let i = 0; i < 200; i++) {
    const h = halls[i % halls.length]!;
    const c = customers[i % customers.length]!;
    const o = await m.order(c.token, h.serviceId);
    await m.payCard(c.token, o.id, 'upfront');
    if (i % 4 === 0) {
      await ctx.db.query(`UPDATE bookings SET start_at = now() - interval '3 hours', end_at = now() - interval '1 hour' WHERE id = $1`, [o.bookings[0]!.id]);
      await ctx.app.inject({ method: 'POST', url: `/v1/provider/bookings/${o.bookings[0]!.id}/complete`, headers: { authorization: `Bearer ${h.p.token}` } });
    } else template = o.bookings[0]!.id;
  }

  // Volume: clone every real service COPIES times (with its media), then give each clone bookings on
  // distinct days with their calendar blocks, spread over the customers.
  // Temp tables live on one connection: seed through a dedicated client.
  const c = await ctx.db.connect();
  await c.query(`CREATE TEMP TABLE smap AS
    SELECT gen_random_uuid() AS nid, s.id AS oid, g FROM services s CROSS JOIN generate_series(1, $2::int) g WHERE s.country_id = $1`, [m.country.id, COPIES]);
  await c.query(`INSERT INTO services SELECT (jsonb_populate_record(NULL::services, to_jsonb(s) || jsonb_build_object(
      'id', x.nid, 'city', (ARRAY['Riyadh','Jeddah','Dammam','Mecca','Medina'])[1 + x.g % 5], 'base_price', 5000 + (x.g * 37) % 50000,
      'title', jsonb_build_object('en', 'Hall ' || x.g, 'ar', 'قاعة ' || x.g)))).*
    FROM smap x JOIN services s ON s.id = x.oid`);
  await c.query(`INSERT INTO service_media SELECT (jsonb_populate_record(NULL::service_media, to_jsonb(md) || jsonb_build_object('id', gen_random_uuid(), 'service_id', x.nid, 'file_key', md.file_key || '.' || x.nid))).*
    FROM smap x JOIN service_media md ON md.service_id = x.oid`);
  const custIds = customers.map((c) => c.userId);
  await c.query(`CREATE TEMP TABLE bmap AS
    SELECT gen_random_uuid() AS bid, gen_random_uuid() AS blk, x.nid AS sid, k, row_number() OVER () AS n,
           ($2::uuid[])[1 + (row_number() OVER ()) % array_length($2::uuid[], 1)] AS cid
      FROM smap x CROSS JOIN generate_series(1, $1::int) k`, [BOOKINGS_PER_SERVICE, custIds]);
  const shift = `make_interval(days => 30 + g.k * 3)`;
  // Blocks and bookings reference each other (deferred foreign key): insert both in one transaction.
  await c.query('BEGIN');
  await c.query(`INSERT INTO calendar_blocks SELECT (jsonb_populate_record(NULL::calendar_blocks, to_jsonb(t) || jsonb_build_object(
      'id', g.blk, 'service_id', g.sid, 'booking_ref', g.bid,
      'period', tstzrange(lower(t.period) + ${shift}, upper(t.period) + ${shift})::text,
      'blocked_period', tstzrange(lower(t.blocked_period) + ${shift}, upper(t.blocked_period) + ${shift})::text))).*
    FROM bmap g CROSS JOIN (SELECT cb.* FROM calendar_blocks cb JOIN bookings b ON b.calendar_block_id = cb.id WHERE b.id = $1) t`, [template]);
  await c.query(`INSERT INTO bookings SELECT (jsonb_populate_record(NULL::bookings, to_jsonb(t) || jsonb_build_object(
      'id', g.bid, 'number', 'BKG-P-' || lpad(g.n::text, 8, '0'), 'service_id', g.sid, 'calendar_block_id', g.blk, 'customer_id', g.cid,
      'start_at', t.start_at + ${shift}, 'end_at', t.end_at + ${shift}))).*
    FROM bmap g CROSS JOIN (SELECT * FROM bookings WHERE id = $1) t`, [template]);
  await c.query('COMMIT');
  c.release();
  await ctx.db.query('ANALYZE');
  // The local day on which every clone has its first booking (k = 1): search must exclude them all.
  busyDay = (await ctx.db.query(`SELECT to_char((b.start_at + interval '33 days') AT TIME ZONE co.timezone, 'YYYY-MM-DD') AS d
    FROM bookings b JOIN countries co ON co.id = b.country_id WHERE b.id = $1`, [template])).rows[0].d;
  for (const t of ['services', 'service_media', 'calendar_blocks', 'bookings', 'payments', 'journal_lines', 'users']) {
    volume[t] = (await ctx.db.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n;
  }

  const h = halls[0]!;
  fx = { serviceId: h.serviceId, customerToken: customers[0]!.token, providerToken: h.p.token, staffToken: m.financeA.token, countryCode: m.country.code, countryId: m.country.id };
  await ctx.app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(ctx.app.server.address() as AddressInfo).port}`;
});

interface Scenario { name: string; path: string; method?: 'GET' | 'POST'; body?: object; token?: () => string; p99Ms: number }

const scenarios = (): Scenario[] => [
  { name: 'search: country page', path: `/v1/services?country=${fx.countryCode}`, p99Ms: 500 },
  { name: 'search: city + text + price sort', path: `/v1/services?country=${fx.countryCode}&city=Jeddah&q=Hall&sort=price_asc&currency=SAR`, p99Ms: 500 },
  { name: 'search: available on a busy date', path: `/v1/services?country=${fx.countryCode}&date=${busyDay}`, p99Ms: 800 },
  { name: 'service detail', path: `/v1/services/${fx.serviceId}`, p99Ms: 300 },
  { name: 'availability: 28 days', path: `/v1/services/${fx.serviceId}/availability?from=2028-02-01&to=2028-02-28`, p99Ms: 400 },
  { name: 'quote', path: '/v1/quote', method: 'POST', body: { serviceId: fx.serviceId, date: '2028-09-09' }, p99Ms: 300 },
  { name: 'customer: my bookings', path: '/v1/bookings?when=all', token: () => fx.customerToken, p99Ms: 400 },
  { name: 'provider: bookings', path: '/v1/provider/bookings?when=all', token: () => fx.providerToken, p99Ms: 400 },
  { name: 'admin: bookings list', path: `/v1/admin/bookings?countryId=${fx.countryId}`, token: () => fx.staffToken, p99Ms: 600 },
  { name: 'admin: revenue report', path: `/v1/admin/reports/revenue?country=${fx.countryId}`, token: () => fx.staffToken, p99Ms: 1000 },
];

describe('performance under load (test 40)', () => {
  it('still answers correctly at volume: a fully booked day excludes the booked services', async () => {
    const all = (await ctx.app.inject({ method: 'GET', url: `/v1/services?country=${fx.countryCode}` })).json();
    const busy = (await ctx.app.inject({ method: 'GET', url: `/v1/services?country=${fx.countryCode}&date=${busyDay}` })).json();
    expect(all.total).toBe(volume.services);
    expect(busy.total).toBe(volume.services! - COPIES * 20);
    expect(all.items).toHaveLength(20);
  });

  it('serves the hot paths within budget on a large dataset, without errors', async () => {
    const results = [];
    for (const s of scenarios()) {
      const r = await autocannon({
        url: `${base}${s.path}`, method: s.method ?? 'GET', duration: DURATION, connections: CONNECTIONS,
        headers: { 'content-type': 'application/json', ...(s.token ? { authorization: `Bearer ${s.token()}` } : {}) },
        ...(s.body ? { body: JSON.stringify(s.body) } : {}),
      });
      results.push({
        name: s.name, requests: r.requests.total, rps: Math.round(r.requests.average), p50: r.latency.p50, p90: r.latency.p90, p99: r.latency.p99,
        max: r.latency.max, errors: r.errors + r.timeouts, non2xx: r.non2xx, budgetP99: s.p99Ms,
      });
    }
    mkdirSync('perf', { recursive: true });
    writeFileSync('perf/results.json', JSON.stringify({ at: new Date().toISOString(), durationSec: DURATION, connections: CONNECTIONS, volume, results }, null, 2));
    console.table(results);
    console.table(volume);
    for (const r of results) {
      expect(r.errors, r.name).toBe(0);
      expect(r.non2xx, r.name).toBe(0);
      expect(r.p99, r.name).toBeLessThanOrEqual(r.budgetP99);
    }
  });
});
