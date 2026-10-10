import type { Db } from '../db/pool.js';
import { withTx } from '../db/pool.js';
import type { SeatHolds } from '../holds/seatHolds.js';
import type { WaitingRoom } from '../queue/waitingRoom.js';
import type { PaymentProvider } from '../payments/provider.js';
import { AppError, isUniqueViolation } from '../lib/errors.js';
import type { Metrics } from '../lib/metrics.js';
import { hashRequest, type IdempotencyStore, type StoredResponse } from './idempotency.js';
import { priceSeats } from './pricing.js';

/** Extra time holds get while payment is in flight, so they can't expire mid-charge. */
const PAYMENT_GRACE_SEC = 120;

export interface CheckoutInput {
  eventId: string;
  session: string;
  idempotencyKey: string;
  /** The seats the buyer believes they are paying for. Must all be held by this session. */
  seatIds: string[];
  paymentMethod: string;
}

export interface CheckoutDeps {
  db: Db;
  holds: SeatHolds;
  room: WaitingRoom;
  payments: PaymentProvider;
  idempotency: IdempotencyStore;
  metrics: Metrics;
}

/**
 * Checkout, in the order that keeps money and inventory consistent:
 *
 *  1. Claim the idempotency key           → retries can never double-charge
 *  2. Verify + extend the Redis holds      → fast rejection, holds can't lapse mid-payment
 *  3. INSERT order + order_seats (pending) → UNIQUE(event_id, seat_id) is the hard no-oversell guarantee
 *  4. Charge, keyed by order id            → provider-side idempotency as well
 *  5. Mark paid / failed, settle Redis     → seats become sold, or return to the buyer's cart
 *
 * If the process dies between 3 and 5, the order stays 'pending' and the
 * reconciler settles it by asking the payment provider what actually happened.
 */
export async function checkout(deps: CheckoutDeps, input: CheckoutInput): Promise<StoredResponse> {
  const { db, holds, idempotency, metrics } = deps;
  const { eventId, session, idempotencyKey, paymentMethod } = input;
  const stop = metrics.checkoutDuration.startTimer();

  // Hash the request as sent (not server state), so a retry after success still matches and replays.
  const seatIds = [...new Set(input.seatIds)].sort();
  const requestHash = hashRequest({ eventId, seatIds, paymentMethod });

  const begun = await idempotency.begin(session, idempotencyKey, requestHash);
  if (begun.kind === 'replay') {
    metrics.checkouts.inc({ result: 'replayed' });
    return begun.response;
  }

  let orderId: string | null = null;
  try {
    if (seatIds.length === 0) throw new AppError(400, 'no_seats', 'Select at least one seat to check out.');

    const missing = await holds.verifyAndExtend(eventId, session, seatIds, PAYMENT_GRACE_SEC + 60);
    if (missing.length > 0) {
      throw new AppError(409, 'hold_expired', 'Some of your seats are no longer held.', { seatIds: missing });
    }

    const { rows: seats } = await db.query<{ id: string; price_cents: number }>(
      'SELECT id, price_cents FROM seats WHERE event_id = $1 AND id = ANY($2::uuid[])',
      [eventId, seatIds],
    );
    if (seats.length !== seatIds.length) throw new AppError(400, 'invalid_seats', 'One or more seats do not exist');
    const price = priceSeats(seats.map((s) => s.price_cents));

    try {
      orderId = await withTx(db, async (tx) => {
        const { rows } = await tx.query<{ id: string }>(
          `INSERT INTO orders (event_id, session_id, subtotal_cents, fees_cents, total_cents)
           VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [eventId, session, price.subtotalCents, price.feesCents, price.totalCents],
        );
        const id = rows[0]!.id;
        await tx.query(
          `INSERT INTO order_seats (order_id, event_id, seat_id) SELECT $1, $2, unnest($3::uuid[])`,
          [id, eventId, seatIds],
        );
        return id;
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        metrics.checkouts.inc({ result: 'conflict' });
        throw new AppError(409, 'seats_unavailable', 'One or more of your seats were just purchased by someone else.');
      }
      throw err;
    }
    await idempotency.attachOrder(session, idempotencyKey, orderId);

    const charge = await deps.payments.charge({
      orderId,
      amountCents: price.totalCents,
      currency: 'usd',
      paymentMethod,
    });

    let response: StoredResponse;
    if (charge.status === 'succeeded') {
      await markPaid(deps, { orderId, eventId, session, seatIds, reference: charge.reference });
      metrics.checkouts.inc({ result: 'paid' });
      response = {
        statusCode: 201,
        body: { orderId, status: 'paid', seatIds, ...price, paymentReference: charge.reference },
      };
    } else {
      await markFailed(deps, { orderId, eventId, reason: charge.reason, seatIds });
      metrics.checkouts.inc({ result: 'declined' });
      response = {
        statusCode: 402,
        body: { error: { code: 'payment_declined', message: charge.reason }, orderId, status: 'failed' },
      };
    }
    await idempotency.complete(session, idempotencyKey, response);
    return response;
  } catch (err) {
    if (err instanceof AppError) {
      const response = { statusCode: err.statusCode, body: { error: { code: err.code, message: err.message, ...err.details } } };
      if (orderId) await idempotency.complete(session, idempotencyKey, response);
      else await idempotency.abandon(session, idempotencyKey); // nothing irreversible happened; allow retry
      if (err.code !== 'seats_unavailable') metrics.checkouts.inc({ result: err.code });
      return response;
    }
    // Unknown failure. If an order exists, payment state is unknown: leave the key
    // in_progress and let the reconciler settle it. Otherwise free the key.
    if (!orderId) await idempotency.abandon(session, idempotencyKey).catch(() => undefined);
    metrics.checkouts.inc({ result: 'error' });
    throw err;
  } finally {
    stop();
  }
}

export async function markPaid(
  deps: Pick<CheckoutDeps, 'db' | 'holds' | 'room' | 'metrics'>,
  o: { orderId: string; eventId: string; session: string; seatIds: string[]; reference: string },
): Promise<void> {
  await deps.db.query(
    `UPDATE orders SET status = 'paid', payment_ref = $2, updated_at = now() WHERE id = $1 AND status = 'pending'`,
    [o.orderId, o.reference],
  );
  await deps.holds.commitSold(o.eventId, o.session, o.seatIds);
  await deps.room.release(o.eventId, o.session, 60); // free the slot for the next person in line, after a short grace
  deps.metrics.ticketsSold.inc(o.seatIds.length);
}

export async function markFailed(
  deps: Pick<CheckoutDeps, 'db' | 'holds'>,
  o: { orderId: string; eventId: string; reason: string; seatIds: string[] },
): Promise<void> {
  // Deleting order_seats frees the UNIQUE slots; the buyer's Redis holds are
  // still in place, so they can retry with another card without losing seats.
  await withTx(deps.db, async (tx) => {
    await tx.query('DELETE FROM order_seats WHERE order_id = $1', [o.orderId]);
    await tx.query(
      `UPDATE orders SET status = 'failed', failure_reason = $2, updated_at = now() WHERE id = $1 AND status = 'pending'`,
      [o.orderId, o.reason],
    );
  });
  await deps.holds.unmarkSold(o.eventId, o.seatIds);
}
