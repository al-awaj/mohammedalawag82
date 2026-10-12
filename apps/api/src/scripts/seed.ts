import type { Db } from '../db/pool.js';
import { withTx } from '../db/pool.js';
import { PERMISSIONS, SYSTEM_ROLES } from '../auth/permissions.js';
import { DEFAULT_TEMPLATES } from '../modules/notifications/templates.js';

/** ISO 4217 reference currencies. Real reference data, not demo data; admins can add/disable others. */
const CURRENCIES: [string, string, string, string, number][] = [
  ['SAR', 'ريال سعودي', 'Saudi Riyal', 'ر.س', 2],
  ['AED', 'درهم إماراتي', 'UAE Dirham', 'د.إ', 2],
  ['KWD', 'دينار كويتي', 'Kuwaiti Dinar', 'د.ك', 3],
  ['QAR', 'ريال قطري', 'Qatari Riyal', 'ر.ق', 2],
  ['BHD', 'دينار بحريني', 'Bahraini Dinar', 'د.ب', 3],
  ['OMR', 'ريال عماني', 'Omani Rial', 'ر.ع', 3],
  ['YER', 'ريال يمني', 'Yemeni Rial', 'ر.ي', 2],
  ['EGP', 'جنيه مصري', 'Egyptian Pound', 'ج.م', 2],
  ['JOD', 'دينار أردني', 'Jordanian Dinar', 'د.أ', 3],
  ['USD', 'دولار أمريكي', 'US Dollar', '$', 2],
  ['EUR', 'يورو', 'Euro', '€', 2],
];

/**
 * Idempotent: languages, reference currencies, the permission catalog and system roles.
 * System-role permissions are re-synced from code; custom roles are untouched.
 */
export async function seedReference(db: Db): Promise<void> {
  await withTx(db, async (c) => {
    await c.query(`INSERT INTO languages (code, name, direction) VALUES
      ('ar', '{"ar":"العربية","en":"Arabic"}', 'rtl'), ('en', '{"ar":"الإنجليزية","en":"English"}', 'ltr')
      ON CONFLICT (code) DO NOTHING`);
    for (const [code, ar, en, symbol, minor] of CURRENCIES) {
      await c.query('INSERT INTO currencies (code, name, symbol, minor_units) VALUES ($1, $2, $3, $4) ON CONFLICT (code) DO NOTHING',
        [code, JSON.stringify({ ar, en }), symbol, minor]);
    }
    for (const [code, p] of Object.entries(PERMISSIONS)) {
      await c.query(
        `INSERT INTO permissions (code, module, description) VALUES ($1, $2, $3)
         ON CONFLICT (code) DO UPDATE SET module = EXCLUDED.module, description = EXCLUDED.description`,
        [code, p.module, JSON.stringify({ ar: p.ar, en: p.en })]);
    }
    for (const r of SYSTEM_ROLES) {
      const id = (await c.query<{ id: string }>(
        `INSERT INTO roles (code, name, is_system) VALUES ($1, $2, true)
         ON CONFLICT (code) DO UPDATE SET is_system = true RETURNING id`,
        [r.code, JSON.stringify({ ar: r.ar, en: r.en })])).rows[0]!.id;
      if (r.code === 'system_admin') {
        await c.query('DELETE FROM role_permissions WHERE role_id = $1', [id]);
      }
      for (const p of r.permissions) {
        await c.query('INSERT INTO role_permissions (role_id, permission_code) VALUES ($1, $2) ON CONFLICT DO NOTHING', [id, p]);
      }
    }
    // Default notification wording (ar/en) for SMS, email and in-app; never overwrites texts edited by admins.
    for (const [key, t] of Object.entries(DEFAULT_TEMPLATES)) {
      for (const channel of ['sms', 'email', 'web']) {
        for (const lang of ['ar', 'en'] as const) {
          const subject = channel === 'sms' ? null : (lang === 'ar' ? t.subjectAr : t.subjectEn) ?? (lang === 'ar' ? t.ar : t.en).slice(0, 80);
          await c.query(
            'INSERT INTO notification_templates (key, channel, language, subject, body) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (key, channel, language) DO NOTHING',
            [key, channel, lang, subject, lang === 'ar' ? t.ar : t.en]);
        }
      }
    }
  });
}
