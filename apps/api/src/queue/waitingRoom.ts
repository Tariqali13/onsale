import { randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';
import { keys } from '../lib/redis.js';

/**
 * Virtual waiting room.
 *
 * Model: a FIFO queue (sorted set scored by join time) feeds a bounded
 * "active" set. A single leader process admits up to `rate` sessions per tick,
 * never exceeding `maxActive` concurrent shoppers. Admission is what protects
 * the seat-hold and payment paths from a thundering herd; those paths can then
 * be sized for `maxActive`, not for total demand.
 */

// Admit atomically: expire stale active sessions, compute free capacity,
// pop that many from the head of the queue and mark them active.
// KEYS: waiting, active, stats   ARGV: nowMs, batch, maxActive, accessWindowMs
const ADMIT_LUA = `
local now = tonumber(ARGV[1])
local batch = tonumber(ARGV[2])
local maxActive = tonumber(ARGV[3])
local windowMs = tonumber(ARGV[4])
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now)
local free = maxActive - redis.call('ZCARD', KEYS[2])
local n = math.min(batch, free)
if n <= 0 then return {} end
local popped = redis.call('ZPOPMIN', KEYS[1], n)
local admitted = {}
for i = 1, #popped, 2 do
  redis.call('ZADD', KEYS[2], now + windowMs, popped[i])
  admitted[#admitted + 1] = popped[i]
end
if #admitted > 0 then redis.call('HINCRBY', KEYS[3], 'admitted', #admitted) end
return admitted
`;

// Join is idempotent: a session already waiting keeps its place; one already
// admitted stays admitted. KEYS: waiting, active, stats  ARGV: token, nowMs
const JOIN_LUA = `
if redis.call('ZSCORE', KEYS[2], ARGV[1]) then return 'active' end
local added = redis.call('ZADD', KEYS[1], 'NX', ARGV[2], ARGV[1])
if added == 1 then redis.call('HINCRBY', KEYS[3], 'joined', 1) return 'joined' end
return 'waiting'
`;

export type QueueStatus =
  | { state: 'waiting'; position: number; ahead: number; etaSeconds: number; queueSize: number }
  | { state: 'admitted'; expiresAt: number }
  | { state: 'unknown' };

export interface WaitingRoomOptions {
  admitRatePerSec: number;
  maxActive: number;
  accessWindowSec: number;
}

export class WaitingRoom {
  constructor(
    private readonly redis: Redis,
    private readonly opts: WaitingRoomOptions,
  ) {}

  static newSessionId(): string {
    return randomBytes(16).toString('base64url');
  }

  async join(eventId: string, sessionId: string, now = Date.now()): Promise<'joined' | 'waiting' | 'active'> {
    // Tie-break same-millisecond joins with a fractional component so ordering is stable.
    const score = now + Math.random() / 1000;
    return (await this.redis.eval(
      JOIN_LUA,
      3,
      keys.waiting(eventId),
      keys.active(eventId),
      keys.stats(eventId),
      sessionId,
      String(score),
    )) as 'joined' | 'waiting' | 'active';
  }

  async status(eventId: string, sessionId: string, now = Date.now()): Promise<QueueStatus> {
    const [activeScore, rank, size] = await Promise.all([
      this.redis.zscore(keys.active(eventId), sessionId),
      this.redis.zrank(keys.waiting(eventId), sessionId),
      this.redis.zcard(keys.waiting(eventId)),
    ]);
    if (activeScore !== null && Number(activeScore) > now) {
      return { state: 'admitted', expiresAt: Number(activeScore) };
    }
    if (rank === null) return { state: 'unknown' };
    return {
      state: 'waiting',
      position: rank + 1,
      ahead: rank,
      queueSize: size,
      etaSeconds: Math.ceil((rank + 1) / this.opts.admitRatePerSec),
    };
  }

  /** One admission step. Called by the leader roughly every `tickMs`. */
  async admit(eventId: string, tickMs = 1000, now = Date.now()): Promise<string[]> {
    const batch = Math.max(1, Math.floor((this.opts.admitRatePerSec * tickMs) / 1000));
    return (await this.redis.eval(
      ADMIT_LUA,
      3,
      keys.waiting(eventId),
      keys.active(eventId),
      keys.stats(eventId),
      String(now),
      String(batch),
      String(this.opts.maxActive),
      String(this.opts.accessWindowSec * 1000),
    )) as string[];
  }

  async isActive(eventId: string, sessionId: string, now = Date.now()): Promise<boolean> {
    const score = await this.redis.zscore(keys.active(eventId), sessionId);
    return score !== null && Number(score) > now;
  }

  /**
   * Give the session's shopping slot back to the queue.
   * `graceSec` keeps the pass valid briefly so the client can still retry a request
   * whose response it lost (idempotent replay) and view its confirmation.
   */
  async release(eventId: string, sessionId: string, graceSec = 0, now = Date.now()): Promise<void> {
    if (graceSec <= 0) {
      await this.redis.zrem(keys.active(eventId), sessionId);
      return;
    }
    // XX: only if still active. LT: only ever shorten the window, never extend it.
    await this.redis.zadd(keys.active(eventId), 'XX', 'LT', now + graceSec * 1000, sessionId);
  }

  async snapshot(eventId: string, now = Date.now()) {
    const [waiting, active, stats] = await Promise.all([
      this.redis.zcard(keys.waiting(eventId)),
      this.redis.zcount(keys.active(eventId), now, '+inf'),
      this.redis.hgetall(keys.stats(eventId)),
    ]);
    return {
      waiting,
      active,
      joined: Number(stats.joined ?? 0),
      admitted: Number(stats.admitted ?? 0),
      admitRatePerSec: this.opts.admitRatePerSec,
      maxActive: this.opts.maxActive,
    };
  }
}
