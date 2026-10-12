import { beforeAll, describe, expect, it } from 'vitest';
import { withTx } from '../src/db/pool.js';
import { confirmHold, peakUsage, releaseExpiredHolds, reserve, type ReserveInput } from '../src/modules/availability/engine.js';
import { api, approvedProvider, createStaff, PNG, setupCountry, uniq, upload, useApp } from './helpers.js';

const ctx = useApp();
let admin: { token: string };
let supervisor: { token: string };
let country: { id: string; code: string };
let categoryId: string;

// Riyadh is UTC+3 with no DST: local midnight of 2027-03-01 is 2027-02-28T21:00Z.
const MON = '2027-03-01';
const TUE = '2027-03-02';
const day = (d: string) => ({ start: new Date(`${d}T00:00:00+03:00`), end: new Date(new Date(`${d}T00:00:00+03:00`).getTime() + 86_400_000) });
const at = (d: string, hhmm: string) => new Date(`${d}T${hhmm}:00+03:00`);

async function createType(over: Record<string, unknown>) {
  const res = await api(ctx, 'POST', '/v1/admin/service-types', {
    token: admin.token,
    body: { categoryId, code: `t_${uniq()}`.slice(0, 40), name: { en: 'T' }, pricingUnits: ['fixed', 'per_day'], minImages: 1, ...over },
  });
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  return res.body.id as string;
}

async function publish(typeId: string, extra: Record<string, unknown> = {}) {
  const p = await approvedProvider(ctx, supervisor.token, country.code);
  await api(ctx, 'PUT', `/v1/admin/providers/${p.providerId}/service-types`, { token: admin.token, body: { serviceTypeIds: [typeId] } });
  const s = await api(ctx, 'POST', '/v1/provider/services', {
    token: p.token,
    body: { serviceTypeId: typeId, title: { en: 'Service' }, description: { en: 'Desc' }, city: 'Riyadh', basePrice: '1000', currency: 'SAR', pricingUnit: 'fixed', ...extra },
  });
  if (s.status !== 201) throw new Error(JSON.stringify(s.body));
  await upload(ctx, `/v1/provider/services/${s.body.id}/media`, p.token, PNG);
  return { p, serviceId: s.body.id as string };
}

async function goLive(p: { token: string }, serviceId: string) {
  await api(ctx, 'POST', `/v1/provider/services/${serviceId}/submit`, { token: p.token });
  const r = await api(ctx, 'POST', `/v1/admin/services/${serviceId}/actions`, { token: supervisor.token, body: { action: 'publish' } });
  if (r.status !== 200) throw new Error(JSON.stringify(r.body));
}

const hold = (input: Omit<ReserveInput, 'kind' | 'enforceSchedule' | 'actorId'>) =>
  withTx(ctx.db, (c) => reserve(c, { ...input, kind: 'hold', enforceSchedule: true, actorId: null }));
const errCode = (p: Promise<unknown>) => p.then(() => 'OK', (e: { code?: string }) => e.code);

let hallType: string;
let slotType: string;
let rentalType: string;

beforeAll(async () => {
  admin = await createStaff(ctx, [{ code: 'system_admin' }]);
  country = await setupCountry(ctx, admin.token);
  supervisor = await createStaff(ctx, [{ code: 'services_supervisor', countryId: country.id }]);
  categoryId = (await api(ctx, 'POST', '/v1/admin/categories', { token: admin.token, body: { slug: `c-${uniq()}`, name: { en: 'C' }, countryIds: [country.id] } })).body.id;
  hallType = await createType({ bookingMode: 'full_day' });
  slotType = await createType({ bookingMode: 'time_slot', defaultDurationMinutes: 120, bufferAfterMinutes: 30, pricingUnits: ['fixed'] });
  rentalType = await createType({ bookingMode: 'quantity_rental', pricingUnits: ['per_day'], minImages: 0 });
});

describe('peak usage', () => {
  it('counts only truly simultaneous intervals and treats touching ranges as free', () => {
    const iv = (s: number, e: number, units = 1) => ({ start: s, end: e, units });
    expect(peakUsage([iv(0, 10), iv(20, 30)], 0, 30)).toBe(1);
    expect(peakUsage([iv(0, 10), iv(5, 15), iv(8, 9)], 0, 30)).toBe(3);
    expect(peakUsage([iv(0, 10)], 10, 20)).toBe(0);
    expect(peakUsage([iv(0, 10, 2), iv(10, 20, 2)], 0, 20)).toBe(2);
  });
});

