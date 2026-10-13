import type { Executor } from '../../db/pool.js';
import type { Lang } from '../../lib/i18n.js';
import { getSetting } from '../settings/registry.js';

export type Audience = 'public' | 'owner' | 'staff';

/**
 * Whether the provider's name may be shown publicly: both the platform/country setting
 * and the provider's own flag must allow it (clause 68). Internal records always keep identity.
 */
export async function identityVisible(exec: Executor, countryId: string, providerFlag: boolean): Promise<boolean> {
  return providerFlag && (await getSetting(exec, 'providers.public_identity_visible', countryId));
}

export async function serviceDetail(exec: Executor, id: string, opts: { audience: Audience; lang: Lang }) {
  const s = (await exec.query(
    `SELECT s.id, s.provider_id AS "providerId", s.service_type_id AS "serviceTypeId", s.country_id AS "countryId", co.code AS "countryCode",
            s.city, s.address, s.latitude::float8 AS latitude, s.longitude::float8 AS longitude, s.title, s.description, s.terms,
            s.base_price AS "basePrice", s.currency_code AS currency, s.pricing_unit AS "pricingUnit", s.duration_minutes AS "durationMinutes",
            s.capacity, s.requires_provider_approval AS "requiresProviderApproval", s.deposit_type AS "depositType", s.deposit_value AS "depositValue",
            s.balance_due_days_before AS "balanceDueDaysBefore", s.attributes,
            s.max_concurrent_bookings AS "maxConcurrentBookings", s.slot_step_minutes AS "slotStepMinutes", co.timezone, s.status, s.status_reason AS "statusReason",
            s.published_at AS "publishedAt", s.created_at AS "createdAt", s.updated_at AS "updatedAt",
            t.code AS "typeCode", t.name AS "typeName", t.booking_mode AS "bookingMode", t.capacity_mode AS "capacityMode",
            t.category_id AS "categoryId", t.is_active AS "typeActive",
            p.business_name AS "providerName", p.show_identity AS "providerShowIdentity", p.status AS "providerStatus",
            cp.id AS "policyId", cp.name AS "policyName", cp.description AS "policyDescription", cp.tiers AS "policyTiers",
            cp.deposit_refundable AS "policyDepositRefundable", cp.self_cancel_allowed AS "policySelfCancel",
            cp.requires_manual_review AS "policyManualReview"
       FROM services s JOIN service_types t ON t.id = s.service_type_id JOIN providers p ON p.id = s.provider_id
       JOIN countries co ON co.id = s.country_id LEFT JOIN cancellation_policies cp ON cp.id = s.cancellation_policy_id
      WHERE s.id = $1`, [id])).rows[0];
  if (!s) return null;
  if (opts.audience === 'public' && !(s.status === 'published' && s.providerStatus === 'active' && s.typeActive)) return null;

  const fields = (await exec.query(
    `SELECT key, label, help_text AS "helpText", data_type AS "dataType", options, is_public AS "isPublic", is_active AS "isActive"
       FROM service_type_fields WHERE service_type_id = $1 ORDER BY sort_order, key`, [s.serviceTypeId])).rows;
  // Public pages only show active, public fields — fields that do not apply to the type never appear (clause 19).
  const visible = opts.audience === 'public' ? fields.filter((f) => f.isPublic && f.isActive) : fields;
  const visibleKeys = new Set(visible.map((f) => f.key));
  const attributes = Object.fromEntries(Object.entries(s.attributes as Record<string, unknown>).filter(([k]) => visibleKeys.has(k)));

  const packages = (await exec.query(
    `SELECT id, name, description, price, currency_code AS currency, pricing_unit AS "pricingUnit", duration_minutes AS "durationMinutes",
            inclusions, add_ons AS "addOns", terms, available_weekdays AS "availableWeekdays", max_bookings_per_slot AS "maxBookingsPerSlot",
            deposit_type AS "depositType", deposit_value AS "depositValue", balance_due_days_before AS "balanceDueDaysBefore",
            valid_from AS "validFrom", valid_to AS "validTo", sort_order AS "sortOrder", status
       FROM packages WHERE service_id = $1
        AND ($2 = false OR (status = 'active' AND (valid_from IS NULL OR valid_from <= current_date) AND (valid_to IS NULL OR valid_to >= current_date)))
      ORDER BY sort_order, price`, [id, opts.audience === 'public'])).rows;

  const rentalItems = (await exec.query(
    `SELECT id, sku, name, attributes, quantity_total AS "quantityTotal", condition, price_per_day AS "pricePerDay",
            price_per_period AS "pricePerPeriod", period_days AS "periodDays", currency_code AS currency,
            security_deposit AS "securityDeposit", late_fee_per_day AS "lateFeePerDay", damage_terms AS "damageTerms", status
       FROM rental_items WHERE service_id = $1 AND ($2 = false OR status = 'active') ORDER BY sku`, [id, opts.audience === 'public'])).rows;

  const media = (await exec.query(
    `SELECT id, kind, mime_type AS "mimeType", caption, is_past_work AS "isPastWork", sort_order AS "sortOrder"
       FROM service_media WHERE service_id = $1 ORDER BY sort_order, created_at`, [id])).rows
    .map((m) => ({ ...m, url: `/v1/media/${m.id}` }));

  const rating = (await exec.query<{ count: number; average: string | null }>(
    `SELECT count(*)::int AS count, round(avg(rating), 2)::text AS average FROM reviews WHERE service_id = $1 AND status = 'published'`, [id])).rows[0]!;
  const showIdentity = opts.audience !== 'public' || (await identityVisible(exec, s.countryId, s.providerShowIdentity));
  const {
    providerName, providerShowIdentity: _f, policyId, policyName, policyDescription, policyTiers, policyDepositRefundable,
    policySelfCancel, policyManualReview, ...rest
  } = s;
  return {
    ...rest,
    // Hiding the name publicly never removes the provider id from internal records.
    providerId: opts.audience === 'public' && !showIdentity ? null : s.providerId,
    providerName: showIdentity ? providerName : null,
    attributes,
    fields: visible,
    cancellationPolicy: policyId ? {
      id: policyId, name: policyName, description: policyDescription, tiers: policyTiers, depositRefundable: policyDepositRefundable,
      selfCancelAllowed: policySelfCancel, requiresManualReview: policyManualReview,
    } : null,
    packages,
    rentalItems,
    media,
    rating: { average: rating.average, count: rating.count },
  };
}
