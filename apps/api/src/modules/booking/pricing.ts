import { z } from 'zod';
import type { Executor } from '../../db/pool.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { fromUnits, min, mulDiv, percentOf, roundToMinor, sum, toUnits } from '../../lib/money.js';

/** What a customer asks to book. Which period fields apply depends on the service's booking mode. */
export const itemInput = z.object({
  serviceId: z.uuid(),
  packageId: z.uuid().nullable().default(null),
  rentalItemId: z.uuid().nullable().default(null),
  eventId: z.uuid().nullable().default(null),
  date: z.iso.date().optional(),          // full_day
  startDate: z.iso.date().optional(),     // date_range / quantity_rental (inclusive)
  endDate: z.iso.date().optional(),       // date_range / quantity_rental (inclusive)
  startAt: z.iso.datetime({ offset: true }).optional(), // time_slot
  endAt: z.iso.datetime({ offset: true }).optional(),   // time_slot without a fixed duration
  units: z.number().int().min(1).max(10_000).default(1),
  guests: z.number().int().min(1).max(100_000).nullable().default(null),
  addOns: z.array(z.string().regex(/^[a-z0-9_-]{1,50}$/)).max(50).default([]),
  notes: z.string().trim().max(1000).nullable().default(null),
});
export type ItemInput = z.infer<typeof itemInput>;

export interface Quote {
  serviceId: string;
  serviceTypeId: string;
  providerId: string;
  countryId: string;
  packageId: string | null;
  rentalItemId: string | null;
  start: Date;
  end: Date;
  calendarUnits: number;
  units: number;
  guests: number | null;
  currency: string;
  pricingUnit: string;
  unitPrice: string;
  quantityFactor: string;
  addOns: { code: string; name: unknown; price: string }[];
  subtotal: string;
  total: string;
  depositType: 'none' | 'fixed' | 'percent';
  depositValue: string;
  upfrontAmount: string;
  balanceDueAt: Date | null;
  securityDepositAmount: string;
  requiresProviderApproval: boolean;
  serviceTitle: unknown;
  packageName: unknown;
  cancellationPolicy: unknown;
  termsSnapshot: Record<string, unknown>;
  maxBookingsPerSlot: number | null;
}

interface SvcRow {
  id: string; service_type_id: string; provider_id: string; country_id: string; status: string; provider_status: string; title: unknown; terms: unknown;
  base_price: string; currency_code: string; pricing_unit: string; duration_minutes: number | null; capacity: number | null;
  requires_provider_approval: boolean; deposit_type: 'none' | 'fixed' | 'percent'; deposit_value: string; balance_due_days_before: number;
  booking_mode: 'time_slot' | 'full_day' | 'date_range' | 'quantity_rental'; capacity_mode: string; timezone: string;
  cancellation_policy: unknown; type_active: boolean;
}

/**
 * Prices a requested item exactly as it would be booked now. All amounts are decimal strings computed
 * with integer arithmetic and rounded to the currency's minor units. Throws if the item cannot be booked.
 */