describe('external bookings (test 11, clause 27)', () => {
  it('blocks the date for customers without exposing private details', async () => {
    const { p, serviceId } = await publish(hallType);
    await goLive(p, serviceId);
    const b = await api(ctx, 'POST', `/v1/provider/services/${serviceId}/blocks`, {
      token: p.token, body: { kind: 'external', ...iso(day(MON)), reason: 'Booked by phone', internalNotes: 'Family Al-Example, paid cash' },
    });
    expect(b.status).toBe(201);

    const av = await api(ctx, 'GET', `/v1/services/${serviceId}/availability?from=${MON}&to=${TUE}`);
    expect(av.body.days.map((d: { date: string; available: boolean }) => [d.date, d.available])).toEqual([[MON, false], [TUE, true]]);
    expect(JSON.stringify(av.body)).not.toMatch(/Al-Example|phone|external/);

    expect(await errCode(hold({ serviceId, ...day(MON) }))).toBe('SLOT_UNAVAILABLE');
    expect(await errCode(hold({ serviceId, ...day(TUE) }))).toBe('OK');

    const cal = await api(ctx, 'GET', `/v1/provider/calendar?from=${MON}&to=${TUE}`, { token: p.token });
    expect(cal.body.map((x: { kind: string }) => x.kind).sort()).toEqual(['external', 'hold']);
    expect(cal.body.find((x: { kind: string }) => x.kind === 'external').internalNotes).toBe('Family Al-Example, paid cash');

    // Search by date hides the fully booked day.
    const search = async (d: string) => (await api(ctx, 'GET', `/v1/services?country=${country.code}&date=${d}`)).body.items.map((s: { id: string }) => s.id);
    expect(await search(MON)).not.toContain(serviceId);
    expect(await search('2027-03-03')).toContain(serviceId);

    // Releasing the external booking frees the day; the release is audited.
    await api(ctx, 'DELETE', `/v1/provider/blocks/${b.body.id}`, { token: p.token, body: { reason: 'Customer cancelled offline' } });
    expect(await errCode(hold({ serviceId, ...day(MON) }))).toBe('OK');
    const a = await ctx.db.query(`SELECT reason FROM audit_log WHERE entity_id = $1 AND action = 'calendar.block_released'`, [b.body.id]);
    expect(a.rows[0].reason).toBe('Customer cancelled offline');
  });

  it('cannot be used on another provider\'s service and cannot release a booking', async () => {
    const { p, serviceId } = await publish(hallType);
    await goLive(p, serviceId);
    const other = await approvedProvider(ctx, supervisor.token, country.code);
    expect((await api(ctx, 'POST', `/v1/provider/services/${serviceId}/blocks`, { token: other.token, body: { kind: 'closed', ...iso(day(MON)), reason: 'x x' } })).status).toBe(404);
    const h = await hold({ serviceId, ...day(MON) });
    expect((await api(ctx, 'DELETE', `/v1/provider/blocks/${h.id}`, { token: p.token, body: { reason: 'try to free' } })).body.error.code).toBe('BLOCK_NOT_RELEASABLE');
  });
});

