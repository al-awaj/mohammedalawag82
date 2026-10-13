import { parseArgs } from 'node:util';
import { loadConfig } from '../config.js';
import { createPool, withTx } from '../db/pool.js';
import { audit, systemActor } from '../lib/audit.js';
import { hashPassword } from '../lib/password.js';
import { emailSchema, passwordSchema } from '../modules/common.js';

/**
 * Creates the first system administrator. Refuses if one already exists:
 * further staff are created from the admin panel so they are audited against a real actor.
 * Usage: npm run create-admin -- --name "Admin" --email admin@example.com --password '...'
 */
const { values } = parseArgs({ options: { name: { type: 'string' }, email: { type: 'string' }, password: { type: 'string' } } });
const email = emailSchema.parse(values.email);
const password = passwordSchema.parse(values.password);
const name = values.name?.trim();
if (!name || name.length < 2) throw new Error('--name is required');

const db = createPool(loadConfig().DATABASE_URL);
try {
  await withTx(db, async (c) => {
    const role = (await c.query<{ id: string }>(`SELECT id FROM roles WHERE code = 'system_admin'`)).rows[0];
    if (!role) throw new Error('Run "npm run seed:reference" first');
    const existing = await c.query('SELECT 1 FROM user_roles WHERE role_id = $1 LIMIT 1', [role.id]);
    if (existing.rowCount) throw new Error('A system administrator already exists');
    const id = (await c.query<{ id: string }>(
      `INSERT INTO users (kind, full_name, email, preferred_language, email_verified_at) VALUES ('staff', $1, $2, 'ar', now()) RETURNING id`,
      [name, email])).rows[0]!.id;
    await c.query('INSERT INTO user_credentials (user_id, password_hash) VALUES ($1, $2)', [id, await hashPassword(password)]);
    await c.query('INSERT INTO staff_profiles (user_id, job_title) VALUES ($1, $2)', [id, 'System administrator']);
    await c.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [id, role.id]);
    await audit(c, systemActor, { action: 'staff.bootstrap_admin_created', entityType: 'user', entityId: id, after: { email } });
    console.log(`System administrator created: ${email}`);
  });
} finally {
  await db.end();
}
