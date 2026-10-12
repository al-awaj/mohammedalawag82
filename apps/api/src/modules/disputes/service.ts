import type { Db, Executor } from '../../db/pool.js';
import type { AuthUser } from '../../auth/guard.js';
import { withTx } from '../../db/pool.js';
import { audit, type ActorContext } from '../../lib/audit.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { fromUnits, toUnits } from '../../lib/money.js';
import { enqueueMessage } from '../../lib/outbox.js';
import { post, systemAccount } from '../finance/ledger.js';
import { refundableFor, requestRefunds } from '../finance/refunds.js';

export type DisputeStatus = 'new' | 'under_review' | 'awaiting_info' | 'awaiting_response' | 'deciding' | 'resolution_approved' | 'rejected' | 'settled' | 'closed';
export type PartyRole = 'customer' | 'provider';

export interface DisputeRow {
  id: string; number: string; kind: 'dispute' | 'complaint'; booking_id: string | null; country_id: string; complainant_id: string;
  complainant_role: PartyRole; respondent_role: PartyRole | null; status: DisputeStatus; disputed_amount: string | null; currency_code: string | null;
  held_amount: string; decision: { outcome: string; refundAmount?: string; chargeTo?: string; rationale: string } | null; assigned_to: string | null;
}

export async function lockDispute(c: Executor, id: string): Promise<DisputeRow> {
  const d = (await c.query<DisputeRow>('SELECT * FROM disputes WHERE id = $1 FOR UPDATE', [id])).rows[0];
  if (!d) throw notFound();
  return d;
}

/** The role a user plays in a dispute (complainant or the other party of the booking), or null. */
export async function partyRole(c: Executor, d: { booking_id: string | null; complainant_id: string; complainant_role: PartyRole; respondent_role: PartyRole | null }, user: AuthUser): Promise<PartyRole | null> {
  if (user.id === d.complainant_id) return d.complainant_role;
  if (!d.booking_id || !d.respondent_role) return null;
  const b = (await c.query<{ customer_id: string; provider_user: string }>(
    'SELECT b.customer_id, p.user_id AS provider_user FROM bookings b JOIN providers p ON p.id = b.provider_id WHERE b.id = $1', [d.booking_id])).rows[0]!;
  if (d.respondent_role === 'customer' && b.customer_id === user.id) return 'customer';
  if (d.respondent_role === 'provider' && b.provider_user === user.id) return 'provider';
  return null;
}

async function event(c: Executor, disputeId: string, ctx: ActorContext & { role: 'customer' | 'provider' | 'staff' | 'system' }, action: string, opts: { from?: string; to?: string; note?: string | null; visibility?: 'internal' | 'parties' | 'author' } = {}) {
  await c.query(
    'INSERT INTO dispute_events (dispute_id, actor_id, actor_role, action, from_status, to_status, note, visibility) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
    [disputeId, ctx.actorId, ctx.role, action, opts.from ?? null, opts.to ?? null, opts.note ?? null, opts.visibility ?? 'internal']);
}

async function setStatus(c: Executor, d: DisputeRow, to: DisputeStatus, ctx: ActorContext & { role: 'customer' | 'provider' | 'staff' | 'system' }, action: string, note: string | null, visibility: 'internal' | 'parties' = 'parties') {
  await c.query('UPDATE disputes SET status = $2 WHERE id = $1', [d.id, to]);
  await event(c, d.id, ctx, action, { from: d.status, to, note, visibility });
  await audit(c, ctx, { action: `dispute.${action}`, entityType: 'dispute', entityId: d.id, before: { status: d.status }, after: { status: to }, reason: note });
  d.status = to;
}

async function partyUsers(c: Executor, d: DisputeRow): Promise<string[]> {
  if (!d.booking_id) return [d.complainant_id];
  const b = (await c.query<{ customer_id: string; provider_user: string }>(
    'SELECT b.customer_id, p.user_id AS provider_user FROM bookings b JOIN providers p ON p.id = b.provider_id WHERE b.id = $1', [d.booking_id])).rows[0]!;
  return [b.customer_id, b.provider_user];
}

async function notifyUsers(c: Executor, userIds: string[], templateKey: string, payload: Record<string, unknown>) {
  for (const id of userIds) {
    const u = (await c.query<{ phone: string | null; email: string | null; preferred_language: string }>('SELECT phone, email, preferred_language FROM users WHERE id = $1', [id])).rows[0];
    const target = u?.phone ?? u?.email;
    if (u && target) await enqueueMessage(c, { channel: u.phone ? 'sms' : 'email', recipientUserId: id, target, templateKey, language: u.preferred_language, payload });
  }
}

