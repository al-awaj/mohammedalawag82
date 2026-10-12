import type { Executor } from '../db/pool.js';

export interface ActorContext {
  actorId: string | null;
  actorKind: 'customer' | 'provider' | 'staff' | 'system' | 'anonymous';
  ip: string | null;
  requestId: string | null;
}

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
}

const SECRET_KEYS = /password|token|secret|code_hash|payout/i;

/** Removes secrets before they reach the audit log. */
function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, SECRET_KEYS.test(k) ? '[REDACTED]' : redact(v)]),
    );
  }
  return value;
}

/** Writes an audit row on the caller's executor so it commits or rolls back with the change. */
export async function audit(exec: Executor, ctx: ActorContext, entry: AuditEntry): Promise<void> {
  await exec.query(
    `INSERT INTO audit_log (actor_id, actor_kind, action, entity_type, entity_id, before, after, reason, ip, request_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      ctx.actorId,
      ctx.actorKind,
      entry.action,
      entry.entityType,
      entry.entityId ?? null,
      entry.before === undefined ? null : JSON.stringify(redact(entry.before)),
      entry.after === undefined ? null : JSON.stringify(redact(entry.after)),
      entry.reason ?? null,
      ctx.ip,
      ctx.requestId,
    ],
  );
}

export const systemActor: ActorContext = { actorId: null, actorKind: 'system', ip: null, requestId: null };
