# 1. Redis for live state, Postgres for the truth

**Status:** accepted

## Context

During an onsale the system sees two very different kinds of state. Queue positions,
shoppers and seat holds change thousands of times a second and expire on their own.
Orders and payments change far less often and must never be lost or contradict each
other.

Putting holds in Postgres (`SELECT … FOR UPDATE` on seat rows) would serialise every
click on popular seats through row locks and turn seat browsing into database load.

## Decision

Keep high-churn, expiring state in Redis, manipulated only through Lua scripts so each
operation is atomic. Keep orders, order seats and idempotency keys in Postgres, and
make Postgres the final authority on seat ownership through
`UNIQUE (event_id, seat_id)` on `order_seats`.

## Consequences

- Seat holds cost one Redis round trip and never take a database lock.
- Losing Redis loses queue positions and carts, not sales. The sold set is rebuilt
  from Postgres.
- Two guards must agree for a sale to complete. The integration tests break the Redis
  guard on purpose to prove the database guard holds on its own.
