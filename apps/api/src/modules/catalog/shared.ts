import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Executor } from '../../db/pool.js';
import { requireUser } from '../../auth/guard.js';
import type { Permission } from '../../auth/permissions.js';
import { AppError, badRequest, forbidden, notFound } from '../../lib/errors.js';
import { i18nTextSchema } from '../common.js';
import type { DataType, FieldDef } from './fields.js';
import { instalmentPlanInput } from '../booking/pricing.js';

export const PRICING_UNITS = ['fixed', 'per_hour', 'per_day', 'per_person', 'per_unit'] as const;
export const moneySchema = z.string().regex(/^\d{1,16}(\.\d{1,4})?$/, 'non-negative decimal string with up to 4 decimals, e.g. "1500.00"');
export const currencyCode = z.string().regex(/^[A-Z]{3}$/);

export const depositFields = {
  depositType: z.enum(['none', 'fixed', 'percent']),
  depositValue: moneySchema,
  balanceDueDaysBefore: z.number().int().min(0).max(365),
  /** Splits the balance into dated instalments (clause 46); needs a deposit, since without one everything is paid upfront. */
  instalmentPlan: instalmentPlanInput.nullable(),
};

/** A plan only applies to the balance after a deposit. */
export function assertPlanShape(depositType: string, plan: unknown[] | null | undefined) {
  if (plan?.length && depositType === 'none') throw badRequest('VALIDATION_FAILED', [{ path: '/instalmentPlan', message: 'an instalment plan needs a deposit' }]);
}

export interface ProviderRow {
  id: string;
  user_id: string;
  country_id: string;
  status: 'active' | 'suspended';
}

/** The provider record behind the signed-in provider account; 404 until the application is approved. */
export async function providerOf(exec: Executor, req: FastifyRequest, opts: { forWrite: boolean }): Promise<ProviderRow> {
  const user = requireUser(req);
  if (user.kind !== 'provider') throw forbidden();
  const p = (await exec.query<ProviderRow>('SELECT id, user_id, country_id, status FROM providers WHERE user_id = $1', [user.id])).rows[0];
  if (!p) throw notFound();
  // Suspended providers keep read access to their data but cannot change or publish anything.
  if (opts.forWrite && p.status !== 'active') throw forbidden('PROVIDER_NOT_ACTIVE');
  return p;
}

export interface TypeRow {
  id: string;
  code: string;
  category_id: string;
  booking_mode: 'time_slot' | 'full_day' | 'date_range' | 'quantity_rental';
  capacity_mode: 'none' | 'guests' | 'units';
  default_requires_approval: boolean;
  default_duration_minutes: number | null;
  pricing_units: string[];
  allows_packages: boolean;
  min_images: number;
  max_images: number;
  allows_video: boolean;
  deposit_required: boolean;
  min_deposit_percent: string | null;
  provider_can_create: boolean;
  is_active: boolean;
}

export async function loadType(exec: Executor, id: string): Promise<TypeRow> {
  const t = (await exec.query<TypeRow>('SELECT * FROM service_types WHERE id = $1', [id])).rows[0];
  if (!t) throw notFound();
  return t;
}

export async function loadFields(exec: Executor, typeId: string): Promise<{ active: FieldDef[]; inactiveKeys: string[] }> {
  const rows = (await exec.query<FieldDef & { is_active: boolean }>(
    'SELECT key, data_type, is_required, validation, options, is_active FROM service_type_fields WHERE service_type_id = $1 ORDER BY sort_order, key',
    [typeId])).rows;
  return {
    active: rows.filter((r) => r.is_active).map((r) => ({ ...r, data_type: r.data_type as DataType })),
    inactiveKeys: rows.filter((r) => !r.is_active).map((r) => r.key),
  };
}

export async function assertCurrencyAllowed(exec: Executor, countryId: string, currency: string): Promise<void> {
  const ok = await exec.query(
    `SELECT 1 FROM country_currencies cc JOIN currencies c ON c.code = cc.currency_code
      WHERE cc.country_id = $1 AND cc.currency_code = $2 AND cc.is_active AND c.is_active`, [countryId, currency]);
  if (!ok.rowCount) throw badRequest('CURRENCY_NOT_ALLOWED');
}

/**
 * Deposit must respect the type's minimum when the type requires one.
 * A fixed deposit is converted to a percentage of the price for the comparison.
 */
export function assertDepositRules(type: TypeRow, deposit: { type: string; value: string }, price: string): void {
  if (!type.deposit_required) return;
  const min = Number(type.min_deposit_percent ?? 0);
  if (deposit.type === 'none') throw badRequest('DEPOSIT_REQUIRED', { minDepositPercent: min });
  const percent = deposit.type === 'percent' ? Number(deposit.value) : Number(price) === 0 ? 100 : (Number(deposit.value) / Number(price)) * 100;
  if (percent + 1e-9 < min) throw badRequest('DEPOSIT_REQUIRED', { minDepositPercent: min });
}

export function assertDepositShape(deposit: { type: string; value: string }, price: string): void {
  const v = Number(deposit.value);
  if (deposit.type === 'none' && v !== 0) throw badRequest('VALIDATION_FAILED', [{ path: '/depositValue', message: 'must be 0 when there is no deposit' }]);
  if (deposit.type === 'percent' && v > 100) throw badRequest('VALIDATION_FAILED', [{ path: '/depositValue', message: 'percent must be <= 100' }]);
  if (deposit.type === 'fixed' && v > Number(price)) throw badRequest('VALIDATION_FAILED', [{ path: '/depositValue', message: 'fixed deposit cannot exceed the price' }]);
}

export const i18nList = z.array(i18nTextSchema).max(50);
export const addOnSchema = z.object({ code: z.string().regex(/^[a-z0-9_-]{1,50}$/), name: i18nTextSchema, price: moneySchema });

export type ServiceStatus = 'draft' | 'pending_review' | 'published' | 'unpublished' | 'suspended';
export type ModerationAction = 'publish' | 'reject' | 'unpublish' | 'suspend' | 'reinstate';

export const MODERATION: Record<ModerationAction, { from: ServiceStatus[]; to: ServiceStatus; perm: Permission; reason: boolean }> = {
  publish: { from: ['pending_review'], to: 'published', perm: 'services.publish', reason: false },
  reject: { from: ['pending_review'], to: 'draft', perm: 'services.publish', reason: true },
  unpublish: { from: ['published'], to: 'unpublished', perm: 'services.unpublish', reason: true },
  suspend: { from: ['draft', 'pending_review', 'published', 'unpublished'], to: 'suspended', perm: 'services.unpublish', reason: true },
  reinstate: { from: ['suspended'], to: 'unpublished', perm: 'services.publish', reason: true },
};

export async function recordServiceStatus(exec: Executor, serviceId: string, from: string | null, to: string, actorId: string, reason: string | null) {
  await exec.query('INSERT INTO service_status_events (service_id, from_status, to_status, actor_id, reason) VALUES ($1, $2, $3, $4, $5)',
    [serviceId, from, to, actorId, reason]);
}

export function conflictStatus(from: string, action: string): AppError {
  return new AppError('INVALID_STATUS_TRANSITION', 409, { from, action });
}