export async function quote(exec: Executor, input: ItemInput): Promise<Quote> {
  const s = (await exec.query<SvcRow>(
    `SELECT s.id, s.service_type_id, s.provider_id, s.country_id, s.status, p.status AS provider_status, s.title, s.terms, s.base_price, s.currency_code,
            s.pricing_unit, s.duration_minutes, s.capacity, s.requires_provider_approval, s.deposit_type, s.deposit_value,
            s.balance_due_days_before, t.booking_mode, t.capacity_mode, t.is_active AS type_active, co.timezone,
            CASE WHEN cp.id IS NULL THEN NULL ELSE jsonb_build_object('id', cp.id, 'name', cp.name, 'description', cp.description,
              'tiers', cp.tiers, 'depositRefundable', cp.deposit_refundable, 'selfCancelAllowed', cp.self_cancel_allowed,
              'requiresManualReview', cp.requires_manual_review) END AS cancellation_policy
       FROM services s JOIN service_types t ON t.id = s.service_type_id JOIN providers p ON p.id = s.provider_id
       JOIN countries co ON co.id = s.country_id LEFT JOIN cancellation_policies cp ON cp.id = s.cancellation_policy_id
      WHERE s.id = $1`, [input.serviceId])).rows[0];
  if (!s) throw notFound();
  if (s.status !== 'published' || s.provider_status !== 'active' || !s.type_active) throw conflict('SERVICE_NOT_BOOKABLE');

  const pkg = input.packageId ? (await exec.query<{
    name: unknown; price: string; currency_code: string; pricing_unit: string; duration_minutes: number | null; add_ons: { code: string; name: unknown; price: string }[];
    terms: unknown; available_weekdays: number[]; max_bookings_per_slot: number; deposit_type: 'none' | 'fixed' | 'percent'; deposit_value: string;
    balance_due_days_before: number; valid_from: string | null; valid_to: string | null; status: string;
  }>('SELECT * FROM packages WHERE id = $1 AND service_id = $2', [input.packageId, s.id])).rows[0] : null;
  if (input.packageId && (!pkg || pkg.status !== 'active')) throw conflict('PACKAGE_NOT_AVAILABLE');
  if (!pkg && input.addOns.length) throw badRequest('ADD_ON_INVALID');

  const rental = s.booking_mode === 'quantity_rental';
  const item = input.rentalItemId ? (await exec.query<{ price_per_day: string; currency_code: string; security_deposit: string; status: string; name: unknown; damage_terms: unknown }>(
    'SELECT price_per_day, currency_code, security_deposit, status, name, damage_terms FROM rental_items WHERE id = $1 AND service_id = $2', [input.rentalItemId, s.id])).rows[0] : null;
  if (rental && (!item || item.status !== 'active')) throw badRequest('RENTAL_ITEM_REQUIRED');
  if (!rental && input.rentalItemId) throw badRequest('RENTAL_ITEMS_NOT_ALLOWED');

  // ---- Period, converted from local dates/times by PostgreSQL in the service's timezone.
  const tz = s.timezone;
  const durationMin = pkg?.duration_minutes ?? s.duration_minutes;
  let start: Date;
  let end: Date;
  const localDay = async (d: string, plusDays = 0) =>
    (await exec.query<{ t: Date }>(`SELECT ($1::date + $2::int)::timestamp AT TIME ZONE $3 AS t`, [d, plusDays, tz])).rows[0]!.t;
  if (s.booking_mode === 'time_slot') {
    if (!input.startAt) throw badRequest('PERIOD_INVALID', { reason: 'startAt is required' });
    start = new Date(input.startAt);
    if (durationMin) end = new Date(start.getTime() + durationMin * 60_000);
    else if (input.endAt) end = new Date(input.endAt);
    else throw badRequest('PERIOD_INVALID', { reason: 'endAt is required' });
  } else if (s.booking_mode === 'full_day') {
    if (!input.date) throw badRequest('PERIOD_INVALID', { reason: 'date is required' });
    start = await localDay(input.date);
    end = await localDay(input.date, 1);
  } else {
    if (!input.startDate || !input.endDate || input.endDate < input.startDate) throw badRequest('PERIOD_INVALID', { reason: 'startDate and endDate (inclusive) are required' });
    start = await localDay(input.startDate);
    end = await localDay(input.endDate, 1);
  }
  if (!(end > start)) throw badRequest('PERIOD_INVALID');
  const local = (await exec.query<{ d: string; dow: number }>(
    `SELECT to_char($1::timestamptz AT TIME ZONE $2, 'YYYY-MM-DD') AS d, extract(dow FROM $1::timestamptz AT TIME ZONE $2)::int AS dow`, [start, tz])).rows[0]!;

  if (pkg) {
    if ((pkg.valid_from && local.d < pkg.valid_from) || (pkg.valid_to && local.d > pkg.valid_to)) throw conflict('PACKAGE_NOT_AVAILABLE');
    if (!pkg.available_weekdays.includes(local.dow)) throw conflict('PACKAGE_NOT_AVAILABLE');
  }

  // ---- Quantities.
  const pricingUnit = rental ? 'per_day' : pkg?.pricing_unit ?? s.pricing_unit;
  if (pricingUnit === 'per_person' && !input.guests) throw badRequest('GUESTS_REQUIRED');
  if (s.capacity_mode === 'guests' && input.guests && s.capacity && input.guests > s.capacity) throw badRequest('CAPACITY_EXCEEDED', { capacity: s.capacity });
  if (!rental && pricingUnit !== 'per_unit' && input.units !== 1) throw badRequest('VALIDATION_FAILED', [{ path: '/units', message: 'units only apply to per-unit pricing and rentals' }]);
  const minutes = Math.round((end.getTime() - start.getTime()) / 60_000);
  const days = Math.ceil(minutes / 1440);

  const currency = rental ? item!.currency_code.trim() : (pkg?.currency_code ?? s.currency_code).trim();
  const minor = (await exec.query<{ minor_units: number }>('SELECT minor_units FROM currencies WHERE code = $1', [currency])).rows[0]!.minor_units;
  const unitPrice = toUnits(rental ? item!.price_per_day : pkg?.price ?? s.base_price);

  // factor = num / den, kept rational so hourly prices stay exact.
  let num: bigint;
  let den = 1n;
  switch (pricingUnit) {
    case 'fixed': num = 1n; break;
    case 'per_hour': num = BigInt(minutes); den = 60n; break;
    case 'per_day': num = BigInt(days) * (rental ? BigInt(input.units) : 1n); break;
    case 'per_person': num = BigInt(input.guests!); break;
    case 'per_unit': num = BigInt(input.units); break;
    default: throw badRequest('PRICING_UNIT_NOT_ALLOWED');
  }

  const chosen = [...new Set(input.addOns)].map((code) => {
    const a = pkg?.add_ons.find((x) => x.code === code);
    if (!a) throw badRequest('ADD_ON_INVALID', { code });
    return a;
  });
  const base = roundToMinor(mulDiv(unitPrice, num, den), minor);
  const subtotal = base + sum(chosen.map((a) => roundToMinor(toUnits(a.price), minor)));
  const total = subtotal;

  // ---- Deposit: what secures the booking. No deposit means the full amount is due upfront.
  const depositType = pkg ? pkg.deposit_type : s.deposit_type;
  const depositValue = pkg ? pkg.deposit_value : s.deposit_value;
  const balanceDays = pkg ? pkg.balance_due_days_before : s.balance_due_days_before;
  let upfront = depositType === 'percent' ? roundToMinor(percentOf(total, depositValue), minor)
    : depositType === 'fixed' ? min(roundToMinor(toUnits(depositValue), minor), total)
    : total;
  let balanceDueAt: Date | null = depositType === 'none' ? null : new Date(start.getTime() - balanceDays * 86_400_000);
  const now = (await exec.query<{ now: Date }>('SELECT now() AS now')).rows[0]!.now;
  if (balanceDueAt && balanceDueAt <= now) {
    // The balance would already be due: everything is payable now.
    upfront = total;
    balanceDueAt = null;
  }

  return {
    serviceId: s.id, serviceTypeId: s.service_type_id, providerId: s.provider_id, countryId: s.country_id, packageId: input.packageId, rentalItemId: input.rentalItemId,
    start, end, calendarUnits: rental ? input.units : 1, units: input.units, guests: input.guests, currency, pricingUnit,
    unitPrice: fromUnits(unitPrice), quantityFactor: num % den === 0n ? String(num / den) : (Number(num) / Number(den)).toFixed(6),
    addOns: chosen.map((a) => ({ code: a.code, name: a.name, price: fromUnits(roundToMinor(toUnits(a.price), minor)) })),
    subtotal: fromUnits(subtotal), total: fromUnits(total), depositType, depositValue, upfrontAmount: fromUnits(upfront), balanceDueAt,
    securityDepositAmount: rental ? fromUnits(mulDiv(toUnits(item!.security_deposit), input.units)) : '0.0000',
    requiresProviderApproval: s.requires_provider_approval,
    serviceTitle: s.title, packageName: pkg?.name ?? null, cancellationPolicy: s.cancellation_policy,
    termsSnapshot: { service: s.terms ?? null, package: pkg?.terms ?? null, rentalDamage: item?.damage_terms ?? null },
    maxBookingsPerSlot: pkg?.max_bookings_per_slot ?? null,
  };
}
