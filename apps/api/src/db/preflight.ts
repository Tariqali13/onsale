import pg from 'pg';
import { Redis } from 'ioredis';
import { redisTls } from '../lib/redis.js';

/** A startup failure with a human-readable explanation and fix. */
export class StartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StartupError';
  }
}

function describe(url: string): string {
  try {
    const u = new URL(url);
    const auth = u.username ? `${u.username}${u.password ? ':***' : ' (no password)'}@` : '';
    return `${u.protocol}//${auth}${u.host}${u.pathname}`;
  } catch {
    return '(unparseable URL)';
  }
}

const FIX_DB = `
  Fix one of these:
    • Start the bundled database:   docker compose up -d postgres redis
    • Or point at your own Postgres: copy .env.example to .env and set
        DATABASE_URL=postgres://<user>:<password>@localhost:5432/onsale`;

/**
 * Check Postgres is reachable before migrating. In development, create the
 * target database if the server is up but the database doesn't exist yet.
 */
export async function ensureDatabase(url: string, opts: { createIfMissing: boolean }): Promise<void> {
  const tryConnect = async (connectionString: string) => {
    const client = new pg.Client({ connectionString, connectionTimeoutMillis: 5000 });
    await client.connect();
    return client;
  };

  try {
    const c = await tryConnect(url);
    await c.end();
    return;
  } catch (err) {
    const e = err as Error & { code?: string };
    const target = describe(url);

    if (e.code === '3D000' && opts.createIfMissing) {
      // Server is up, database missing: create it via the maintenance database.
      const u = new URL(url);
      const dbName = decodeURIComponent(u.pathname.slice(1));
      u.pathname = '/postgres';
      const admin = await tryConnect(u.toString());
      try {
        await admin.query(`CREATE DATABASE ${pg.escapeIdentifier(dbName)}`);
        console.log(`created database "${dbName}"`);
      } finally {
        await admin.end();
      }
      return;
    }
    if (e.code === 'ECONNREFUSED') {
      throw new StartupError(`Can't reach Postgres at ${target}: nothing is listening there.${FIX_DB}`);
    }
    if (/password must be a string|password authentication failed|SASL/i.test(e.message) || e.code === '28P01') {
      throw new StartupError(
        `Postgres at ${target} rejected the login: the username or password in DATABASE_URL is wrong or missing.${FIX_DB}`,
      );
    }
    if (e.code === '3D000') {
      throw new StartupError(`Database missing at ${target}. Create it, or run in development to have it created.`);
    }
    throw new StartupError(`Can't connect to Postgres at ${target}: ${e.message}${FIX_DB}`);
  }
}

/** Probe Redis with a one-shot, non-retrying connection so a down server gives one clear error, not a retry storm. */
export async function ensureRedis(url: string): Promise<void> {
  const probe = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
    connectTimeout: 5000,
    tls: redisTls(url),
  });
  probe.on('error', () => undefined);
  try {
    await probe.connect();
    await probe.ping();
    await probe.quit();
  } catch (err) {
    probe.disconnect();
    throw new StartupError(
      `Can't reach Redis at ${describe(url)}: ${(err as Error).message}
  Fix one of these:
    • Start the bundled Redis:  docker compose up -d redis
    • Or on macOS:              brew install redis && brew services start redis
    • Or set REDIS_URL in .env (e.g. a free Upstash rediss:// URL)`,
    );
  }
}
