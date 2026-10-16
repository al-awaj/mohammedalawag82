import { beforeAll, describe, expect, it } from 'vitest';
import { api, createStaff, setupCountry, useApp } from './helpers.js';
import { marketplace } from './fixtures.js';

/** Organising an occasion: linking cart items and existing bookings to events, budget, staff view (clauses 7, 24-25). */
const ctx = useApp();
let m: Awaited<ReturnType<typeof marketplace>>;
let hall: { serviceId: string };

beforeAll(async () => {
  m = await marketplace(ctx, 'PAY_SANDBOX_EVENTS_SECRET');
  hall = await m.hall();
});

const newEvent = (token: string, body: object = {}) => api(ctx, 'POST', '/v1/events', { token, body: {
  name: 'Our wedding', eventType: 'wedding', countryCode: m.country.code, city: 'Riyadh', eventDate: '2028-03-01', ...body } });

describe('linking services to an event', () => {
  it('links a cart item before checkout and an existing booking afterwards, and keeps the budget per currency', async () => {
    const c = await m.customer();
    const ev = (await newEvent(c.token, { budgetAmount: '30000', budgetCurrency: 'SAR', expectedGuests: 200 })).body.id as string;

    // Cart item linked after it was added.
    await api(ctx, 'POST', '/v1/cart/items', { token: c.token, body: { serviceId: hall.serviceId, date: m.nextDate() } });
    const item = (await api(ctx, 'GET', '/v1/cart', { token: c.token })).body.items[0];
    expect((await api(ctx, 'PATCH', `/v1/cart/items/${item.id}`, { token: c.token, body: { eventId: ev } })).status).toBe(200);
    expect((await api(ctx, 'GET', '/v1/cart', { token: c.token })).body.items[0].eventId).toBe(ev);
    const o1 = await m.order(c.token, hall.serviceId); // a second, unlinked booking in its own order
    await m.payCard(c.token, o1.id, 'upfront');
    const cart = await api(ctx, 'GET', '/v1/cart', { token: c.token });
    expect(cart.body.items).toEqual([]); // the first item went through with the second checkout

    let e = (await api(ctx, 'GET', `/v1/events/${ev}`, { token: c.token })).body;
    expect(e.bookings).toHaveLength(1);

    // Existing booking linked afterwards: both now count, and the 30,000 budget is exceeded by 40,000.
    const unlinked = (await api(ctx, 'GET', '/v1/bookings?when=all', { token: c.token })).body.find((b: { eventId: string | null }) => !b.eventId);
    const link = await api(ctx, 'PUT', `/v1/bookings/${unlinked.id}/event`, { token: c.token, body: { eventId: ev } });
    expect(link.status).toBe(200);
    e = (await api(ctx, 'GET', `/v1/events/${ev}`, { token: c.token })).body;
    expect(e.bookings).toHaveLength(2);
    expect(e.budget).toMatchObject({ amount: '30000.0000', currency: 'SAR' });
    const n = (await ctx.db.query(`SELECT count(*)::int AS n FROM message_outbox WHERE recipient_user_id = $1 AND template_key = 'event.budget_exceeded'`, [c.userId])).rows[0].n;
    expect(n).toBeGreaterThanOrEqual(1);
    const audited = (await ctx.db.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'booking.event_linked' AND entity_id = $1`, [unlinked.id])).rows[0].n;
    expect(audited).toBe(1);

    // Unlinking only changes the grouping; the booking itself is untouched.
    const before = (await api(ctx, 'GET', `/v1/bookings/${unlinked.id}`, { token: c.token })).body;
    expect((await api(ctx, 'PUT', `/v1/bookings/${unlinked.id}/event`, { token: c.token, body: { eventId: null } })).status).toBe(200);
    const after = (await api(ctx, 'GET', `/v1/bookings/${unlinked.id}`, { token: c.token })).body;
    expect({ ...after, eventId: undefined }).toEqual({ ...before, eventId: undefined });
    expect(after.eventId).toBeNull();
    expect((await api(ctx, 'GET', `/v1/events/${ev}`, { token: c.token })).body.bookings).toHaveLength(1);
  });

  it('refuses another customer\'s events and bookings, and cancelled events', async () => {
    const a = await m.customer();
    const b = await m.customer();
    const evA = (await newEvent(a.token)).body.id as string;
    const o = await m.order(b.token, hall.serviceId);
    const bookingB = o.bookings[0]!.id;
    // B cannot attach their booking to A's event, nor A touch B's booking.
    expect((await api(ctx, 'PUT', `/v1/bookings/${bookingB}/event`, { token: b.token, body: { eventId: evA } })).body.error.code).toBe('EVENT_NOT_FOUND');
    expect((await api(ctx, 'PUT', `/v1/bookings/${bookingB}/event`, { token: a.token, body: { eventId: evA } })).status).toBe(404);
    await api(ctx, 'POST', '/v1/cart/items', { token: b.token, body: { serviceId: hall.serviceId, date: m.nextDate() } });
    const itemB = (await api(ctx, 'GET', '/v1/cart', { token: b.token })).body.items[0].id;
    expect((await api(ctx, 'PATCH', `/v1/cart/items/${itemB}`, { token: a.token, body: { eventId: evA } })).status).toBe(404);
    expect((await api(ctx, 'PATCH', `/v1/cart/items/${itemB}`, { token: b.token, body: { eventId: evA } })).body.error.code).toBe('EVENT_NOT_FOUND');
    // A cancelled event takes no new links.
    const evB = (await newEvent(b.token)).body.id as string;
    await api(ctx, 'PATCH', `/v1/events/${evB}`, { token: b.token, body: { status: 'cancelled' } });
    expect((await api(ctx, 'PUT', `/v1/bookings/${bookingB}/event`, { token: b.token, body: { eventId: evB } })).body.error.code).toBe('EVENT_NOT_FOUND');
  });
});

describe('events for staff', () => {
  it('lists and opens events within the staff member\'s countries only', async () => {
    const c = await m.customer();
    const ev = (await newEvent(c.token, { name: 'Graduation party', eventType: 'graduation' })).body.id as string;
    const agent = await createStaff(ctx, [{ code: 'bookings_agent', countryId: m.country.id }]);
    const list = (await api(ctx, 'GET', '/v1/admin/events?q=Graduation', { token: agent.token })).body;
    expect(list.map((e: { id: string }) => e.id)).toContain(ev);
    const detail = (await api(ctx, 'GET', `/v1/admin/events/${ev}`, { token: agent.token })).body;
    expect(detail).toMatchObject({ id: ev, name: 'Graduation party', customer: { id: c.userId } });

    // Staff of another country see nothing of it.
    const other = await createStaff(ctx, [{ code: 'system_admin' }]);
    const elsewhere = await setupCountry(ctx, other.token);
    const foreign = await createStaff(ctx, [{ code: 'bookings_agent', countryId: elsewhere.id }]);
    expect((await api(ctx, 'GET', `/v1/admin/events/${ev}`, { token: foreign.token })).status).toBe(404);
    expect((await api(ctx, 'GET', '/v1/admin/events?q=Graduation', { token: foreign.token })).body).toEqual([]);
    // Customers have no access to the staff routes.
    expect((await api(ctx, 'GET', '/v1/admin/events', { token: c.token })).status).toBe(403);
  });
});
