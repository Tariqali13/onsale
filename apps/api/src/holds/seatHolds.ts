import type { Redis } from 'ioredis';
import { keys } from '../lib/redis.js';

/**
 * Seat holds ("the cart").
 *
 * A session reserves an exact set of seats in a single atomic step: either every
 * requested seat is free and becomes held by this session, or nothing changes.
 * Partial holds are the classic source of "I picked 4 seats together and got 3".
 *
 * Holds are Redis keys with a TTL, so abandoned carts release themselves with no
 * cleanup job. Each key is `hold:{eventId}:<seatId>` → sessionId.
 *
 * Note on key access inside Lua: scripts derive hold-key names for the *previous*
 * cart from a prefix rather than receiving them in KEYS. All such keys share the
 * `{eventId}` hash tag, so they are guaranteed to be in the same cluster slot.
 */

// KEYS[1]=sold set, KEYS[2]=session cart set, KEYS[3..]=hold keys for requested seats
// ARGV[1]=session, ARGV[2]=ttlMs, ARGV[3]=hold key prefix, ARGV[4..]=requested seat ids
const HOLD_LUA = `
local session = ARGV[1]
local ttl = tonumber(ARGV[2])
local prefix = ARGV[3]
local n = #KEYS - 2
local wanted = {}
for i = 1, n do
  local seat = ARGV[i + 3]
  wanted[seat] = true
  if redis.call('SISMEMBER', KEYS[1], seat) == 1 then return {'sold', seat} end
  local owner = redis.call('GET', KEYS[i + 2])
  if owner and owner ~= session then return {'held', seat} end
end
-- Release seats from the previous cart that are no longer wanted.
for _, seat in ipairs(redis.call('SMEMBERS', KEYS[2])) do
  if not wanted[seat] then
    local k = prefix .. seat
    if redis.call('GET', k) == session then redis.call('DEL', k) end
  end
end
redis.call('DEL', KEYS[2])
for i = 1, n do
  redis.call('SET', KEYS[i + 2], session, 'PX', ttl)
  redis.call('SADD', KEYS[2], ARGV[i + 3])
end
if n > 0 then redis.call('PEXPIRE', KEYS[2], ttl) end
return {'ok'}
`;

// Confirms the session still owns every seat and extends the holds so they
// cannot expire while payment is in flight. Returns the seats it does NOT own.
// KEYS[1..n]=hold keys  ARGV[1]=session ARGV[2]=ttlMs ARGV[3..]=seat ids
const VERIFY_EXTEND_LUA = `
local missing = {}
for i = 1, #KEYS do
  if redis.call('GET', KEYS[i]) ~= ARGV[1] then missing[#missing + 1] = ARGV[i + 2] end
end
if #missing == 0 then
  for i = 1, #KEYS do redis.call('PEXPIRE', KEYS[i], ARGV[2]) end
end
return missing
`;

// Seats are paid for: mark sold, drop the holds and the cart.
// KEYS[1]=sold KEYS[2]=cart KEYS[3..]=hold keys  ARGV=seat ids
const COMMIT_LUA = `
for i = 3, #KEYS do redis.call('DEL', KEYS[i]) end
redis.call('SADD', KEYS[1], unpack(ARGV))
redis.call('DEL', KEYS[2])
return 1
`;

// KEYS[1]=cart  ARGV[1]=session ARGV[2]=prefix
const RELEASE_LUA = `
local released = 0
for _, seat in ipairs(redis.call('SMEMBERS', KEYS[1])) do
  local k = ARGV[2] .. seat
  if redis.call('GET', k) == ARGV[1] then redis.call('DEL', k) released = released + 1 end
end
redis.call('DEL', KEYS[1])
return released
`;

export type HoldResult =
  | { ok: true; seatIds: string[]; expiresAt: number }
  | { ok: false; reason: 'sold' | 'held'; seatId: string };

export type SeatState = 'available' | 'held' | 'mine' | 'sold';

