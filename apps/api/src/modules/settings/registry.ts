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
  'providers.public_identity_visible': def({
    schema: z.boolean(),
    default: true,
    scopes: ['global', 'country'],
    description: { ar: 'إظهار اسم صاحب الخدمة في الواجهات العامة (تُستخدم في المرحلة 3)', en: 'Show provider name on public pages (used by phase 3)' },
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
