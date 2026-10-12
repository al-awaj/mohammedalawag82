import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import {
  hasZodFastifySchemaValidationErrors,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type { Config } from './config.js';
import type { Db } from './db/pool.js';
import { makeAuthenticate } from './auth/guard.js';
import { AppError } from './lib/errors.js';
import { pickLang, t, type Lang } from './lib/i18n.js';
import { LocalStorage } from './lib/storage.js';
import { TokenService } from './lib/tokens.js';
import type { Deps } from './deps.js';
import { authRoutes } from './modules/auth/routes.js';
import { referenceRoutes } from './modules/reference/routes.js';
import { providerRoutes } from './modules/providers/routes.js';
import { staffRoutes } from './modules/staff/routes.js';
import { settingsRoutes } from './modules/settings/routes.js';
import { auditRoutes } from './modules/audit/routes.js';
import { catalogAdminRoutes } from './modules/catalog/admin-routes.js';
import { catalogProviderRoutes } from './modules/catalog/provider-routes.js';
import { catalogPublicRoutes } from './modules/catalog/public-routes.js';
import { availabilityRoutes } from './modules/availability/routes.js';
import { bookingRoutes } from './modules/booking/routes.js';
import { financeRoutes } from './modules/finance/routes.js';

export async function buildApp(config: Config, db: Db) {
  const app = Fastify({
    logger: config.NODE_ENV === 'test' ? false : { level: 'info', redact: ['req.headers.authorization'] },
    trustProxy: true,
    bodyLimit: 1024 * 1024,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorateRequest('user', null);

  await app.register(helmet);
  await app.register(cors, {
    origin: config.CORS_ORIGINS ? config.CORS_ORIGINS.split(',').map((s) => s.trim()) : false,
    credentials: true,
  });
  if (config.RATE_LIMIT_ENABLED) {
    await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });
  }
  await app.register(multipart, { limits: { fileSize: Math.max(config.MAX_UPLOAD_BYTES, config.MAX_VIDEO_BYTES), files: 1, fields: 5 } });
  await app.register(swagger, {
    openapi: {
      info: { title: 'Events Platform API', version: '1' },
      components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } } },
    },
    transform: jsonSchemaTransform,
  });
  if (config.NODE_ENV !== 'production') {
    await app.register(swaggerUi, { routePrefix: '/docs' });
  }

  app.setErrorHandler((err, req, reply) => {
    const lang: Lang = pickLang(req.user?.preferredLanguage ?? req.headers['accept-language']);
    if (err instanceof AppError) {
      return reply.status(err.status).send({ error: { code: err.code, message: t(err.code, lang), details: err.details } });
    }
    if (hasZodFastifySchemaValidationErrors(err)) {
      const details = err.validation.map((v) => ({ path: v.instancePath, message: v.message }));
      return reply.status(400).send({ error: { code: 'VALIDATION_FAILED', message: t('VALIDATION_FAILED', lang), details } });
    }
    if ((err as { code?: string }).code === '23503') {
      return reply.status(400).send({ error: { code: 'INVALID_REFERENCE', message: t('INVALID_REFERENCE', lang), details: null } });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 429) {
      return reply.status(429).send({ error: { code: 'RATE_LIMITED', message: t('RATE_LIMITED', lang), details: null } });
    }
    if (status && status >= 400 && status < 500) {
      return reply.status(status).send({ error: { code: (err as { code?: string }).code ?? 'BAD_REQUEST', message: (err as Error).message, details: null } });
    }
    req.log.error(err);
    return reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: t('INTERNAL_ERROR', lang), details: null } });
  });

  app.setNotFoundHandler((req, reply) => {
    const lang = pickLang(req.headers['accept-language']);
    reply.status(404).send({ error: { code: 'NOT_FOUND', message: t('NOT_FOUND', lang), details: null } });
  });

  const tokens = new TokenService(config.JWT_SECRET, config.ACCESS_TOKEN_TTL_SECONDS);
  const deps: Deps = {
    config,
    db,
    tokens,
    storage: new LocalStorage(config.STORAGE_DIR, config.MAX_UPLOAD_BYTES, config.MAX_VIDEO_BYTES),
    authenticate: makeAuthenticate(db, tokens),
  };

  app.get('/health', { schema: { hide: true } }, async () => {
    await db.query('SELECT 1');
    return { status: 'ok' };
  });

  await app.register(async (v1) => {
    await authRoutes(v1, deps);
    await referenceRoutes(v1, deps);
    await providerRoutes(v1, deps);
    await staffRoutes(v1, deps);
    await settingsRoutes(v1, deps);
    await auditRoutes(v1, deps);
    await catalogAdminRoutes(v1, deps);
    await catalogProviderRoutes(v1, deps);
    await catalogPublicRoutes(v1, deps);
    await availabilityRoutes(v1, deps);
    await bookingRoutes(v1, deps);
    await financeRoutes(v1, deps);
  }, { prefix: '/v1' });

  return app;
}
