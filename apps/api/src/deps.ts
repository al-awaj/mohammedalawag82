import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Config } from './config.js';
import type { Db } from './db/pool.js';
import type { FileStore } from './lib/storage.js';
import type { TokenService } from './lib/tokens.js';

export interface Deps {
  config: Config;
  db: Db;
  tokens: TokenService;
  storage: FileStore;
  authenticate: (req: FastifyRequest) => Promise<void>;
}

export type App = FastifyInstance<any, any, any, any, ZodTypeProvider>;
