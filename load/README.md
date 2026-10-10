# Load testing

`onsale-spike.js` is a [k6](https://k6.io) scenario that reproduces the shape of a real onsale:
far more buyers than seats, almost all arriving in the first few seconds.

Every virtual user behaves like a person:

1. joins the waiting room and polls until admitted (or told the show is sold out);
2. loads the seat map and tries to hold 1–4 adjacent seats, retrying on conflicts;
3. "types card details" for a couple of seconds and pays (5% of cards are declined);
4. leaves the store, releasing their slot to the next person in line.

## Run it

```bash
docker compose up -d postgres redis
npm run build -w @onsale/api
./apps/api/scripts/start-loadtest-api.sh          # rate limiting off: all VUs share one IP
k6 run -e API=http://localhost:4000 -e BUYERS=2000 load/onsale-spike.js
npm run verify:sales -w @onsale/api               # audits Postgres for oversells and pricing errors
```

## Latest result

2,000 buyers competing for 696 seats. One API process, Postgres 16, Redis 7 and k6 itself
all on the **same 2 vCPU machine** (CPU was ~90% busy during the spike, so tail latencies
include contention from the load generator).

| Outcome | Value |
| --- | --- |
| Seats sold | **696 / 696** (sold out in ~20 s) |
| Seats sold more than once | **0** |
| Orders whose total ≠ their seats | **0** |
| Unexpected HTTP errors | **0** of 24,251 requests |
| Successful purchases | 291 orders (20 declined cards, all seats re-sold) |
| Hold conflicts handled | 1,597 (expected: many buyers want the same seats) |
| Buyers told "sold out" instead of waiting | 1,418 |
| Peak throughput | ~1,100 req/s |

| Latency | median | p95 |
| --- | --- | --- |
| Queue status poll | 4 ms | 139 ms |
| Seat availability | 5 ms | 184 ms |
| Atomic seat hold | 8 ms | 168 ms |
| Checkout (incl. ~150 ms simulated payment) | 173 ms | 327 ms |
| Time in waiting room | 7.9 s | 17.7 s |

Settings: `ADMIT_RATE_PER_SEC=150`, `MAX_ACTIVE_SESSIONS=400`, `HOLD_TTL_SEC=300`.

## What changed because of load testing

The first runs looked fine on correctness (no oversells) but exposed two real problems:

- **Ghost sessions starved the queue.** Buyers who gave up while waiting were still
  admitted later and sat on a shopping slot for the full 10-minute window, so the
  last 1,300 buyers waited minutes for nothing. Fix: waiting sessions keep a heartbeat
  by polling; the admitter skips sessions whose heartbeat lapsed, and an admitted
  session must claim its pass within 30 s or the slot is reclaimed. A `sold_out` queue
  state now tells waiting buyers the truth immediately.
- **The seat map was the hottest endpoint.** Every shopper polling ~60 KB of JSON
  (and one 700-key `MGET` each) saturated the event loop: p95 > 1 s. Fix: split the
  static, cacheable **catalog** from a compact **availability** string (1 byte per seat)
  built from a shared 250 ms snapshot with single-flight. Redis load no longer grows
  with the number of shoppers.
