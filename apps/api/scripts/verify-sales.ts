/**
 * Post-load-test audit, straight against the system of record.
 * Exits non-zero if any seat was sold more than once or money and inventory disagree.
 */
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db/pool.js';
import { priceSeats } from '../src/checkout/pricing.js';

const db = createPool(loadConfig().DATABASE_URL);

const { rows: dupes } = await db.query(`
  SELECT os.seat_id, count(*)::int AS times_sold
    FROM order_seats os JOIN orders o ON o.id = os.order_id
   WHERE o.status = 'paid'
   GROUP BY os.seat_id HAVING count(*) > 1`);

const { rows: orders } = await db.query<{ id: string; total_cents: number; faces: number[] }>(`
  SELECT o.id, o.total_cents, array_agg(s.price_cents) AS faces
    FROM orders o JOIN order_seats os ON os.order_id = o.id JOIN seats s ON s.id = os.seat_id
   WHERE o.status = 'paid' GROUP BY o.id`);
const mispriced = orders.filter((o) => priceSeats(o.faces).totalCents !== o.total_cents);

const { rows: [summary] } = await db.query(`
  SELECT (SELECT count(*) FROM seats)::int AS capacity,
         (SELECT count(*) FROM order_seats os JOIN orders o ON o.id = os.order_id WHERE o.status = 'paid')::int AS sold,
         (SELECT count(*) FROM orders WHERE status = 'paid')::int AS paid_orders,
         (SELECT count(*) FROM orders WHERE status = 'failed')::int AS failed_orders,
         (SELECT count(*) FROM orders WHERE status = 'pending')::int AS pending_orders`);

console.table(summary);
console.log(`Seats sold more than once: ${dupes.length}`);
console.log(`Orders whose total does not match their seats: ${mispriced.length}`);
await db.end();
process.exit(dupes.length === 0 && mispriced.length === 0 ? 0 : 1);
