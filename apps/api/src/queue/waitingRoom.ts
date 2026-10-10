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

// Admit atomically: expire stale active sessions, compute free capacity, then pop
// from the head of the queue. Sessions whose heartbeat has lapsed (tab closed, phone
// locked, gave up) are dropped instead of admitted, so ghosts never take a slot.
// Admitted sessions get a short *claim* window; it becomes the full access window
// only once the buyer actually polls and picks up their pass.
// KEYS: waiting, active, stats
// ARGV: nowMs, batch, maxActive, claimWindowMs, heartbeatKeyPrefix
const ADMIT_LUA = `
local now = tonumber(ARGV[1])
local batch = tonumber(ARGV[2])
local maxActive = tonumber(ARGV[3])
local claimMs = tonumber(ARGV[4])
local hbPrefix = ARGV[5]
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now)
local free = maxActive - redis.call('ZCARD', KEYS[2])
local want = math.min(batch, free)
local admitted = {}
local dropped = 0
local budget = want * 4 + 10 -- bound the script's work even if the queue is full of ghosts
while #admitted < want and budget > 0 do
  local popped = redis.call('ZPOPMIN', KEYS[1], 1)
  if #popped == 0 then break end
  budget = budget - 1
  local token = popped[1]
  if redis.call('EXISTS', hbPrefix .. token) == 1 then
    redis.call('ZADD', KEYS[2], now + claimMs, token)
    admitted[#admitted + 1] = token
  else
    dropped = dropped + 1
  end
end
if #admitted > 0 then redis.call('HINCRBY', KEYS[3], 'admitted', #admitted) end
if dropped > 0 then redis.call('HINCRBY', KEYS[3], 'abandoned', dropped) end
return admitted
`;

// Join is idempotent: a session already waiting keeps its place; one already
// admitted stays admitted. KEYS: waiting, active, stats, heartbeat
// ARGV: token, score, heartbeatMs
const JOIN_LUA = `
redis.call('SET', KEYS[4], '1', 'PX', ARGV[3])
if redis.call('ZSCORE', KEYS[2], ARGV[1]) then return 'active' end
local added = redis.call('ZADD', KEYS[1], 'NX', ARGV[2], ARGV[1])
if added == 1 then redis.call('HINCRBY', KEYS[3], 'joined', 1) return 'joined' end
return 'waiting'
`;

// Poll: refresh the heartbeat while waiting; on the first poll after admission,
// claim the slot (extend the short claim window to the full access window).
// KEYS: waiting, active, heartbeat, claimed   ARGV: token, nowMs, accessWindowMs, heartbeatMs
const STATUS_LUA = `
local now = tonumber(ARGV[2])
local score = redis.call('ZSCORE', KEYS[2], ARGV[1])
if score and tonumber(score) > now then
  if redis.call('SADD', KEYS[4], ARGV[1]) == 1 then
    redis.call('PEXPIRE', KEYS[4], ARGV[3])
    local full = now + tonumber(ARGV[3])
    redis.call('ZADD', KEYS[2], 'XX', 'GT', full, ARGV[1])
    score = full
  end
  return {'admitted', tostring(score)}
end
local rank = redis.call('ZRANK', KEYS[1], ARGV[1])
if not rank then return {'unknown'} end
redis.call('SET', KEYS[3], '1', 'PX', ARGV[4])
return {'waiting', rank, redis.call('ZCARD', KEYS[1])}
`;

export type QueueStatus =
  | { state: 'waiting'; position: number; ahead: number; etaSeconds: number; queueSize: number }
  | { state: 'admitted'; expiresAt: number }
  | { state: 'unknown' };

export interface WaitingRoomOptions {
  admitRatePerSec: number;
  maxActive: number;
  accessWindowSec: number;
  /** An admitted session must pick up its pass within this window or the slot is reclaimed. */
  claimWindowSec?: number;
  /** A waiting session that stops polling for this long is considered gone. */
  heartbeatSec?: number;
}

export class WaitingRoom {
  private readonly claimWindowMs: number;
  private readonly heartbeatMs: number;

  constructor(
    private readonly redis: Redis,
    private readonly opts: WaitingRoomOptions,
  ) {
    this.claimWindowMs = (opts.claimWindowSec ?? 30) * 1000;
    this.heartbeatMs = (opts.heartbeatSec ?? 20) * 1000;
  }

  static newSessionId(): string {
    return randomBytes(16).toString('base64url');
  }

  /**
   * @param heartbeatSec override for clients that can't poll (the crowd simulator's
   *   bots are "patient" so they don't each cost a Redis write per second).
   */
  async join(
    eventId: string,
    sessionId: string,
    now = Date.now(),
    heartbeatSec?: number,
  ): Promise<'joined' | 'waiting' | 'active'> {
    // Tie-break same-millisecond joins with a fractional component so ordering is stable.
    const score = now + Math.random() / 1000;
    return (await this.redis.eval(
      JOIN_LUA,
      4,
      keys.waiting(eventId),
      keys.active(eventId),
      keys.stats(eventId),
      keys.heartbeat(eventId, sessionId),
      sessionId,
      String(score),
      String(heartbeatSec ? heartbeatSec * 1000 : this.heartbeatMs),
    )) as 'joined' | 'waiting' | 'active';
  }

  async status(eventId: string, sessionId: string, now = Date.now()): Promise<QueueStatus> {
    const res = (await this.redis.eval(
      STATUS_LUA,
      4,
      keys.waiting(eventId),
      keys.active(eventId),
      keys.heartbeat(eventId, sessionId),
      keys.claimed(eventId),
      sessionId,
      String(now),
      String(this.opts.accessWindowSec * 1000),
      String(this.heartbeatMs),
    )) as [string, (string | number)?, number?];
    if (res[0] === 'admitted') return { state: 'admitted', expiresAt: Number(res[1]) };
    if (res[0] === 'unknown') return { state: 'unknown' };
    const rank = Number(res[1]);
    return {
      state: 'waiting',
      position: rank + 1,
      ahead: rank,
      queueSize: Number(res[2]),
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
      String(this.claimWindowMs),
      keys.heartbeat(eventId, ''),
    )) as string[];
  }

  /** Remove sessions that have given up waiting (e.g. after a sell-out). */
  async abandon(eventId: string, sessionIds: string[]): Promise<void> {
    if (sessionIds.length) await this.redis.zrem(keys.waiting(eventId), ...sessionIds);
  }

  /** All currently admitted sessions, in one round trip. */
  async activeSessions(eventId: string, now = Date.now()): Promise<Set<string>> {
    return new Set(await this.redis.zrangebyscore(keys.active(eventId), now, '+inf'));
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
      abandoned: Number(stats.abandoned ?? 0),
      admitRatePerSec: this.opts.admitRatePerSec,
      maxActive: this.opts.maxActive,
    };
  }
}
