import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
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
import type { Redis } from './lib/redis.js';
import { AppError } from './lib/errors.js';
import { createMetrics, type Metrics } from './lib/metrics.js';
import { WaitingRoom } from './queue/waitingRoom.js';
import { AccessTokens, type AccessClaims } from './queue/accessToken.js';
import { SeatHolds } from './holds/seatHolds.js';
import { EventsRepo } from './events/eventsRepo.js';
import { IdempotencyStore } from './checkout/idempotency.js';
import { MockPaymentProvider, StripePaymentProvider, type PaymentProvider } from './payments/provider.js';
import { CrowdSimulator } from './sim/simulator.js';
import { registerRoutes } from './routes/index.js';

export interface Services {
  config: Config;
  db: Db;
  redis: Redis;
  metrics: Metrics;
  room: WaitingRoom;
  tokens: AccessTokens;
  holds: SeatHolds;
  events: EventsRepo;
  idempotency: IdempotencyStore;
  payments: PaymentProvider;
  simulator: CrowdSimulator;
}

declare module 'fastify' {
  interface FastifyRequest {
    access?: AccessClaims;
  }
}

export function createServices(config: Config, db: Db, redis: Redis, log: CrowdSimulatorLog, payments?: PaymentProvider): Services {
  const metrics = createMetrics();
  const room = new WaitingRoom(redis, {
    admitRatePerSec: config.ADMIT_RATE_PER_SEC,
    maxActive: config.MAX_ACTIVE_SESSIONS,
    accessWindowSec: config.ACCESS_WINDOW_SEC,
  });
  const holds = new SeatHolds(redis, config.HOLD_TTL_SEC);
  const events = new EventsRepo(db, holds);
  const idempotency = new IdempotencyStore(db);
  const provider =
    payments ??
    (config.PAYMENT_PROVIDER === 'stripe' ? new StripePaymentProvider(config.STRIPE_SECRET_KEY!) : new MockPaymentProvider());
  const tokens = new AccessTokens(config.ACCESS_TOKEN_SECRET);
  const simulator = new CrowdSimulator({ db, holds, room, payments: provider, idempotency, metrics, events }, log);
  return { config, db, redis, metrics, room, tokens, holds, events, idempotency, payments: provider, simulator };
}

type CrowdSimulatorLog = { error: (o: object, msg: string) => void };

export async function buildApp(services: Services): Promise<FastifyInstance> {
  const { config, metrics } = services;
  const app = Fastify({
    logger:
      config.NODE_ENV === 'test'
        ? false
        : {
            level: config.LOG_LEVEL,
            redact: ['req.headers.authorization'],
            transport: config.NODE_ENV === 'development' ? { target: 'pino-pretty' } : undefined,
          },
    trustProxy: true,
    genReqId: (req) => (req.headers['x-request-id'] as string) ?? crypto.randomUUID(),
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(cors, {
    origin: config.CORS_ORIGIN.split(',').map((s) => s.trim()),
    allowedHeaders: ['content-type', 'authorization', 'idempotency-key', 'x-session-id'],
  });
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
    redis: config.NODE_ENV === 'test' ? undefined : services.redis,
    nameSpace: 'rl:',
    skipOnError: true, // fail open: a Redis blip must not take the storefront down
  });
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Onsale API',
        description: 'High-concurrency ticket onsale engine: waiting room, atomic seat holds, idempotent checkout.',
        version: '1.0.0',
      },
      components: { securitySchemes: { accessPass: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } } },
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  app.addHook('onResponse', async (req, reply) => {
    metrics.httpDuration
      .labels(req.method, req.routeOptions.url ?? 'unmatched', String(reply.statusCode))
      .observe(reply.elapsedTime / 1000);
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message, ...err.details } });
    }
    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply.status(400).send({
        error: { code: 'validation_error', message: 'Request is invalid', issues: err.validation.map((v) => v.message) },
      });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) {
      return reply.status(status).send({ error: { code: 'request_error', message: (err as Error).message } });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send({ error: { code: 'internal_error', message: 'Something went wrong', requestId: req.id } });
  });

  await registerRoutes(app, services);
  return app;
}

/** Guard for routes only admitted shoppers may call. */
export function requireAccess(services: Services) {
  return async (req: FastifyRequest<{ Params: { eventId: string } }>) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new AppError(401, 'access_required', 'You need to pass through the waiting room first.');
    }
    const claims = await services.tokens.verify(header.slice(7));
    if (claims.eventId !== req.params.eventId) throw new AppError(403, 'wrong_event', 'This access pass is for a different event.');
    if (!(await services.room.isActive(claims.eventId, claims.session))) {
      throw new AppError(401, 'access_expired', 'Your shopping window has ended. Please rejoin the queue.');
    }
    req.access = claims;
  };
}