const DISPUTABLE: string[] = ['confirmed', 'in_progress', 'completed', 'no_show', 'cancelled_by_customer', 'cancelled_by_provider', 'cancelled_by_admin'];

export interface OpenInput {
  kind: 'dispute' | 'complaint'; bookingId?: string | undefined; type: string; subject: string; description: string; disputedAmount?: string | undefined;
}

/** Customer or provider opens a dispute about a booking, or anyone files a complaint with the administration. */
export async function openDispute(db: Db, user: AuthUser, input: OpenInput, ctx: ActorContext) {
  if (user.kind === 'staff') throw forbidden();
  return withTx(db, async (c) => {
    let bookingId: string | null = null;
    let countryId: string;
    let role: PartyRole = user.kind === 'provider' ? 'provider' : 'customer';
    let respondent: PartyRole | null = null;
    let currency: string | null = null;
    if (input.bookingId) {
      const b = (await c.query<{ id: string; customer_id: string; provider_user: string; country_id: string; status: string; total: string; currency_code: string }>(
        `SELECT b.id, b.customer_id, p.user_id AS provider_user, b.country_id, b.status, b.total, b.currency_code
           FROM bookings b JOIN providers p ON p.id = b.provider_id WHERE b.id = $1`, [input.bookingId])).rows[0];
      if (!b || (b.customer_id !== user.id && b.provider_user !== user.id)) throw notFound();
      role = b.customer_id === user.id ? 'customer' : 'provider';
      if (input.kind === 'dispute' && !DISPUTABLE.includes(b.status)) throw conflict('INVALID_STATUS_TRANSITION', { from: b.status });
      if (input.disputedAmount && toUnits(input.disputedAmount) > toUnits(b.total)) throw badRequest('VALIDATION_FAILED', [{ path: '/disputedAmount', message: 'cannot exceed the booking total' }]);
      bookingId = b.id;
      countryId = b.country_id;
      currency = input.disputedAmount ? b.currency_code.trim() : null;
      respondent = input.kind === 'dispute' ? (role === 'customer' ? 'provider' : 'customer') : null;
    } else {
      if (input.kind === 'dispute') throw badRequest('VALIDATION_FAILED', [{ path: '/bookingId', message: 'a dispute is about a booking' }]);
      if (input.disputedAmount) throw badRequest('VALIDATION_FAILED', [{ path: '/disputedAmount', message: 'only for disputes about a booking' }]);
      countryId = (await c.query<{ country_id: string }>('SELECT country_id FROM users WHERE id = $1', [user.id])).rows[0]!.country_id;
    }
    let d: { id: string; number: string };
    try {
      d = (await c.query<{ id: string; number: string }>(
        `INSERT INTO disputes (kind, booking_id, country_id, complainant_id, complainant_role, respondent_role, type, subject, description, disputed_amount, currency_code)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id, number`,
        [input.kind, input.kind === 'dispute' ? bookingId : bookingId, countryId, user.id, role, respondent, input.type, input.subject, input.description,
          input.disputedAmount ?? null, currency])).rows[0]!;
    } catch (err) {
      if ((err as { constraint?: string }).constraint === 'disputes_one_open_per_booking') throw conflict('DISPUTE_ALREADY_OPEN');
      throw err;
    }
    const actor = { ...ctx, role };
    await event(c, d.id, actor, 'opened', { to: 'new', note: input.description, visibility: input.kind === 'dispute' ? 'parties' : 'author' });
    await audit(c, ctx, { action: 'dispute.opened', entityType: 'dispute', entityId: d.id, after: { number: d.number, kind: input.kind, bookingId, type: input.type, disputedAmount: input.disputedAmount ?? null } });
    const notifyIds = input.kind === 'dispute' ? await partyUsers(c, { booking_id: bookingId, complainant_id: user.id } as DisputeRow) : [user.id];
    await notifyUsers(c, notifyIds, 'dispute.opened', { disputeId: d.id, number: d.number });
    return d;
  });
}