export class SeatHolds {
  constructor(
    private readonly redis: Redis,
    private readonly ttlSec: number,
  ) {}

  private prefix(eventId: string) {
    return keys.hold(eventId, '');
  }

  /** Atomically replace the session's cart with exactly `seatIds`. Empty array clears the cart. */
  async hold(eventId: string, session: string, seatIds: string[], now = Date.now()): Promise<HoldResult> {
    const unique = [...new Set(seatIds)];
    const ttlMs = this.ttlSec * 1000;
    const res = (await this.redis.eval(
      HOLD_LUA,
      2 + unique.length,
      keys.sold(eventId),
      keys.sessionHolds(eventId, session),
      ...unique.map((s) => keys.hold(eventId, s)),
      session,
      String(ttlMs),
      this.prefix(eventId),
      ...unique,
    )) as [string, string?];
    if (res[0] === 'ok') return { ok: true, seatIds: unique, expiresAt: now + ttlMs };
    return { ok: false, reason: res[0] as 'sold' | 'held', seatId: res[1]! };
  }

  async cart(eventId: string, session: string): Promise<{ seatIds: string[]; expiresAt: number | null }> {
    const cartKey = keys.sessionHolds(eventId, session);
    const [seatIds, pttl] = await Promise.all([this.redis.smembers(cartKey), this.redis.pttl(cartKey)]);
    return { seatIds, expiresAt: pttl > 0 ? Date.now() + pttl : null };
  }

  /** Returns seats the session no longer holds. Empty array = all good, holds extended by `extendSec`. */
  async verifyAndExtend(eventId: string, session: string, seatIds: string[], extendSec: number): Promise<string[]> {
    return (await this.redis.eval(
      VERIFY_EXTEND_LUA,
      seatIds.length,
      ...seatIds.map((s) => keys.hold(eventId, s)),
      session,
      String(extendSec * 1000),
      ...seatIds,
    )) as string[];
  }

  async commitSold(eventId: string, session: string, seatIds: string[]): Promise<void> {
    if (seatIds.length === 0) return;
    await this.redis.eval(
      COMMIT_LUA,
      2 + seatIds.length,
      keys.sold(eventId),
      keys.sessionHolds(eventId, session),
      ...seatIds.map((s) => keys.hold(eventId, s)),
      ...seatIds,
    );
  }

  async release(eventId: string, session: string): Promise<number> {
    return (await this.redis.eval(
      RELEASE_LUA,
      1,
      keys.sessionHolds(eventId, session),
      session,
      this.prefix(eventId),
    )) as number;
  }

  /** Resolve the live state of every seat for the seat map. */
  async states(eventId: string, seatIds: string[], session?: string): Promise<Map<string, SeatState>> {
    const [sold, owners] = await Promise.all([
      this.redis.smembers(keys.sold(eventId)),
      seatIds.length ? this.redis.mget(seatIds.map((s) => keys.hold(eventId, s))) : Promise.resolve([]),
    ]);
    const soldSet = new Set(sold);
    const out = new Map<string, SeatState>();
    seatIds.forEach((id, i) => {
      const owner = owners[i];
      out.set(id, soldSet.has(id) ? 'sold' : owner ? (owner === session ? 'mine' : 'held') : 'available');
    });
    return out;
  }

  /** Rebuild the sold set from the system of record (cold start, Redis flush, or failover). */
  async loadSold(eventId: string, soldSeatIds: string[]): Promise<void> {
    const pipeline = this.redis.multi().del(keys.sold(eventId));
    if (soldSeatIds.length) pipeline.sadd(keys.sold(eventId), ...soldSeatIds);
    await pipeline.set(keys.soldLoaded(eventId), '1').exec();
  }

  async isSoldLoaded(eventId: string): Promise<boolean> {
    return (await this.redis.exists(keys.soldLoaded(eventId))) === 1;
  }

  async unmarkSold(eventId: string, seatIds: string[]): Promise<void> {
    if (seatIds.length) await this.redis.srem(keys.sold(eventId), ...seatIds);
  }
}
