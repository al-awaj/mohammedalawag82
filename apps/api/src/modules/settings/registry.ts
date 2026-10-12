import { z } from 'zod';
import type { Executor } from '../../db/pool.js';

interface SettingDef<T> {
  schema: z.ZodType<T>;
  default: T;
  scopes: ('global' | 'country')[];
  description: { ar: string; en: string };
}

const def = <T>(d: SettingDef<T>) => d;

/**
 * Every configurable setting. Unknown keys are rejected so typos cannot create dead settings.
 * The consuming phase is noted where the value is not yet read by code.
 */
export const SETTINGS = {
  'booking.hold_minutes': def({
    schema: z.number().int().min(1).max(240),
    default: 15,
    scopes: ['global', 'country'],
    description: { ar: 'مدة الحجز المؤقت بالدقائق (تُستخدم في المرحلة 5)', en: 'Temporary hold duration in minutes (used by phase 5)' },
  }),
  'booking.approval_window_hours': def({
    schema: z.number().int().min(1).max(24 * 14),
    default: 24,
    scopes: ['global', 'country'],
    description: { ar: 'مهلة رد صاحب الخدمة على الحجز الذي يتطلب موافقته (بالساعات)، ويبقى الموعد محجوزًا خلالها', en: 'Hours a provider has to accept or reject an approval-required booking; the slot stays held meanwhile' },
  }),
  'booking.payment_window_hours': def({
    schema: z.number().int().min(1).max(24 * 7),
    default: 24,
    scopes: ['global', 'country'],
    description: { ar: 'مهلة الدفع بعد قبول صاحب الخدمة للحجز (بالساعات)', en: 'Hours the customer has to pay after the provider accepts' },
  }),
  'booking.expiry_warning_minutes': def({
    schema: z.number().int().min(1).max(24 * 60),
    default: 5,
    scopes: ['global', 'country'],
    description: { ar: 'إرسال تنبيه للعميل قبل انتهاء الحجز المؤقت بهذه الدقائق', en: 'Warn the customer this many minutes before a hold expires' },
  }),
  'booking.require_verified_phone': def({
    schema: z.boolean(),
    default: true,
    scopes: ['global', 'country'],
    description: { ar: 'اشتراط التحقق من هاتف العميل قبل إتمام الحجز', en: 'Require a verified customer phone before checkout' },
  }),
  'payments.platform_enabled': def({
    schema: z.boolean(),
    default: true,
    scopes: ['global', 'country'],
    description: { ar: 'تفعيل الدفع عبر المنصة', en: 'Enable payment through the platform' },
  }),
  'payments.direct_enabled': def({
    schema: z.boolean(),
    default: false,
    scopes: ['global', 'country'],
    description: { ar: 'تفعيل الدفع المباشر لصاحب الخدمة', en: 'Enable direct payment to the provider' },
  }),
  'earnings.require_review': def({
    schema: z.boolean(),
    default: false,
    scopes: ['global', 'country'],
    description: { ar: 'مراجعة الإدارة قبل اعتبار مستحقات الخدمة المكتملة مستحقة', en: 'Staff review before a completed service earning becomes due' },
  }),
  'auth.require_phone_verification': def({
    schema: z.boolean(),
    default: true,
    scopes: ['global', 'country'],
    description: { ar: 'اشتراط التحقق من الهاتف قبل تقديم طلب صاحب الخدمة', en: 'Require phone verification before a provider application is submitted' },
  }),
  'providers.required_documents': def({
    schema: z.array(z.string().regex(/^[a-z_]{2,50}$/)).max(20),
    default: ['identity', 'commercial_registration'],
    scopes: ['global', 'country'],
    description: { ar: 'الوثائق المطلوبة لطلب تسجيل صاحب الخدمة', en: 'Documents required for a provider application' },
  }),
  'services.require_review': def({
    schema: z.boolean(),
    default: true,
    scopes: ['global', 'country'],
    description: { ar: 'اشتراط مراجعة الإدارة قبل نشر الخدمة', en: 'Require staff review before a service is published' },
  }),
  'providers.public_identity_visible': def({
    schema: z.boolean(),
    default: true,
    scopes: ['global', 'country'],
    description: { ar: 'إظهار اسم صاحب الخدمة في الواجهات العامة ', en: 'Show provider name on public pages' },
  }),
} as const;

export type SettingKey = keyof typeof SETTINGS;
export type SettingValue<K extends SettingKey> = (typeof SETTINGS)[K]['default'];

export function isSettingKey(key: string): key is SettingKey {
  return Object.hasOwn(SETTINGS, key);
}

/** Effective value: country override → global → built-in default. */
export async function getSetting<K extends SettingKey>(
  exec: Executor,
  key: K,
  countryId?: string | null,
): Promise<SettingValue<K>> {
  const { rows } = await exec.query<{ value: unknown; scope_type: string }>(
    `SELECT value, scope_type FROM settings
      WHERE key = $1 AND (scope_type = 'global' OR (scope_type = 'country' AND scope_id = $2))
      ORDER BY (scope_type = 'country') DESC LIMIT 1`,
    [key, countryId ?? null],
  );
  return (rows[0]?.value ?? SETTINGS[key].default) as SettingValue<K>;
}