describe('conflict prevention (test 10, clause 28)', () => {
  it('lets exactly one of many simultaneous requests win the same slot', async () => {
    const { p, serviceId } = await publish(hallType);
    await goLive(p, serviceId);
    const results = await Promise.all(Array.from({ length: 10 }, () => errCode(hold({ serviceId, ...day(MON) }))));
    expect(results.filter((r) => r === 'OK')).toHaveLength(1);
    expect(results.filter((r) => r === 'SLOT_UNAVAILABLE')).toHaveLength(9);
  });

  it('enforces exclusivity in the database even if application checks are bypassed', async () => {
    const { p, serviceId } = await publish(hallType);
    await goLive(p, serviceId);
    await hold({ serviceId, ...day(MON) });
    await expect(ctx.db.query(
      `INSERT INTO calendar_blocks (service_id, kind, period, blocked_period, exclusive)
       VALUES ($1, 'external', tstzrange($2, $3), tstzrange($2, $3), true)`, [serviceId, at(MON, '10:00'), at(MON, '12:00')],
    )).rejects.toThrow(/calendar_blocks_no_overlap/);
  });

  it('respects concurrent capacity', async () => {
    const { p, serviceId } = await publish(hallType, { maxConcurrentBookings: 2 });
    await goLive(p, serviceId);
    expect(await errCode(hold({ serviceId, ...day(MON) }))).toBe('OK');
    expect(await errCode(hold({ serviceId, ...day(MON) }))).toBe('OK');
    expect(await errCode(hold({ serviceId, ...day(MON) }))).toBe('SLOT_UNAVAILABLE');
  });

  it('validates the period shape and bookability', async () => {
    const { p, serviceId } = await publish(hallType);
    expect(await errCode(hold({ serviceId, ...day(MON) }))).toBe('SERVICE_NOT_BOOKABLE'); // not published yet
    await goLive(p, serviceId);
    expect(await errCode(hold({ serviceId, start: at(MON, '10:00'), end: at(TUE, '10:00') }))).toBe('PERIOD_INVALID');
    expect(await errCode(hold({ serviceId, start: day(MON).start, end: day('2027-03-03').start }))).toBe('PERIOD_INVALID'); // full_day = 1 day
    expect(await errCode(hold({ serviceId, ...day('2020-01-01') }))).toBe('PERIOD_IN_PAST');
    expect(await errCode(hold({ serviceId, start: day(TUE).start, end: day(MON).start }))).toBe('PERIOD_INVALID');
  });
});

describe('time slots, opening hours and buffers', () => {
  it('offers slots on the grid inside opening hours and applies the cleanup buffer', async () => {
    const { p, serviceId } = await publish(slotType, { slotStepMinutes: 60 });
    await goLive(p, serviceId);
    const rules = await api(ctx, 'PUT', `/v1/provider/services/${serviceId}/availability-rules`, { token: p.token, body: { rules: [{ weekday: 1, start: '09:00', end: '17:00' }] } });
    expect(rules.status).toBe(200);
    expect((await api(ctx, 'PUT', `/v1/provider/services/${serviceId}/availability-rules`, { token: p.token, body: { rules: [{ weekday: 1, start: '09:00', end: '13:00' }, { weekday: 1, start: '12:00', end: '15:00' }] } })).body.error.code).toBe('RULES_OVERLAP');

    expect(await errCode(hold({ serviceId, start: at(MON, '10:00'), end: at(MON, '12:00') }))).toBe('OK');
    expect(await errCode(hold({ serviceId, start: at(MON, '08:00'), end: at(MON, '10:00') }))).toBe('OUTSIDE_SCHEDULE');
    expect(await errCode(hold({ serviceId, start: at(MON, '09:30'), end: at(MON, '11:30') }))).toBe('OUTSIDE_SCHEDULE');
    expect(await errCode(hold({ serviceId, start: at(MON, '16:00'), end: at(MON, '18:00') }))).toBe('OUTSIDE_SCHEDULE');
    expect(await errCode(hold({ serviceId, start: at(TUE, '10:00'), end: at(TUE, '12:00') }))).toBe('OUTSIDE_SCHEDULE'); // closed on Tuesday
    // 12:00 collides with the 30-minute cleanup after the 10:00-12:00 booking.
    expect(await errCode(hold({ serviceId, start: at(MON, '12:00'), end: at(MON, '14:00') }))).toBe('SLOT_UNAVAILABLE');
    const avail = async () => (await api(ctx, 'GET', `/v1/services/${serviceId}/availability?from=${MON}&to=${TUE}`)).body.days;
    const [mon, tue] = await avail();
    expect(tue).toMatchObject({ open: false, available: false });
    const slot = (h: string) => mon.slots.find((s: { start: string }) => s.start === at(MON, h).toISOString());
    expect(mon.slots).toHaveLength(7); // 09:00 ... 15:00 starts, 2h each
    expect(slot('09:00').available).toBe(false);
    expect(slot('12:00').available).toBe(false);
    expect(slot('13:00').available).toBe(true);

    expect(await errCode(hold({ serviceId, start: at(MON, '13:00'), end: at(MON, '15:00') }))).toBe('OK');
    // 15:00 now collides with the cleanup after 13:00-15:00: the day is full.
    const [monAfter] = await avail();
    expect(monAfter.available).toBe(false);
  });
});

