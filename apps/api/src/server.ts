import { loadEnvFiles } from './lib/loadEnv.js';
import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { seedDemo } from './db/seed.js';
import { ensureDatabase, ensureRedis, StartupError } from './db/preflight.js';
import { createRedis } from './lib/redis.js';
import { buildApp, createServices } from './app.js';
import { startAdmitter } from './queue/admitter.js';
import { reconcilePending } from './checkout/reconciler.js';

loadEnvFiles();

function fail(err: unknown): never {
  if (err instanceof StartupError || (err instanceof Error && err.message.startsWith('Invalid environment'))) {
    console.error(`\n✖ Onsale API could not start\n\n  ${(err as Error).message}\n`);
  } else {
    console.error(err);
  }
  process.exit(1);
}

const config = (() => {
  try {
    return loadConfig();
  } catch (err) {
    return fail(err);
  }
})();

await ensureDatabase(config.DATABASE_URL, { createIfMissing: config.NODE_ENV !== 'production' }).catch(fail);
await ensureRedis(config.REDIS_URL).catch(fail);
const db = createPool(config.DATABASE_URL);
const redis = createRedis(config.REDIS_URL);

await migrate(db, (m) => console.log(m));
if (process.env.SEED_DEMO !== 'false') await seedDemo(db);

const bootLog = { error: (o: object, msg: string) => console.error(msg, o) };
const services = createServices(config, db, redis, bootLog);
const app = await buildApp(services);

// Track buyer-facing traffic so background work can sleep when nobody is here.
let lastActivity = Date.now();
app.addHook('onRequest', async (req) => {
  if (req.url.startsWith('/events/')) lastActivity = Date.now();
});
const isIdle = () => Date.now() - lastActivity > 60_000 && services.simulator.activeBots === 0;

const stopAdmitter = config.RUN_ADMITTER
  ? startAdmitter({
      redis,
      room: services.room,
      listOpenEvents: () => services.events.listOpenEvents(),
      onAdmitted: (_e, n) => services.metrics.queueAdmitted.inc(n),
      log: app.log,
      isIdle,
    })
  : async () => undefined;

const reconcileTimer = setInterval(() => {
  if (isIdle()) return;
  reconcilePending(services)
    .then((r) => (r.paid || r.failed) && app.log.info(r, 'reconciler settled orders'))
    .catch((err) => app.log.error({ err }, 'reconciler failed'));
  services.idempotency.purgeOlderThan(24).catch(() => undefined);
}, 30_000);

await app.listen({ port: config.PORT, host: config.HOST });

// Graceful shutdown: stop taking traffic, let in-flight checkouts finish, then close pools.
let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'shutting down');
    clearInterval(reconcileTimer);
    services.simulator.stop();
    await stopAdmitter();
    await app.close();
    await Promise.allSettled([db.end(), redis.quit()]);
    process.exit(0);
  });
}
