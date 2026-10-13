import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, PDF, upload, useApp } from './helpers.js';
import { marketplace } from './fixtures.js';

/**
 * Object-level access (IDOR): one customer or provider must never reach another's records by
 * guessing or reusing identifiers (test 34).
 */
const ctx = useApp();
let m: Awaited<ReturnType<typeof marketplace>>;
let owner: Awaited<ReturnType<Awaited<ReturnType<typeof marketplace>>['customer']>>;
let stranger: typeof owner;
let ids: { orderId: string; bookingId: string; paymentId: string; disputeId: string; documentId: string; serviceId: string; providerToken: string; otherProviderToken: string; mediaId: string; proofPaymentId: string };

beforeAll(async () => {
  m = await marketplace(ctx, 'PAY_SANDBOX_IDOR_SECRET');
  const h = await m.hall();
  const other = await m.hall();
  owner = await m.customer();
  stranger = await m.customer();
  const o = await m.order(owner.token, h.serviceId);
  const pay = await m.payCard(owner.token, o.id, 'upfront');
  const d = await api(ctx, 'POST', '/v1/disputes', { token: owner.token, body: { bookingId: o.bookings[0]!.id, type: 'billing', subject: 'Charged twice', description: 'I believe the deposit was charged twice.' } });
  const doc = (await ctx.db.query('SELECT id FROM documents WHERE booking_id = $1', [o.bookings[0]!.id])).rows[0].id;
  const media = (await ctx.db.query('SELECT id FROM service_media WHERE service_id = $1', [h.serviceId])).rows[0].id;
  // A bank transfer with a proof, still pending: proofs are private.
  const o2 = await m.order(owner.token, h.serviceId);
  const bt = { body: JSON.parse((await ctx.app.inject({ method: 'POST', url: `/v1/orders/${o2.id}/payments`, headers: { authorization: `Bearer ${owner.token}`, 'idempotency-key': randomUUID() },
    payload: { model: 'platform', method: 'bank_transfer', purpose: 'upfront' } })).body) };
  expect((await upload(ctx, `/v1/payments/${bt.body.id}/proofs`, owner.token, PDF)).status).toBe(201);
  ids = { orderId: o.id, bookingId: o.bookings[0]!.id, paymentId: pay.id, disputeId: d.body.id, documentId: doc, serviceId: h.serviceId,
    providerToken: h.p.token, otherProviderToken: other.p.token, mediaId: media, proofPaymentId: bt.body.id };
});

