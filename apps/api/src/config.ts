import { z } from 'zod';

/**
 * All runtime configuration is validated once at startup.
 * A misconfigured deploy should fail fast with a readable error,
 * not half-work and fail on the first checkout.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().url().default('postgres://postgres@localhost:5432/onsale'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),

  /** HMAC secret for signing waiting-room access tokens. */
  ACCESS_TOKEN_SECRET: z.string().min(32).default('dev-only-secret-change-me-0123456789abcdef'),
  /** Shared secret for /admin endpoints (reset demo, etc.). Unset = admin disabled. */
  ADMIN_TOKEN: z.string().min(16).optional(),

  /** How many queued sessions are admitted per second. */
  ADMIT_RATE_PER_SEC: z.coerce.number().int().positive().default(25),
  /** Maximum sessions allowed inside the "store" at once (protects downstream). */
  MAX_ACTIVE_SESSIONS: z.coerce.number().int().positive().default(400),
  /** How long an admitted session may shop before it must re-queue. */
  ACCESS_WINDOW_SEC: z.coerce.number().int().positive().default(600),
  /** How long a seat hold lasts before seats return to the pool. */
  HOLD_TTL_SEC: z.coerce.number().int().positive().default(300),
  MAX_SEATS_PER_SESSION: z.coerce.number().int().positive().default(8),

  /** 'mock' needs no account and is used by the public demo; 'stripe' uses PaymentIntents in test mode. */
  PAYMENT_PROVIDER: z.enum(['mock', 'stripe']).default('mock'),
  STRIPE_SECRET_KEY: z.string().optional(),

  /** Run the admission loop in this process. Disable to run it as a separate worker. */
  RUN_ADMITTER: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  /** Allow the public "simulate crowd" endpoint (demo deployments). */
  ENABLE_SIMULATOR: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  /** Per-IP rate limiting. Disable only for load tests where all traffic comes from one machine. */
  RATE_LIMIT_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  /** 'redis' shares limits across instances; 'memory' saves Redis commands on single-instance free-tier deploys. */
  RATE_LIMIT_STORE: z.enum(['redis', 'memory']).default('redis'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const cfg = parsed.data;
  if (cfg.NODE_ENV === 'production' && cfg.ACCESS_TOKEN_SECRET.startsWith('dev-only')) {
    throw new Error('ACCESS_TOKEN_SECRET must be set in production');
  }
  if (cfg.PAYMENT_PROVIDER === 'stripe' && !cfg.STRIPE_SECRET_KEY) {
    throw new Error('STRIPE_SECRET_KEY is required when PAYMENT_PROVIDER=stripe');
  }
  if (cfg.STRIPE_SECRET_KEY?.startsWith('sk_live')) {
    throw new Error('Refusing to start with a live Stripe key: this project is test-mode only');
  }
  return cfg;
}
