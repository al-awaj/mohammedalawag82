import type { Executor } from '../../db/pool.js';
import { badRequest, conflict } from '../../lib/errors.js';
import { fromUnits, min, mulDiv, percentOf, roundToMinor, toUnits } from '../../lib/money.js';

export interface DiscountItem { key: string; serviceId: string; serviceTypeId: string; providerId: string; countryId: string; currency: string; total: string; customerId: string }
export interface ItemDiscount { amount: bigint; platformBorne: bigint; providerBorne: bigint }

interface PromoRow {
  id: string; code: string; discount_type: 'percent' | 'fixed'; discount_value: string; currency_code: string | null; max_discount: string | null;
  min_booking_total: string | null; starts_at: Date; ends_at: Date; usage_limit_total: number | null; usage_limit_per_customer: number | null;
  country_id: string | null; service_type_ids: string[] | null; service_ids: string[] | null; provider_id: string | null;
  cost_bearer: 'platform' | 'provider' | 'shared'; provider_share_percent: string | null; is_active: boolean; now: Date;
}

/** Splits `total` over items in proportion to their weights; the last item takes the rounding remainder. */
function allocate(total: bigint, weights: bigint[], minor: number): bigint[] {
  const sumW = weights.reduce((s, w) => s + w, 0n);
  let left = total;
  return weights.map((w, i) => {
    if (i === weights.length - 1) return left;
    const share = roundToMinor(mulDiv(total, w, sumW), minor);
    left -= share;
    return share;
  });
}

/**
 * Validates a coupon for the given items and computes the discount of each item and who bears it
 * (clause 55). Locks the promotion row so usage limits hold under concurrent checkouts.
 */
export async function evaluateCoupon(c: Executor, code: string, items: DiscountItem[], lock: boolean): Promise<{ promotionId: string; byItem: Map<string, ItemDiscount>; total: bigint }> {
  const p = (await c.query<PromoRow>(`SELECT *, now() AS now FROM promotions WHERE code = $1 ${lock ? 'FOR UPDATE' : ''}`, [code.toUpperCase()])).rows[0];
  if (!p || !p.is_active || p.now < p.starts_at || p.now >= p.ends_at) throw badRequest('COUPON_INVALID');
  const customerId = items[0]?.customerId;
  const used = (await c.query<{ total: number; mine: number }>(
    `SELECT count(DISTINCT order_id)::int AS total, count(DISTINCT order_id) FILTER (WHERE customer_id = $2)::int AS mine
       FROM promotion_redemptions WHERE promotion_id = $1 AND status = 'active'`, [p.id, customerId])).rows[0]!;
  if ((p.usage_limit_total && used.total >= p.usage_limit_total) || (p.usage_limit_per_customer && used.mine >= p.usage_limit_per_customer)) throw conflict('COUPON_LIMIT_REACHED');

  const eligible = items.filter((i) =>
    (!p.country_id || p.country_id === i.countryId) &&
    (!p.service_ids?.length || p.service_ids.includes(i.serviceId)) &&
    (!p.service_type_ids?.length || p.service_type_ids.includes(i.serviceTypeId)) &&
    (!p.provider_id || p.provider_id === i.providerId) &&
    (p.discount_type === 'percent' || p.currency_code?.trim() === i.currency));
  if (!eligible.length) throw badRequest('COUPON_INVALID', { reason: 'no eligible item' });
  const currency = eligible[0]!.currency;
  const minor = (await c.query<{ m: number }>('SELECT minor_units AS m FROM currencies WHERE code = $1', [currency])).rows[0]!.m;
  const base = eligible.reduce((s, i) => s + toUnits(i.total), 0n);
  if (p.min_booking_total && base < toUnits(p.min_booking_total)) throw badRequest('COUPON_INVALID', { reason: 'minimum total not reached', minimum: p.min_booking_total });

  let amounts = p.discount_type === 'percent'
    ? eligible.map((i) => roundToMinor(percentOf(toUnits(i.total), p.discount_value), minor))
    : allocate(min(toUnits(p.discount_value), base), eligible.map((i) => toUnits(i.total)), minor);
  const sumAmounts = amounts.reduce((s, a) => s + a, 0n);
  if (p.max_discount && sumAmounts > toUnits(p.max_discount)) amounts = allocate(toUnits(p.max_discount), amounts, minor);

  const byItem = new Map<string, ItemDiscount>();
  eligible.forEach((i, idx) => {
    const amount = min(amounts[idx]!, toUnits(i.total));
    const providerBorne = p.cost_bearer === 'provider' ? amount : p.cost_bearer === 'platform' ? 0n : roundToMinor(percentOf(amount, p.provider_share_percent!), minor);
    byItem.set(i.key, { amount, providerBorne, platformBorne: amount - providerBorne });
  });
  return { promotionId: p.id, byItem, total: [...byItem.values()].reduce((s, d) => s + d.amount, 0n) };
}

export function describe(d: ItemDiscount) {
  return { discount: fromUnits(d.amount), platformBorne: fromUnits(d.platformBorne), providerBorne: fromUnits(d.providerBorne) };
}