/** A party adds a statement. It is visible to staff and its author only (no direct party-to-party channel, D11). */
export async function addStatement(db: Db, user: AuthUser, disputeId: string, note: string, ctx: ActorContext) {
  return withTx(db, async (c) => {
    const d = await lockDispute(c, disputeId);
    const role = await partyRole(c, d, user);
    if (!role) throw notFound();
    if (['settled', 'closed', 'rejected'].includes(d.status)) throw conflict('INVALID_STATUS_TRANSITION', { from: d.status });
    await event(c, d.id, { ...ctx, role }, 'statement', { note, visibility: 'author' });
    // Answering a request for information or a response puts the case back with the reviewer.
    const requested = (await c.query<{ note: string | null }>(
      `SELECT note FROM dispute_events WHERE dispute_id = $1 AND action IN ('info_requested', 'response_requested') ORDER BY created_at DESC LIMIT 1`, [d.id])).rows[0];
    if (['awaiting_info', 'awaiting_response'].includes(d.status) && requested) {
      await setStatus(c, d, 'under_review', { ...ctx, role }, 'answered', null, 'internal');
    }
    return { status: d.status };
  });
}

type StaffCtx = ActorContext & { role: 'staff' };

export async function staffAction(db: Db, disputeId: string, action: 'start_review' | 'request_info' | 'request_response' | 'note' | 'to_decision' | 'assign' | 'close',
  opts: { note?: string | undefined; from?: PartyRole | undefined; assignee?: string | undefined }, ctx: ActorContext) {
  const sctx: StaffCtx = { ...ctx, role: 'staff' };
  return withTx(db, async (c) => {
    const d = await lockDispute(c, disputeId);
    const need = (from: DisputeStatus[]) => { if (!from.includes(d.status)) throw conflict('INVALID_STATUS_TRANSITION', { from: d.status, action }); };
    const open: DisputeStatus[] = ['new', 'under_review', 'awaiting_info', 'awaiting_response', 'deciding'];
    switch (action) {
      case 'assign': {
        need(open);
        const staff = (await c.query('SELECT 1 FROM users WHERE id = $1 AND kind = $2 AND status = $3', [opts.assignee, 'staff', 'active'])).rowCount;
        if (!staff) throw badRequest('INVALID_REFERENCE', { field: 'assignee' });
        await c.query('UPDATE disputes SET assigned_to = $2 WHERE id = $1', [d.id, opts.assignee]);
        await event(c, d.id, sctx, 'assigned', { note: opts.assignee ?? null });
        break;
      }
      case 'start_review': need(['new']); await setStatus(c, d, 'under_review', sctx, 'review_started', null); break;
      case 'request_info':
      case 'request_response': {
        need(['new', 'under_review', 'deciding']);
        if (!opts.note) throw badRequest('REASON_REQUIRED');
        const target: PartyRole = action === 'request_info' ? (opts.from ?? d.complainant_role) : (d.respondent_role ?? d.complainant_role);
        await setStatus(c, d, action === 'request_info' ? 'awaiting_info' : 'awaiting_response', sctx, action === 'request_info' ? 'info_requested' : 'response_requested', opts.note);
        const users = await partyUsers(c, d);
        const userFor = d.booking_id ? (target === 'customer' ? users[0]! : users[1]!) : d.complainant_id;
        await notifyUsers(c, [userFor], 'dispute.info_requested', { disputeId: d.id, number: d.number, note: opts.note });
        break;
      }
      case 'note': if (!opts.note) throw badRequest('REASON_REQUIRED'); await event(c, d.id, sctx, 'internal_note', { note: opts.note }); break;
      case 'to_decision': need(['under_review', 'awaiting_info', 'awaiting_response']); await setStatus(c, d, 'deciding', sctx, 'decision_pending', opts.note ?? null, 'internal'); break;
      case 'close': {
        need(['settled', 'rejected']);
        await c.query('UPDATE disputes SET closed_at = now() WHERE id = $1', [d.id]);
        await setStatus(c, d, 'closed', sctx, 'closed', opts.note ?? null);
        await notifyUsers(c, await partyUsers(c, d), 'dispute.closed', { disputeId: d.id, number: d.number });
        break;
      }
    }
    return { status: d.status };
  });
}

/** Whether the booking's revenue was already recognised (service completed or booking closed). */
async function recognised(c: Executor, bookingId: string): Promise<boolean> {
  const r = await c.query(`SELECT 1 FROM journal_entries WHERE idempotency_key IN ($1, $2)`, [`booking_completion:${bookingId}`, `booking_closure:${bookingId}`]);
  return Boolean(r.rowCount);
}

/**
 * Holds only the disputed amount of this booking's earning (clause 51: never all of the provider's money).
 * Moves it from due to on-hold payables so settlements skip it.
 */
