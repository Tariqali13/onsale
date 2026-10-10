import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { keys } from '../lib/redis.js';
import type { WaitingRoom } from './waitingRoom.js';

// Acquire or renew the lock only if we already own it (compare-and-set).
const RENEW_LUA = `
local cur = redis.call('GET', KEYS[1])
if cur == false then
  redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
  return 1
elseif cur == ARGV[1] then
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
  return 1
end
return 0
`;

export interface AdmitterDeps {
  redis: Redis;
  room: WaitingRoom;
  /** Returns the ids of events whose onsale window is open. */
  listOpenEvents: () => Promise<string[]>;
  onAdmitted?: (eventId: string, count: number) => void;
  log: { info: (o: object, msg: string) => void; error: (o: object, msg: string) => void };
  tickMs?: number;
}

/**
 * Runs the admission loop on exactly one instance at a time.
 *
 * Every API instance runs this, but only the holder of a short-lived Redis lock
 * admits anyone. If the leader dies, its lock expires within `3 * tickMs` and
 * another instance takes over — no coordinator service required.
 */
export function startAdmitter(deps: AdmitterDeps): () => Promise<void> {
  const tickMs = deps.tickMs ?? 1000;
  const instanceId = randomUUID();
  let stopped = false;
  let isLeader = false;
  let running: Promise<void> = Promise.resolve();

  const tick = async () => {
    const owned = (await deps.redis.eval(RENEW_LUA, 1, keys.admitterLock(), instanceId, String(tickMs * 3))) === 1;
    if (owned !== isLeader) {
      isLeader = owned;
      deps.log.info({ instanceId, leader: owned }, owned ? 'admitter: became leader' : 'admitter: lost leadership');
    }
    if (!owned) return;
    for (const eventId of await deps.listOpenEvents()) {
      const admitted = await deps.room.admit(eventId, tickMs);
      if (admitted.length > 0) deps.onAdmitted?.(eventId, admitted.length);
    }
  };

  const timer = setInterval(() => {
    if (stopped) return;
    running = tick().catch((err) => deps.log.error({ err }, 'admitter tick failed'));
  }, tickMs);

  return async () => {
    stopped = true;
    clearInterval(timer);
    await running;
    // Hand leadership over immediately rather than waiting for expiry.
    await deps.redis
      .eval(`if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`, 1, keys.admitterLock(), instanceId)
      .catch(() => undefined);
  };
}
