#!/usr/bin/env node
/**
 * Runs the whole platform on one machine in production mode: fast pages, no compile-on-click.
 *   node scripts/start-local.mjs           build the web apps if needed, then start everything
 *   node scripts/start-local.mjs --build   always rebuild first (after pulling changes)
 * Needs PostgreSQL running and apps/api/.env plus apps/{admin,provider,web}/.env (copied from .env.example).
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const apps = [['admin', 3001], ['provider', 3002], ['web', 3003]];

const built = apps.every(([a]) => existsSync(path.join(root, 'apps', a, '.next', 'BUILD_ID')));
if (process.argv.includes('--build') || !built) {
  console.log('Building the web interfaces (once; a few minutes)…');
  const r = spawnSync(npm, ['run', 'build', '-w', 'apps/admin', '-w', 'apps/provider', '-w', 'apps/web'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const colors = [36, 33, 35, 32, 34];
const children = [];
function run(name, args, cwd, i, extraEnv = {}) {
  const child = spawn(npm, args, { cwd: path.join(root, cwd), env: { ...process.env, ...extraEnv }, shell: process.platform === 'win32' });
  const tag = `\x1b[${colors[i % colors.length]}m[${name}]\x1b[0m `;
  const pipe = (s) => s.on('data', (d) => d.toString().split(/\r?\n/).filter(Boolean).forEach((l) => console.log(tag + l)));
  pipe(child.stdout); pipe(child.stderr);
  child.on('exit', (code) => console.log(`${tag}stopped (${code})`));
  children.push(child);
}
// The API and worker keep their .env NODE_ENV (development keeps local-friendly defaults such as http origins).
run('api', ['run', 'start'], 'apps/api', 0);
run('worker', ['run', 'worker'], 'apps/api', 1);
apps.forEach(([a, port], i) => run(a, ['exec', '--', 'next', 'start', '-p', String(port)], `apps/${a}`, i + 2, { NODE_ENV: 'production', COOKIE_SECURE: 'false' }));

console.log('\nWebsite: http://localhost:3003   Admin: http://localhost:3001   Providers: http://localhost:3002   (Ctrl+C to stop)\n');
const stop = () => { children.forEach((c) => c.kill()); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