export async function holdEarning(db: Db, disputeId: string, amount: string, ctx: ActorContext) {
  return withTx(db, async (c) => {
    const d = await lockDispute(c, disputeId);
    if (!d.booking_id || !['new', 'under_review', 'awaiting_info', 'awaiting_response', 'deciding'].includes(d.status)) throw conflict('INVALID_STATUS_TRANSITION', { from: d.status });
    if (toUnits(d.held_amount) > 0n) throw conflict('INVALID_STATUS_TRANSITION', { reason: 'already held' });
    const e = (await c.query<{ id: string; status: string; net_amount: string; provider_id: string; country_id: string; currency_code: string }>(
      'SELECT * FROM provider_earnings WHERE booking_id = $1 FOR UPDATE', [d.booking_id])).rows[0];
    if (!e || !['due', 'settlement_failed', 're_reviewed'].includes(e.status)) throw conflict('NOTHING_TO_HOLD', { earningStatus: e?.status ?? null });
    const settled = toUnits((await c.query<{ v: string }>(`SELECT coalesce(sum(amount), 0)::text AS v FROM settlement_items WHERE earning_id = $1 AND status = 'paid'`, [e.id])).rows[0]!.v);
    const remaining = toUnits(e.net_amount) - settled;
    const want = toUnits(amount);
    const cap = d.disputed_amount ? toUnits(d.disputed_amount) : remaining;
    if (want <= 0n || want > remaining || want > cap) throw badRequest('VALIDATION_FAILED', [{ path: '/amount', message: `must be > 0 and <= ${fromUnits(remaining < cap ? remaining : cap)}` }]);
    const cur = e.currency_code.trim();
    await post(c, {
      countryId: e.country_id, description: `Dispute hold ${d.number}`, sourceType: 'dispute_hold', sourceId: d.id, idempotencyKey: `dispute_hold:${d.id}`, createdBy: ctx.actorId,
      lines: [
        { accountId: await systemAccount(c, e.country_id, cur, 'provider_payable_due'), debit: amount, currency: cur, bookingId: d.booking_id, providerId: e.provider_id },
        { accountId: await systemAccount(c, e.country_id, cur, 'provider_payable_on_hold'), credit: amount, currency: cur, bookingId: d.booking_id, providerId: e.provider_id },
      ],
    });
    await c.query('UPDATE disputes SET held_amount = $2 WHERE id = $1', [d.id, amount]);
    await c.query(`UPDATE provider_earnings SET status = 'on_hold_dispute', status_reason = $2 WHERE id = $1`, [e.id, `held by ${d.number}`]);
    await c.query(`INSERT INTO provider_earning_events (earning_id, from_status, to_status, actor_id, reason) VALUES ($1, $2, 'on_hold_dispute', $3, $4)`, [e.id, e.status, ctx.actorId, d.number]);
    await event(c, d.id, { ...ctx, role: 'staff' }, 'earning_held', { note: amount });
    await audit(c, ctx, { action: 'dispute.earning_held', entityType: 'dispute', entityId: d.id, after: { amount } });
    return { heldAmount: amount };
  });
}

async function releaseHold(c: Executor, d: DisputeRow, ctx: ActorContext) {
  if (!d.booking_id || toUnits(d.held_amount) === 0n) return;
  const e = (await c.query<{ id: string; status: string; provider_id: string; country_id: string; currency_code: string }>(
    'SELECT * FROM provider_earnings WHERE booking_id = $1 FOR UPDATE', [d.booking_id])).rows[0]!;
  const cur = e.currency_code.trim();
  await post(c, {
    countryId: e.country_id, description: `Dispute hold released ${d.number}`, sourceType: 'dispute_release', sourceId: d.id, idempotencyKey: `dispute_release:${d.id}`, createdBy: ctx.actorId,
    lines: [
      { accountId: await systemAccount(c, e.country_id, cur, 'provider_payable_on_hold'), debit: d.held_amount, currency: cur, bookingId: d.booking_id, providerId: e.provider_id },
      { accountId: await systemAccount(c, e.country_id, cur, 'provider_payable_due'), credit: d.held_amount, currency: cur, bookingId: d.booking_id, providerId: e.provider_id },
    ],
  });
  await c.query('UPDATE disputes SET held_amount = 0 WHERE id = $1', [d.id]);
  if (e.status === 'on_hold_dispute') {
    await c.query(`UPDATE provider_earnings SET status = 'due', status_reason = $2 WHERE id = $1`, [e.id, `released by ${d.number}`]);
    await c.query(`INSERT INTO provider_earning_events (earning_id, from_status, to_status, actor_id, reason) VALUES ($1, 'on_hold_dispute', 'due', $2, $3)`, [e.id, ctx.actorId, d.number]);
  }
  await event(c, d.id, { ...ctx, role: 'staff' }, 'hold_released', { note: d.held_amount });
}

