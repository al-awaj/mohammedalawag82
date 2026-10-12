import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { releaseExpiredHolds } from './modules/availability/engine.js';
import { expireBookings, warnExpiringHolds } from './modules/booking/service.js';

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
  { name: 'warn-expiring-holds', everyMs: 60_000, run: () => warnExpiringHolds(db) },
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
