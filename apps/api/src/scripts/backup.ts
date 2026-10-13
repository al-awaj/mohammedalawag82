import { loadConfig } from '../config.js';
import { backup } from '../ops/backup.js';

/** npm run backup -- [outDir] [keep]   (defaults: BACKUP_DIR or ./backups, keep 14) */
const config = loadConfig();
const outDir = process.argv[2] ?? process.env.BACKUP_DIR ?? './backups';
const keep = Number(process.argv[3] ?? process.env.BACKUP_KEEP ?? 14);
const r = await backup({ databaseUrl: config.DATABASE_URL, storageDir: config.STORAGE_DIR, outDir, keep });
const rows = Object.values(r.manifest.fingerprint.tables).reduce((a, b) => a + b, 0);
console.log(`Backup written to ${r.dir} (${rows} rows, ${r.manifest.fingerprint.storageFiles} files, schema ${r.manifest.fingerprint.schemaVersion})`);
