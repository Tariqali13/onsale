import type { Services } from '../app.js';
import { resetEvent } from './reset.js';

/**
 * A public demo that someone sold out an hour ago greets every later visitor with
 * "Sold out". Once an event has been sold out for a while, the next visitor's page
 * load puts the seats back on sale. The delay leaves time to watch a sell-out
 * (e.g. on the Live ops page) before it resets.
 */
export const AUTO_RESET_AFTER_MS = 5 * 60_000;

export async function maybeAutoReset(
  s: Pick<Services, 'db' | 'redis' | 'events' | 'simulator'>,
  eventId: string,
  now = Date.now(),
): Promise<boolean> {
  const { rows } = await s.db.query<{ capacity: string; sold: string; last_sale: Date | null }>(
    `SELECT
       (SELECT count(*) FROM seats WHERE event_id = $1) AS capacity,
       (SELECT count(*) FROM order_seats os JOIN orders o ON o.id = os.order_id
         WHERE os.event_id = $1 AND o.status = 'paid') AS sold,
       (SELECT max(updated_at) FROM orders WHERE event_id = $1 AND status = 'paid') AS last_sale`,
    [eventId],
  );
  const r = rows[0];
  if (!r || Number(r.sold) < Number(r.capacity) || Number(r.capacity) === 0) return false;
  if (r.last_sale && now - r.last_sale.getTime() < AUTO_RESET_AFTER_MS) return false;

  // Several instances or concurrent page loads may get here at once: one resets.
  const locked = await s.redis.set(`lock:autoreset:{${eventId}}`, '1', 'PX', 30_000, 'NX');
  if (locked !== 'OK') return false;
  s.simulator.clear(eventId);
  await resetEvent(s, eventId);
  return true;
}
