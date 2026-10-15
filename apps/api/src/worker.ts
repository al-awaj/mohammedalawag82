import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { releaseExpiredHolds } from './modules/availability/engine.js';
import { expireRescheduleRequests } from './modules/booking/reschedule.js';
import { expireBookings, warnExpiringHolds } from './modules/booking/service.js';
import { deliverOutbox } from './modules/notifications/delivery.js';
import { sendReminders } from './modules/notifications/reminders.js';
import { reportError } from './lib/alerts.js';

/**
 * Scheduled jobs (clause 73). Run as its own process: `npm run worker`.
 * Each job takes a transaction-scoped advisory lock so running several workers is safe.
 */
const config = loadConfig();
const db = createPool(config.DATABASE_URL);

const jobs: { name: string; everyMs: number; run: () => Promise<number> }[] = [
  // Bookings first, so an expiring booking frees its own hold with a booking-specific reason and notice.
  { name: 'expire-bookings', everyMs: 30_000, run: () => expireBookings(db) },
  { name: 'release-expired-holds', everyMs: 30_000, run: () => releaseExpiredHolds(db) },
  { name: 'expire-reschedule-requests', everyMs: 60_000, run: () => expireRescheduleRequests(db) },
  { name: 'warn-expiring-holds', everyMs: 60_000, run: () => warnExpiringHolds(db) },
  { name: 'send-reminders', everyMs: 15 * 60_000, run: () => sendReminders(db) },
  { name: 'deliver-notifications', everyMs: 5_000, run: () => deliverOutbox(db) },
  // Liveness for the admin system status page.
  { name: 'heartbeat', everyMs: 60_000, run: async () => {
    await db.query(`INSERT INTO system_heartbeats (name, beat_at, info) VALUES ('worker', now(), $1)
                    ON CONFLICT (name) DO UPDATE SET beat_at = now(), info = EXCLUDED.info`, [JSON.stringify({ pid: process.pid, jobs: jobs.length })]);
    return 0;
  } },
];

async function tick(job: (typeof jobs)[number]) {
  const client = await db.connect();
  try {
    const got = (await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', [job.name])).rows[0]!.ok;
    if (!got) return;
    try {
      const n = await job.run();
      if (n) console.log(JSON.stringify({ job: job.name, processed: n, at: new Date().toISOString() }));
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [job.name]);
    }
  } catch (err) {
    console.error(JSON.stringify({ job: job.name, error: (err as Error).message }));
    reportError(`worker:${job.name}`, err);
  } finally {
    client.release();
  }
}

const timers = jobs.map((j) => setInterval(() => void tick(j), j.everyMs));
for (const j of jobs) void tick(j);

const stop = async () => {
  timers.forEach(clearInterval);
  await db.end();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