export interface DecisionInput { outcome: 'approve' | 'reject'; rationale: string; refundAmount?: string | undefined; chargeTo?: 'provider' | 'platform' | undefined }

/**
 * Documented decision (clause 51): who decided, why, and its financial effect. Validated now,
 * executed by `settleDispute` through the normal, approved refund process.
 */
export async function decideDispute(db: Db, disputeId: string, input: DecisionInput, ctx: ActorContext) {
  return withTx(db, async (c) => {
    const d = await lockDispute(c, disputeId);
    if (d.status !== 'deciding') throw conflict('INVALID_STATUS_TRANSITION', { from: d.status });
    const sctx = { ...ctx, role: 'staff' as const };
    if (input.outcome === 'reject') {
      await c.query('UPDATE disputes SET decision = $2, decided_by = $3, decided_at = now() WHERE id = $1', [d.id, JSON.stringify({ outcome: 'reject', rationale: input.rationale }), ctx.actorId]);
      await releaseHold(c, d, ctx);
      await setStatus(c, d, 'rejected', sctx, 'rejected', input.rationale);
      await notifyUsers(c, await partyUsers(c, d), 'dispute.decided', { disputeId: d.id, number: d.number, note: input.rationale });
      return { status: d.status };
    }
    const refund = input.refundAmount ? toUnits(input.refundAmount) : 0n;
    if (refund > 0n) {
      if (!d.booking_id) throw badRequest('VALIDATION_FAILED', [{ path: '/refundAmount', message: 'refunds need a booking' }]);
      const r = await refundableFor(c, d.booking_id);
      if (refund > r.available) throw badRequest('REFUND_EXCEEDS_REFUNDABLE', { refundable: fromUnits(r.available) });
      if (await recognised(c, d.booking_id)) {
        if (!input.chargeTo) throw badRequest('VALIDATION_FAILED', [{ path: '/chargeTo', message: 'who bears the refund (provider or platform) is required after the service' }]);
        if (input.chargeTo === 'platform') {
          const commission = toUnits((await c.query<{ v: string }>('SELECT coalesce(commission_amount, 0)::text AS v FROM provider_earnings WHERE booking_id = $1', [d.booking_id])).rows[0]?.v ?? '0');
          // The platform can give back at most its own revenue on this booking; anything else needs a separately approved policy.
          if (refund > commission) throw badRequest('VALIDATION_FAILED', [{ path: '/refundAmount', message: `platform can bear at most its commission (${fromUnits(commission)})` }]);
        }
      }
    }
    const decision = { outcome: 'approve', rationale: input.rationale, refundAmount: fromUnits(refund), chargeTo: input.chargeTo ?? null };
    await c.query('UPDATE disputes SET decision = $2, decided_by = $3, decided_at = now() WHERE id = $1', [d.id, JSON.stringify(decision), ctx.actorId]);
    await setStatus(c, d, 'resolution_approved', sctx, 'resolution_approved', input.rationale);
    await notifyUsers(c, await partyUsers(c, d), 'dispute.decided', { disputeId: d.id, number: d.number, note: input.rationale });
    return { status: d.status, decision };
  });
}

/** Executes an approved resolution: releases the hold and requests the decided refund (approved by another staff member). */
export async function settleDispute(db: Db, disputeId: string, ctx: ActorContext) {
  return withTx(db, async (c) => {
    const d = await lockDispute(c, disputeId);
    if (d.status !== 'resolution_approved' || !d.decision) throw conflict('INVALID_STATUS_TRANSITION', { from: d.status });
    await releaseHold(c, d, ctx);
    let refundIds: string[] = [];
    if (d.booking_id && d.decision.refundAmount && toUnits(d.decision.refundAmount) > 0n) {
      const isRecognised = await recognised(c, d.booking_id);
      refundIds = await requestRefunds(c, d.booking_id, d.decision.refundAmount, 'dispute', `${d.number}: ${d.decision.rationale}`, ctx);
      await c.query('UPDATE refunds SET dispute_id = $2, charge_to = $3 WHERE id = ANY($1)',
        [refundIds, d.id, isRecognised ? d.decision.chargeTo : 'customer_advances']);
    }
    await setStatus(c, d, 'settled', { ...ctx, role: 'staff' }, 'settled', refundIds.length ? `refunds requested: ${refundIds.length}` : 'no financial action');
    return { status: d.status, refundIds };
  });
}
