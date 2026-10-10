// k6 load test: a ticket onsale spike.
//
// Thousands of buyers arrive within seconds for a few hundred seats. Each virtual
// user does what a real buyer does: joins the waiting room, polls until admitted,
// loads the seat map, tries to hold seats (retrying on conflicts), and pays.
//
// Run against a local stack:
//   API:  RATE_LIMIT_ENABLED=false ADMIT_RATE_PER_SEC=150 MAX_ACTIVE_SESSIONS=400 npm run start -w @onsale/api
//   k6:   k6 run -e API=http://localhost:4000 load/onsale-spike.js
//
// Afterwards, `npm run verify:sales -w @onsale/api` checks the database for oversells.

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';

const API = __ENV.API || 'http://localhost:4000';
const EVENT = __ENV.EVENT || 'midnight-signal-live';
const BUYERS = Number(__ENV.BUYERS || 2000);

export const options = {
  scenarios: {
    onsale_spike: {
      executor: 'per-vu-iterations',
      vus: BUYERS,
      iterations: 1,
      maxDuration: '5m',
    },
  },
  thresholds: {
    // 409 (seat taken) and 402 (declined) are expected business outcomes, not failures.
    'http_req_failed{expected:no}': ['rate<0.01'],
    // Budgets for a single API process sharing 2 vCPUs with Postgres, Redis and k6 itself.
    'http_req_duration{op:hold}': ['p(95)<250'],
    'http_req_duration{op:availability}': ['p(95)<250'],
    'http_req_duration{op:queue_status}': ['p(95)<250'],
    // Includes ~150ms of simulated payment-provider latency.
    'http_req_duration{op:checkout}': ['p(95)<800'],
  },
};

const queueWait = new Trend('queue_wait_seconds', false);
const holdConflicts = new Counter('hold_conflicts');
const purchases = new Counter('purchases');
const ticketsBought = new Counter('tickets_bought');
const soldOutBuyers = new Counter('sold_out_buyers');

const JSON_HEADERS = { 'content-type': 'application/json' };

export function setup() {
  const eventId = http.get(`${API}/events/${EVENT}`).json('id');
  // The catalog is static and CDN-cacheable; a browser fetches it once.
  const catalog = http.get(`${API}/events/${eventId}/seats`).json('seats');
  return { eventId, catalog };
}

export default function ({ eventId, catalog }) {
  // Arrivals are bursty: most buyers land in the first few seconds.
  sleep(Math.random() ** 3 * 10);

  const join = http.post(`${API}/events/${eventId}/queue`, '{}', {
    headers: JSON_HEADERS,
    tags: { op: 'queue_join', expected: 'no' },
  });
  check(join, { 'joined queue': (r) => r.status === 200 });
  const sessionId = join.json('sessionId');
  const joinedAt = Date.now();

  let token = null;
  while (!token) {
    const st = http.get(`${API}/events/${eventId}/queue/${sessionId}`, { tags: { op: 'queue_status', expected: 'no' } });
    const state = st.json('state');
    if (state === 'admitted') token = st.json('accessToken');
    else if (state === 'sold_out') {
      soldOutBuyers.add(1);
      return;
    } else sleep(1 + Math.random());
    if (Date.now() - joinedAt > 240_000) return;
  }
  queueWait.add((Date.now() - joinedAt) / 1000);
  const auth = { ...JSON_HEADERS, authorization: `Bearer ${token}` };

  const want = 1 + Math.floor(Math.random() * 4);
  for (let attempt = 0; attempt < 4; attempt++) {
    const avail = http.get(`${API}/events/${eventId}/availability?session=${sessionId}`, {
      tags: { op: 'availability', expected: 'no' },
    });
    const seats = pickAdjacent(catalog, avail.json('states'), want);
    if (!seats) {
      soldOutBuyers.add(1);
      leave(eventId, auth);
      return;
    }
    sleep(0.3 + Math.random()); // human think-time on the seat map

    const hold = http.put(`${API}/events/${eventId}/cart`, JSON.stringify({ seatIds: seats }), {
      headers: auth,
      tags: { op: 'hold', expected: 'yes' },
      responseCallback: http.expectedStatuses(200, 409),
    });
    if (hold.status === 409) {
      holdConflicts.add(1);
      continue;
    }
    check(hold, { 'seats held': (r) => r.status === 200 });

    sleep(1 + Math.random() * 2); // entering payment details
    const pay = http.post(
      `${API}/events/${eventId}/checkout`,
      JSON.stringify({ seatIds: seats, paymentMethod: Math.random() < 0.05 ? 'pm_card_chargeDeclined' : 'pm_card_visa' }),
      {
        headers: { ...auth, 'idempotency-key': crypto.randomUUID() },
        tags: { op: 'checkout', expected: 'yes' },
        responseCallback: http.expectedStatuses(201, 402, 409),
      },
    );
    if (pay.status === 201) {
      purchases.add(1);
      ticketsBought.add(seats.length);
    } else {
      leave(eventId, auth);
    }
    return;
  }
  leave(eventId, auth); // gave up after repeated conflicts
}

// A real browser sends this on tab close / "leave"; it hands the slot to the next person in line.
function leave(eventId, headers) {
  http.post(`${API}/events/${eventId}/queue/leave`, '{}', { headers, tags: { op: 'leave', expected: 'no' } });
}

function pickAdjacent(catalog, states, count) {
  const rows = {};
  catalog.forEach((s, i) => (rows[`${s.section}|${s.row}`] ||= []).push({ id: s.id, free: states[i] === 'a' }));
  const keys = Object.keys(rows);
  const offset = Math.floor(Math.random() * keys.length);
  for (let want = count; want >= 1; want--) {
    for (let i = 0; i < keys.length; i++) {
      let run = [];
      for (const s of rows[keys[(i + offset) % keys.length]]) {
        run = s.free ? [...run, s.id] : [];
        if (run.length === want) return run;
      }
    }
  }
  return null;
}
