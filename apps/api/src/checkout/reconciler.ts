import type { CheckoutDeps } from './checkout.js';
import { markFailed, markPaid } from './checkout.js';

/** Pending orders older than this are investigated. Normal checkouts settle in seconds. */
const STALE_AFTER_SEC = 90;
/** If the provider still has no record after this long, the charge never happened. */
const GIVE_UP_AFTER_SEC = 15 * 60;

interface PendingRow {
  id: string;
  event_id: string;
  session_id: string;
  age_sec: number;
  seat_ids: string[];
}

/**
 * Settles orders stuck in 'pending' — the API crashed, the payment call timed out,
 * or the network dropped after the provider charged the card. The provider is
 * the source of truth for whether money moved; we converge our state to it.
 */
export async function reconcilePending(
  deps: Pick<CheckoutDeps, 'db' | 'holds' | 'room' | 'payments' | 'idempotency' | 'metrics'>,
): Promise<{ paid: number; failed: number; unresolved: number }> {
  const { rows } = await deps.db.query<PendingRow>(
    `SELECT o.id, o.event_id, o.session_id,
            EXTRACT(EPOCH FROM now() - o.created_at)::int AS age_sec,
            COALESCE(array_agg(os.seat_id::text) FILTER (WHERE os.seat_id IS NOT NULL), '{}') AS seat_ids
       FROM orders o LEFT JOIN order_seats os ON os.order_id = o.id
      WHERE o.status = 'pending' AND o.created_at < now() - make_interval(secs => $1)
      GROUP BY o.id
      LIMIT 100`,
    [STALE_AFTER_SEC],
  );

  const tally = { paid: 0, failed: 0, unresolved: 0 };
  for (const o of rows) {
    const result = await deps.payments.lookup(o.id);
    if (result?.status === 'succeeded') {
      await markPaid(deps, { orderId: o.id, eventId: o.event_id, session: o.session_id, seatIds: o.seat_ids, reference: result.reference });
      await deps.idempotency.completeByOrder(o.id, {
        statusCode: 201,
        body: { orderId: o.id, status: 'paid', seatIds: o.seat_ids, paymentReference: result.reference },
      });
      tally.paid++;
    } else if (result?.status === 'declined' || o.age_sec > GIVE_UP_AFTER_SEC) {
      const reason = result?.status === 'declined' ? result.reason : 'Payment could not be confirmed';
      await markFailed(deps, { orderId: o.id, eventId: o.event_id, reason, seatIds: o.seat_ids });
      await deps.idempotency.completeByOrder(o.id, {
        statusCode: 402,
        body: { error: { code: 'payment_declined', message: reason }, orderId: o.id, status: 'failed' },
      });
      tally.failed++;
    } else {
      tally.unresolved++;
    }
  }
  return tally;
}
