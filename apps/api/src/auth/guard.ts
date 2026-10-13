import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db/pool.js';
import { forbidden, unauthorized } from '../lib/errors.js';
import type { ActorContext } from '../lib/audit.js';
import type { TokenService } from '../lib/tokens.js';
import type { Permission } from './permissions.js';

export interface AuthUser {
  id: string;
  kind: 'customer' | 'provider' | 'staff';
  preferredLanguage: string;
  /** permission -> country ids it applies to; '*' means every country. */
  grants: Map<string, Set<string>>;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser | null;
  }
}

export async function loadAuthUser(db: Db, userId: string): Promise<AuthUser | null> {
  const { rows } = await db.query<{ id: string; kind: AuthUser['kind']; preferred_language: string; status: string }>(
    'SELECT id, kind, preferred_language, status FROM users WHERE id = $1',
    [userId],
  );
  const u = rows[0];
  if (!u || u.status !== 'active') return null;
  const grants = new Map<string, Set<string>>();
  if (u.kind === 'staff') {
    const perms = await db.query<{ permission_code: string; country_id: string | null }>(
      `SELECT rp.permission_code, ur.country_id
         FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id
        WHERE ur.user_id = $1`,
      [userId],
    );
    for (const p of perms.rows) {
      const set = grants.get(p.permission_code) ?? new Set<string>();
      set.add(p.country_id ?? '*');
      grants.set(p.permission_code, set);
    }
  }
  return { id: u.id, kind: u.kind, preferredLanguage: u.preferred_language, grants };
}

export function makeAuthenticate(db: Db, tokens: TokenService) {
  return async function authenticate(req: FastifyRequest): Promise<void> {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw unauthorized();
    let sub: string;
    try {
      sub = (await tokens.verifyAccess(header.slice(7))).sub;
    } catch {
      throw unauthorized('AUTH_INVALID_TOKEN');
    }
    const user = await loadAuthUser(db, sub);
    if (!user) throw unauthorized('AUTH_INVALID_TOKEN');
    req.user = user;
  };
}

export function requireUser(req: FastifyRequest): AuthUser {
  if (!req.user) throw unauthorized();
  return req.user;
}

/** True if the user holds the permission globally, or for the given country. */
export function can(user: AuthUser, perm: Permission, countryId?: string | null): boolean {
  const scope = user.grants.get(perm);
  if (!scope) return false;
  if (scope.has('*')) return true;
  return countryId ? scope.has(countryId) : false;
}

export function assertCan(user: AuthUser, perm: Permission, countryId?: string | null): void {
  if (!can(user, perm, countryId)) throw forbidden();
}

/**
 * Countries the user may act on for a permission: null = all countries, [] = none.
 * Used to scope list queries.
 */
export function countryScope(user: AuthUser, perm: Permission): string[] | null {
  const scope = user.grants.get(perm);
  if (!scope) return [];
  if (scope.has('*')) return null;
  return [...scope];
}

/** preHandler: staff user holding `perm` in at least one scope (fine-grained country checks happen in handlers). */
export function requirePermission(perm: Permission) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    const user = requireUser(req);
    if (user.kind !== 'staff' || !user.grants.has(perm)) throw forbidden();
  };
}

export function requireKind(...kinds: AuthUser['kind'][]) {
  return async (req: FastifyRequest) => {
    const user = requireUser(req);
    if (!kinds.includes(user.kind)) throw forbidden();
  };
}

export function actorOf(req: FastifyRequest): ActorContext {
  return {
    actorId: req.user?.id ?? null,
    actorKind: req.user?.kind ?? 'anonymous',
    ip: req.ip ?? null,
    requestId: String(req.id),
  };
}