describe('temporary holds (test 9, clause 32)', () => {
  it('lasts the configured minutes, measured by database time', async () => {
    const { p, serviceId } = await publish(hallType);
    await goLive(p, serviceId);
    const h = await hold({ serviceId, ...day(MON) });
    const r = (await ctx.db.query(`SELECT extract(epoch FROM expires_at - created_at)::int AS secs FROM calendar_blocks WHERE id = $1`, [h.id])).rows[0];
    expect(r.secs).toBe(15 * 60);
    await api(ctx, 'PUT', '/v1/admin/settings/booking.hold_minutes', { token: admin.token, body: { scope: 'country', countryId: country.id, value: 7, reason: 'Faster turnover' } });
    try {
      const h2 = await hold({ serviceId, ...day(TUE) });
      expect((await ctx.db.query(`SELECT extract(epoch FROM expires_at - created_at)::int AS secs FROM calendar_blocks WHERE id = $1`, [h2.id])).rows[0].secs).toBe(7 * 60);
    } finally {
      await api(ctx, 'PUT', '/v1/admin/settings/booking.hold_minutes', { token: admin.token, body: { scope: 'country', countryId: country.id, value: 15, reason: 'Restore' } });
    }
  });

  it('frees the slot once expired, and the job releases and audits it', async () => {
    const { p, serviceId } = await publish(hallType);
    await goLive(p, serviceId);
    const h = await hold({ serviceId, ...day(MON) });
    expect(await errCode(hold({ serviceId, ...day(MON) }))).toBe('SLOT_UNAVAILABLE');
    await ctx.db.query(`UPDATE calendar_blocks SET expires_at = now() - interval '1 second', created_at = created_at - interval '16 minutes' WHERE id = $1`, [h.id]);

    // Availability already treats it as free before the job runs.
    const av = await api(ctx, 'GET', `/v1/services/${serviceId}/availability?from=${MON}&to=${MON}`);
    expect(av.body.days[0].available).toBe(true);

    expect(await releaseExpiredHolds(ctx.db)).toBeGreaterThanOrEqual(1);
    expect((await ctx.db.query('SELECT status, release_reason FROM calendar_blocks WHERE id = $1', [h.id])).rows[0]).toEqual({ status: 'released', release_reason: 'expired' });
    const a = await ctx.db.query(`SELECT after FROM audit_log WHERE action = 'calendar.holds_expired' ORDER BY id DESC LIMIT 1`);
    expect(a.rows[0].after.blockIds).toContain(h.id);
    expect(await errCode(hold({ serviceId, ...day(MON) }))).toBe('OK');
  });

  it('confirms a live hold in place, and re-checks an expired one', async () => {
    const { p, serviceId } = await publish(hallType);
    await goLive(p, serviceId);
    // Engine-level test: no booking row exists, so no booking reference is attached.
    const ref = () => null;

    const live = await hold({ serviceId, ...day(MON) });
    const confirmed = await withTx(ctx.db, (c) => confirmHold(c, live.id, ref(), null));
    expect(confirmed.id).toBe(live.id);
    expect((await ctx.db.query('SELECT kind, expires_at FROM calendar_blocks WHERE id = $1', [live.id])).rows[0]).toEqual({ kind: 'booking', expires_at: null });

    // Expired hold whose slot is still free: a new booking block is created after re-checking.
    const stale = await hold({ serviceId, ...day(TUE) });
    await ctx.db.query(`UPDATE calendar_blocks SET expires_at = now() - interval '1 second' WHERE id = $1`, [stale.id]);
    const rebooked = await withTx(ctx.db, (c) => confirmHold(c, stale.id, ref(), null));
    expect(rebooked.id).not.toBe(stale.id);

    // Expired hold whose slot was taken meanwhile: confirmation fails.
    const lost = await hold({ serviceId, ...day('2027-03-03') });
    await ctx.db.query(`UPDATE calendar_blocks SET expires_at = now() - interval '1 second' WHERE id = $1`, [lost.id]);
    await hold({ serviceId, ...day('2027-03-03') });
    expect(await errCode(withTx(ctx.db, (c) => confirmHold(c, lost.id, ref(), null)))).toBe('SLOT_UNAVAILABLE');
  });
});

