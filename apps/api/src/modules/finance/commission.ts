import type { Executor } from '../../db/pool.js';
import { fromUnits, percentOf, roundToMinor, toUnits, min } from '../../lib/money.js';

/**
 * Picks the commission rule for a booking: the most specific scope wins
 * (service > provider > service type > country > global), then priority, then the newest.
 * Only rules active and valid at `at`, and fixed rules in the booking currency, qualify.
 */
export async function computeCommission(c: Executor, b: { bookingId: string; serviceId: string; providerId: string; serviceTypeId: string; countryId: string; total: string; currency: string }, at: Date) {
  const rule = (await c.query<{ id: string; rate_type: 'percent' | 'fixed'; rate_value: string }>(
    `SELECT id, rate_type, rate_value FROM commission_rules
      WHERE is_active AND valid_from <= $1 AND (valid_to IS NULL OR valid_to > $1)
        AND (rate_type = 'percent' OR currency_code = $6)
        AND (scope = 'global'
          OR (scope = 'country' AND country_id = $2)
          OR (scope = 'service_type' AND service_type_id = $3 AND (country_id IS NULL OR country_id = $2))
          OR (scope = 'provider' AND provider_id = $4)
          OR (scope = 'service' AND service_id = $5))
      ORDER BY CASE scope WHEN 'service' THEN 5 WHEN 'provider' THEN 4 WHEN 'service_type' THEN 3 WHEN 'country' THEN 2 ELSE 1 END DESC,
               priority DESC, valid_from DESC
      LIMIT 1`,
    [at, b.countryId, b.serviceTypeId, b.providerId, b.serviceId, b.currency])).rows[0];
  const minor = (await c.query<{ m: number }>('SELECT minor_units AS m FROM currencies WHERE code = $1', [b.currency])).rows[0]!.m;
  const total = toUnits(b.total);
  const amount = !rule ? 0n
    : rule.rate_type === 'percent' ? roundToMinor(percentOf(total, rule.rate_value), minor)
    : min(roundToMinor(toUnits(rule.rate_value), minor), total);
  await c.query(
    `INSERT INTO booking_commissions (booking_id, rule_id, rate_type, rate_value, base_amount, commission_amount, currency_code)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [b.bookingId, rule?.id ?? null, rule?.rate_type ?? null, rule?.rate_value ?? null, b.total, fromUnits(amount), b.currency]);
  return { ruleId: rule?.id ?? null, amount: fromUnits(amount) };
}
