# Architecture

This document explains how Onsale behaves under load and failure, and where the
design would change for a production onsale.

## Responsibilities

| Store | Holds | Why there |
| --- | --- | --- |
| **Postgres** | Events, seats, orders, order seats, idempotency keys | System of record. Anything involving money, and the final answer on who owns a seat. |
| **Redis** | Queue, active shoppers, heartbeats, seat holds, sold-seat set | Fast, expiring, high-churn state. All of it can be rebuilt or safely lost. |

Redis is never the only thing standing between a buyer and a double sale. If Redis
were flushed mid-onsale: queue positions and carts would be lost (buyers re-queue), the
sold set is rebuilt from Postgres on the next read, and any checkout racing for a seat
that is already sold hits the `UNIQUE (event_id, seat_id)` constraint.

## Request path budget

The onsale has three hot paths. Each is designed to be cheap and constant-cost:

| Path | Cost per request |
| --- | --- |
| Queue poll | 1 Lua call (rank, heartbeat, claim) |
| Seat availability | 1 small `SMEMBERS` for the buyer's cart; the full seat-state snapshot is shared across all requests for 250 ms |
| Seat hold | 1 Lua call touching only the requested seats and the buyer's old cart |

Checkout is the only path that touches Postgres per request, and it is protected by
the waiting room: at most `MAX_ACTIVE_SESSIONS` people can be in it at once.

## Waiting room

- **Ordering.** A sorted set scored by arrival time. Rejoining is idempotent and keeps
  your place.
- **Admission.** One leader per deployment, elected with a compare-and-set Redis lock
  that is renewed every tick and expires after three. If the leader dies, another
  instance takes over within three seconds.
- **Capacity.** Admission computes free capacity (`maxActive − active`) and the batch
  size from the configured rate, atomically in Lua.
- **Ghosts.** A buyer who closes the tab must not take a slot from someone who is still
  there. Polling refreshes a 20 s heartbeat; the admitter drops sessions whose heartbeat
  lapsed. Admitted sessions get a 30 s claim window that becomes the full access window
  only when they poll and receive their pass. Load testing showed why: without this, the
  last 1,300 buyers in line waited minutes behind abandoned slots.
- **Sold out.** Once every seat is sold, waiting buyers are told immediately.

## Access passes

Once admitted, a buyer receives a short-lived HS256 JWT scoped to one event. Protected
routes verify it statelessly and then confirm the session is still in the active set,
so expiry and early release take effect immediately. A buyer who leaves (or completes a
purchase) gives their slot to the next person in line; after a purchase the pass stays
valid for 60 seconds so a lost response can still be retried and replayed.

## Seat holds

`PUT /cart` replaces the buyer's cart with exactly the requested seats:

1. For every requested seat: fail if it is sold, or held by someone else.
2. Release seats from the previous cart that are no longer wanted.
3. Set each requested seat's hold key (`PX` = hold TTL) and record the cart.

All of this happens inside one Lua script, so no other request can observe or
interleave with a half-applied cart.

## Checkout and idempotency

The idempotency record has three states: absent, `in_progress`, `completed`.

| Situation | Response |
| --- | --- |
| New key | Process the request |
| Same key, same body, completed | Replay the stored status and body |
| Same key, same body, still running | `409 request_in_progress` |
| Same key, different body | `422 idempotency_key_reused` |
| Failed before anything irreversible | Key deleted, so the client may retry |
| Failed after the order was created, outcome unknown | Key stays `in_progress`; the reconciler settles the order and completes the key |

The request hash covers what the client sent (event, seats, payment method), not server
state, so a retry after success still matches.

## Pricing

All amounts are integer cents. Fees are computed per ticket (12% service fee rounded
half up, plus a flat facility fee), so the all-in price shown on each seat sums exactly
to the order total. `verify:sales` re-prices every paid order after a load test.

## Observability

- Prometheus metrics: request latency by route and status, queue joins and admissions,
  hold outcomes, checkout outcomes and duration, tickets sold, Node.js runtime.
- A provisioned Grafana dashboard (`docker compose --profile observability up`).
- A `/stats` endpoint that powers the public Live ops page, including an oversell check
  computed in Postgres.
- Structured logs with request ids; authorization headers are redacted.

## Running on free tiers

The public demo runs on Render (API), Neon (Postgres), Upstash (Redis) and Vercel or
Netlify (web). Two choices exist only because of that:

- The admitter and reconciler **sleep when nobody is using the site**, so an idle demo
  spends zero Redis commands instead of ~170k a day on lock renewals.
- Rate limiting uses an in-memory store (`RATE_LIMIT_STORE=memory`), which is correct for
  a single instance and saves a Redis call per request.

## What I'd change for a real onsale

- **Queue in front of the origin.** Run the waiting room at the CDN edge (e.g. a Worker
  plus a durable store) so queued buyers never reach the API at all.
- **Pre-onsale randomisation.** People who arrive before the onsale opens would be
  shuffled at open time rather than ordered by arrival, so refreshing at 9:59:59 doesn't
  beat someone who waited patiently since 9:30.
- **Bot defence.** Proof-of-work or a CAPTCHA at queue entry, device fingerprinting, and
  per-account purchase limits enforced in Postgres.
- **Sharding by event.** Hash tags already keep each event's keys together; a large
  operator would shard Redis by event and run one admitter per shard.
- **Outbox for side effects.** Ticket emails and analytics would go through a
  transactional outbox written in the same transaction that marks the order paid.
- **Payment webhooks.** With Stripe, `payment_intent.succeeded` webhooks would settle
  orders sooner than polling in the reconciler.
