import { z } from 'zod';
import { i18nTextSchema } from '../common.js';

/** Refund tiers: cancelling at least `hoursBefore` hours ahead refunds `refundPercentOfPaid` % of paid amounts (deposit aside). */
export const policyBody = z.object({
  name: i18nTextSchema,
  description: i18nTextSchema,
  tiers: z.array(z.object({ hoursBefore: z.number().int().min(0).max(24 * 365), refundPercentOfPaid: z.number().min(0).max(100) })).max(10)
    .refine((t) => new Set(t.map((x) => x.hoursBefore)).size === t.length, 'duplicate hoursBefore')
    .transform((t) => [...t].sort((a, b) => b.hoursBefore - a.hoursBefore))
    .refine((t) => t.every((x, i) => i === 0 || x.refundPercentOfPaid <= t[i - 1]!.refundPercentOfPaid), 'refund must not increase closer to the event'),
  depositRefundable: z.boolean().default(false),
  selfCancelAllowed: z.boolean().default(true),
  requiresManualReview: z.boolean().default(false),
  isActive: z.boolean().default(true),
});

export const POLICY_COLUMNS = `id, provider_id AS "providerId", name, description, tiers, deposit_refundable AS "depositRefundable",
  self_cancel_allowed AS "selfCancelAllowed", requires_manual_review AS "requiresManualReview", is_active AS "isActive"`;

export function policyParams(b: z.infer<typeof policyBody>) {
  return [JSON.stringify(b.name), JSON.stringify(b.description), JSON.stringify(b.tiers), b.depositRefundable, b.selfCancelAllowed, b.requiresManualReview, b.isActive];
}