describe('customers cannot reach each other\'s records', () => {
  it('denies reading and acting on another customer\'s order, booking, payment, dispute and documents', async () => {
    const reads = [
      `/v1/orders/${ids.orderId}`, `/v1/orders/${ids.orderId}/payments`, `/v1/orders/${ids.orderId}/payment-options`,
      `/v1/bookings/${ids.bookingId}`, `/v1/bookings/${ids.bookingId}/cancellation-preview`, `/v1/bookings/${ids.bookingId}/refunds`,
      `/v1/bookings/${ids.bookingId}/statement`, `/v1/bookings/${ids.bookingId}/balance-notice`, `/v1/payments/${ids.paymentId}`,
      `/v1/disputes/${ids.disputeId}`, `/v1/disputes/${ids.disputeId}/record`, `/v1/documents/${ids.documentId}`,
    ];
    for (const url of reads) {
      expect([403, 404], url).toContain((await api(ctx, 'GET', url, { token: stranger.token })).status);
      expect((await api(ctx, 'GET', url, { token: owner.token })).status, `owner ${url}`).toBe(200);
    }
    const writes: [string, object][] = [
      [`/v1/bookings/${ids.bookingId}/cancel`, { reason: 'Not mine to cancel' }],
      [`/v1/orders/${ids.orderId}/payments`, { model: 'platform', method: 'card', purpose: 'balance' }],
      [`/v1/payments/${ids.paymentId}/cancel`, {}],
      [`/v1/disputes/${ids.disputeId}/statements`, { note: 'Injected statement' }],
      [`/v1/bookings/${ids.bookingId}/review`, { rating: 1 }],
    ];
    for (const [url, body] of writes) {
      const r = await ctx.app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${stranger.token}`, 'idempotency-key': randomUUID() }, payload: body });
      expect([403, 404, 409], url).toContain(r.statusCode);
    }
    // Nothing changed for the owner.
    expect((await api(ctx, 'GET', `/v1/bookings/${ids.bookingId}`, { token: owner.token })).body.status).toBe('confirmed');
    expect((await ctx.db.query('SELECT count(*)::int AS n FROM dispute_events WHERE note = $1', ['Injected statement'])).rows[0].n).toBe(0);
  });

  it('keeps lists scoped to their owner', async () => {
    expect((await api(ctx, 'GET', '/v1/bookings?when=all', { token: stranger.token })).body).toEqual([]);
    expect((await api(ctx, 'GET', '/v1/documents', { token: stranger.token })).body).toEqual([]);
    expect((await api(ctx, 'GET', '/v1/disputes', { token: stranger.token })).body).toEqual([]);
    expect((await api(ctx, 'GET', '/v1/me/payment-history', { token: stranger.token })).body.payments).toEqual([]);
  });

  it('keeps payment proofs private to the payer and finance staff', async () => {
    const proof = (await ctx.db.query('SELECT id FROM payment_proofs WHERE payment_id = $1', [ids.proofPaymentId])).rows[0].id;
    const url = `/v1/admin/payments/${ids.proofPaymentId}/proofs/${proof}`;
    expect((await ctx.app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${stranger.token}` } })).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${m.financeA.token}` } })).statusCode).toBe(200);
  });
});

describe('providers cannot reach each other\'s records', () => {
  it('denies another provider\'s booking, service, media and calendar', async () => {
    const t = ids.otherProviderToken;
    expect((await api(ctx, 'GET', `/v1/provider/bookings/${ids.bookingId}`, { token: t })).status).toBe(404);
    for (const a of ['accept', 'start', 'complete', 'no-show']) expect([404, 409]).toContain((await api(ctx, 'POST', `/v1/provider/bookings/${ids.bookingId}/${a}`, { token: t })).status);
    expect((await api(ctx, 'POST', `/v1/provider/bookings/${ids.bookingId}/cancel`, { token: t, body: { reason: 'Not mine' } })).status).toBe(404);
    expect((await api(ctx, 'GET', `/v1/provider/services/${ids.serviceId}`, { token: t })).status).toBe(404);
    expect((await api(ctx, 'PATCH', `/v1/provider/services/${ids.serviceId}`, { token: t, body: { basePrice: '1' } })).status).toBe(404);
    expect((await api(ctx, 'DELETE', `/v1/provider/media/${ids.mediaId}`, { token: t })).status).toBe(404);
    expect((await api(ctx, 'POST', `/v1/provider/services/${ids.serviceId}/blocks`, { token: t, body: { kind: 'closed', start: '2029-01-01T00:00:00Z', end: '2029-01-02T00:00:00Z', reason: 'Hijack' } })).status).toBe(404);
    expect((await api(ctx, 'PUT', `/v1/provider/services/${ids.serviceId}/availability-rules`, { token: t, body: { rules: [] } })).status).toBe(404);
    expect((await api(ctx, 'GET', `/v1/documents/${ids.documentId}`, { token: t })).status).toBe(404);
    // The real provider still sees its booking, with the customer's phone only because it is confirmed.
    const own = await api(ctx, 'GET', `/v1/provider/bookings/${ids.bookingId}`, { token: ids.providerToken });
    expect(own.status).toBe(200);
    expect((await api(ctx, 'GET', `/v1/provider/services/${ids.serviceId}`, { token: ids.providerToken })).body.basePrice).toBe('20000.0000');
  });
});

describe('uploads (test 34)', () => {
  it('rejects files whose content is not an allowed type, whatever their name claims', async () => {
    const disguised: [Buffer, string][] = [
      [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'), 'pic.png'],
      [Buffer.from('<html><script>alert(1)</script></html>'), 'pic.jpg'],
      [Buffer.from('MZ\x90\x00\x03\x00\x00\x00'), 'pic.webp'],
      [Buffer.from('#!/bin/sh\nrm -rf /\n'), 'pic.mp4'],
    ];
    for (const [file, name] of disguised) {
      expect((await upload(ctx, `/v1/provider/services/${ids.serviceId}/media`, ids.providerToken, file, {}, name)).status, name).toBe(415);
    }
  });

  it('rejects files above the size limit', async () => {
    const big = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(11 * 1024 * 1024)]);
    expect((await upload(ctx, `/v1/provider/services/${ids.serviceId}/media`, ids.providerToken, big, {}, 'big.png')).status).toBe(413);
  });

  it('serves stored files with their verified type and no sniffing', async () => {
    const r = await ctx.app.inject({ method: 'GET', url: `/v1/media/${ids.mediaId}` });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('image/png');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
  });
});
