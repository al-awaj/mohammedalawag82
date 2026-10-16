import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createPool, type Db } from '../src/db/pool.js';

/** Browser clients on another origin (the app's web build) may use every method the API offers, and nothing else may. */
let app: FastifyInstance;
let db: Db;
beforeAll(async () => {
  const config = { ...loadConfig(), CORS_ORIGINS: 'https://app.example.org' };
  db = createPool(config.DATABASE_URL);
  app = (await buildApp(config, db)) as unknown as FastifyInstance;
});
afterAll(async () => { await app.close(); await db.end(); });

describe('CORS', () => {
  it('allows the allowed origin to edit and delete, and refuses other origins', async () => {
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      const r = await app.inject({ method: 'OPTIONS', url: '/v1/cart/items/x', headers: { origin: 'https://app.example.org', 'access-control-request-method': method } });
      expect(r.statusCode, method).toBe(204);
      expect(r.headers['access-control-allow-methods'], method).toContain(method);
      expect(r.headers['access-control-allow-origin']).toBe('https://app.example.org');
    }
    const evil = await app.inject({ method: 'OPTIONS', url: '/v1/cart/items/x', headers: { origin: 'https://evil.example', 'access-control-request-method': 'DELETE' } });
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
  });
});
