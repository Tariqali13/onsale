import type { Db } from '../db/pool.js';
import type { Redis } from '../lib/redis.js';
import type { EventsRepo } from './eventsRepo.js';

/** Wipe all sales and live state for one event. Used by tests and the public demo. */
export async function resetEvent(s: { db: Db; redis: Redis; events: EventsRepo }, eventId: string): Promise<void> {
  await s.db.query('DELETE FROM idempotency_keys WHERE order_id IN (SELECT id FROM orders WHERE event_id = $1)', [eventId]);
  await s.db.query('DELETE FROM orders WHERE event_id = $1', [eventId]);

  for (const pattern of [`q:{${eventId}}:*`, `hold:{${eventId}}:*`, `holds:{${eventId}}:*`, `sold:{${eventId}}*`, `hb:{${eventId}}:*`]) {
    let cursor = '0';
    do {
      const [next, found] = await s.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
      cursor = next;
      if (found.length) await s.redis.unlink(...found);
    } while (cursor !== '0');
  }
  await s.events.ensureSoldLoaded(eventId, true);
}
