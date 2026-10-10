import { loadConfig, type Config } from '../src/config.js';
import { createPool, type Db } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { seedDemo } from '../src/db/seed.js';
import { createRedis, type Redis } from '../src/lib/redis.js';
import { createServices, type Services } from '../src/app.js';
import { resetEvent } from '../src/events/reset.js';
import type { PaymentProvider } from '../src/payments/provider.js';
import { MockPaymentProvider } from '../src/payments/provider.js';

/**
 * Integration tests run against real Postgres and Redis (docker compose locally,
 * service containers in CI). Mocking the database would hide exactly the
 * concurrency behaviour these tests exist to prove.
 */
export const TEST_DB_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres@localhost:5432/onsale_test';
export const TEST_REDIS_URL = process.env.TEST_REDIS_URL || 'redis://localhost:6379/15';

export interface TestContext {
  config: Config;
  db: Db;
  redis: Redis;
  services: Services;
  eventId: string;
  close: () => Promise<void>;
}

export async function setup(overrides: Partial<Record<keyof Config, string>> = {}, payments?: PaymentProvider): Promise<TestContext> {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: TEST_DB_URL,
    REDIS_URL: TEST_REDIS_URL,
    ENABLE_SIMULATOR: 'false',
    ...overrides,
  });
  await ensureDatabase(TEST_DB_URL);
  const db = createPool(TEST_DB_URL);
  const redis = createRedis(TEST_REDIS_URL);
  await migrate(db, () => undefined);
  const eventId = await seedDemo(db);
  const services = createServices(config, db, redis, { error: () => undefined }, payments ?? new MockPaymentProvider(5));
  return {
    config,
    db,
    redis,
    services,
    eventId,
    close: async () => {
      services.simulator.stop();
      await Promise.allSettled([db.end(), redis.quit()]);
    },
  };
}

export async function reset(ctx: TestContext): Promise<void> {
  await resetEvent(ctx.services, ctx.eventId);
  await ctx.redis.flushdb();
}

/** Admit a session straight into the active set (skips the queue for tests that don't care about it). */
export async function admitDirectly(ctx: TestContext, session: string): Promise<void> {
  await ctx.services.room.join(ctx.eventId, session);
  await ctx.services.room.admit(ctx.eventId, 100_000);
}

export async function firstSeats(ctx: TestContext, n: number, offset = 0): Promise<string[]> {
  const { seats } = await ctx.services.events.seats(ctx.eventId);
  return seats.slice(offset, offset + n).map((s) => s.id);
}

async function ensureDatabase(url: string) {
  const u = new URL(url);
  const name = u.pathname.slice(1);
  u.pathname = '/postgres';
  const admin = createPool(u.toString());
  try {
    const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (!rowCount) await admin.query(`CREATE DATABASE "${name}"`);
  } catch (err) {
    if ((err as { code?: string }).code !== '42P04') throw err; // created concurrently by another worker
  } finally {
    await admin.end();
  }
}