describe('rentable stock (clause 23)', () => {
  it('never rents more units than exist for overlapping periods', async () => {
    const { p, serviceId } = await publish(rentalType, { pricingUnit: 'per_day' });
    const item = (n: string) => ({ sku: n, name: { en: n }, quantityTotal: 2, pricePerDay: '500', currency: 'SAR' });
    const dress = (await api(ctx, 'POST', `/v1/provider/services/${serviceId}/rental-items`, { token: p.token, body: item('D-38') })).body.id;
    const suit = (await api(ctx, 'POST', `/v1/provider/services/${serviceId}/rental-items`, { token: p.token, body: item('S-50') })).body.id;
    await goLive(p, serviceId);

    const twoDays = { start: day(MON).start, end: day('2027-03-03').start };
    expect(await errCode(hold({ serviceId, ...day(MON) }))).toBe('RENTAL_ITEM_REQUIRED');
    expect(await errCode(hold({ serviceId, rentalItemId: dress, ...twoDays }))).toBe('OK');
    expect(await errCode(hold({ serviceId, rentalItemId: dress, ...day(TUE) }))).toBe('OK');
    expect(await errCode(hold({ serviceId, rentalItemId: dress, ...day(TUE) }))).toBe('SLOT_UNAVAILABLE');
    expect(await errCode(hold({ serviceId, rentalItemId: dress, ...day('2027-03-03') }))).toBe('OK'); // the 2-day rental has returned
    expect(await errCode(hold({ serviceId, rentalItemId: suit, ...day(TUE) }))).toBe('OK');

    // A service-wide closure blocks every item.
    await api(ctx, 'POST', `/v1/provider/services/${serviceId}/blocks`, { token: p.token, body: { kind: 'closed', ...iso(day('2027-03-05')), reason: 'Inventory day' } });
    expect(await errCode(hold({ serviceId, rentalItemId: suit, ...day('2027-03-05') }))).toBe('SLOT_UNAVAILABLE');

    const av = await api(ctx, 'GET', `/v1/services/${serviceId}/availability?from=${MON}&to=2027-03-05&rentalItemId=${dress}`);
    expect(av.body.days.map((d: { available: boolean }) => d.available)).toEqual([true, false, true, true, false]);
  });
});

describe('central calendar (clause 26)', () => {
  it('shows staff the blocks in their country, filtered by kind', async () => {
    const { p, serviceId } = await publish(hallType);
    await goLive(p, serviceId);
    await hold({ serviceId, ...day(MON) });
    const ext = await api(ctx, 'POST', `/v1/admin/services/${serviceId}/blocks`, { token: admin.token, body: { kind: 'closed', ...iso(day(TUE)), reason: 'Maintenance' } });
    expect(ext.status).toBe(201);
    const agent = await createStaff(ctx, [{ code: 'bookings_agent', countryId: country.id }]);
    const cal = await api(ctx, 'GET', `/v1/admin/calendar?from=${MON}&to=${TUE}&serviceId=${serviceId}`, { token: agent.token });
    expect(cal.body.map((b: { kind: string }) => b.kind)).toEqual(['hold', 'closed']);
    expect((await api(ctx, 'GET', `/v1/admin/calendar?from=${MON}&to=${TUE}&serviceId=${serviceId}&kinds=closed`, { token: agent.token })).body).toHaveLength(1);

    const other = await setupCountry(ctx, admin.token, '+971');
    const foreign = await createStaff(ctx, [{ code: 'bookings_agent', countryId: other.id }]);
    expect((await api(ctx, 'GET', `/v1/admin/calendar?from=${MON}&to=${TUE}&serviceId=${serviceId}`, { token: foreign.token })).body).toEqual([]);
    expect((await api(ctx, 'POST', `/v1/admin/services/${serviceId}/blocks`, { token: foreign.token, body: { kind: 'closed', ...iso(day('2027-03-03')), reason: 'Not mine' } })).status).toBe(403);
    expect((await api(ctx, 'GET', `/v1/admin/calendar?from=2027-01-01&to=2027-12-31`, { token: agent.token })).body.error.code).toBe('PERIOD_INVALID');
  });
});

function iso(p: { start: Date; end: Date }) {
  return { start: p.start.toISOString(), end: p.end.toISOString() };
}
