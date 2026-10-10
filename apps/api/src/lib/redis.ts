import { Redis } from 'ioredis';

/**
 * Every key for one event shares the `{eventId}` hash tag, so all keys touched
 * by a single Lua script live in the same Redis Cluster slot. That keeps the
 * scripts valid on clustered/managed Redis (e.g. Upstash, ElastiCache cluster mode).
 */
export const keys = {
  waiting: (e: string) => `q:{${e}}:waiting`,
  active: (e: string) => `q:{${e}}:active`,
  stats: (e: string) => `q:{${e}}:stats`,
  claimed: (e: string) => `q:{${e}}:claimed`,
  heartbeat: (e: string, session: string) => `hb:{${e}}:${session}`,
  hold: (e: string, seatId: string) => `hold:{${e}}:${seatId}`,
  sessionHolds: (e: string, session: string) => `holds:{${e}}:${session}`,
  sold: (e: string) => `sold:{${e}}`,
  soldLoaded: (e: string) => `sold:{${e}}:loaded`,
  admitterLock: () => 'lock:admitter',
};

/**
 * TLS for rediss:// URLs, and for Upstash hosts even when pasted as redis://
 * (Upstash only accepts TLS connections).
 */
export function redisTls(url: string): object | undefined {
  if (url.startsWith('rediss://')) return {};
  try {
    return new URL(url).hostname.endsWith('.upstash.io') ? {} : undefined;
  } catch {
    return undefined;
  }
}

export function createRedis(url: string): Redis {
  return new Redis(url, {
    maxRetriesPerRequest: 3,
    enableAutoPipelining: true,
    tls: redisTls(url),
  });
}

export type { Redis };
