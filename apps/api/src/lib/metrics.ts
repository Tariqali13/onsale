import client from 'prom-client';

export function createMetrics() {
  const registry = new client.Registry();
  client.collectDefaultMetrics({ register: registry });

  const httpDuration = new client.Histogram({
    name: 'onsale_http_request_duration_seconds',
    help: 'HTTP request latency',
    labelNames: ['method', 'route', 'status'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [registry],
  });
  const queueJoins = new client.Counter({
    name: 'onsale_queue_joins_total',
    help: 'Sessions that joined a waiting room',
    registers: [registry],
  });
  const queueAdmitted = new client.Counter({
    name: 'onsale_queue_admitted_total',
    help: 'Sessions admitted from the waiting room',
    registers: [registry],
  });
  const holdAttempts = new client.Counter({
    name: 'onsale_hold_attempts_total',
    help: 'Seat hold attempts by outcome',
    labelNames: ['result'] as const,
    registers: [registry],
  });
  const checkouts = new client.Counter({
    name: 'onsale_checkouts_total',
    help: 'Checkout attempts by outcome',
    labelNames: ['result'] as const,
    registers: [registry],
  });
  const checkoutDuration = new client.Histogram({
    name: 'onsale_checkout_duration_seconds',
    help: 'End-to-end checkout latency including payment',
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 4, 8],
    registers: [registry],
  });
  const ticketsSold = new client.Counter({
    name: 'onsale_tickets_sold_total',
    help: 'Tickets sold',
    registers: [registry],
  });

  return { registry, httpDuration, queueJoins, queueAdmitted, holdAttempts, checkouts, checkoutDuration, ticketsSold };
}

export type Metrics = ReturnType<typeof createMetrics>;
