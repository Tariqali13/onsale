import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { reset, setup, type TestContext } from './helpers.js';

let ctx: TestContext;
let app: FastifyInstance;

beforeAll(async () => {
  ctx = await setup();
  app = await buildApp(ctx.services);
});
afterAll(async () => {
  await app.close();
  await ctx.close();
});
beforeEach(() => reset(ctx));

async function enterStore(): Promise<{ sessionId: string; token: string }> {
  const join = await app.inject({ method: 'POST', url: `/events/${ctx.eventId}/queue`, payload: {} });
  expect(join.statusCode).toBe(200);
  const { sessionId, state } = join.json();
  expect(state).toBe('waiting');
  await ctx.services.room.admit(ctx.eventId, 1000);
  const status = await app.inject({ url: `/events/${ctx.eventId}/queue/${sessionId}` });
  const body = status.json();
  expect(body.state).toBe('admitted');
  return { sessionId, token: body.accessToken };
}

describe('HTTP API', () => {
  it('resolves events by slug and serves the seat map', async () => {
    const event = (await app.inject({ url: '/events/midnight-signal-live' })).json();
    expect(event.id).toBe(ctx.eventId);
    const seats = (await app.inject({ url: `/events/${ctx.eventId}/seats` })).json().seats;
    expect(seats).toHaveLength(696);
    expect(seats[0]).toMatchObject({ state: 'available' });
  });

  it('blocks the cart and checkout for sessions that skipped the queue', async () => {
    const res = await app.inject({ method: 'PUT', url: `/events/${ctx.eventId}/cart`, payload: { seatIds: [] } });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('access_required');

    const forged = await app.inject({
      method: 'PUT',
      url: `/events/${ctx.eventId}/cart`,
      headers: { authorization: 'Bearer not.a.jwt' },
      payload: { seatIds: [] },
    });
    expect(forged.statusCode).toBe(401);
  });

  it('runs the full journey: queue → admitted → hold → pay → sold', async () => {
    const { sessionId, token } = await enterStore();
    const auth = { authorization: `Bearer ${token}` };
    const seats = (await app.inject({ url: `/events/${ctx.eventId}/seats` })).json().seats.slice(0, 2);
    const seatIds = seats.map((s: { id: string }) => s.id);

    const hold = await app.inject({ method: 'PUT', url: `/events/${ctx.eventId}/cart`, headers: auth, payload: { seatIds } });
    expect(hold.statusCode).toBe(200);

    const mine = (await app.inject({ url: `/events/${ctx.eventId}/seats?session=${sessionId}` })).json().seats;
    expect(mine.slice(0, 2).map((s: { state: string }) => s.state)).toEqual(['mine', 'mine']);

    const missingKey = await app.inject({
      method: 'POST',
      url: `/events/${ctx.eventId}/checkout`,
      headers: auth,
      payload: { seatIds, paymentMethod: 'pm_card_visa' },
    });
    expect(missingKey.statusCode).toBe(400);

    const key = randomUUID();
    const pay = () =>
      app.inject({
        method: 'POST',
        url: `/events/${ctx.eventId}/checkout`,
        headers: { ...auth, 'idempotency-key': key },
        payload: { seatIds, paymentMethod: 'pm_card_visa' },
      });
    const paid = await pay();
    expect(paid.statusCode).toBe(201);
    // Lost-response retry within the grace window replays rather than 401s.
    const replay = await pay();
    expect(replay.statusCode).toBe(201);
    expect(replay.json().orderId).toBe(paid.json().orderId);

    const stats = (await app.inject({ url: `/events/${ctx.eventId}/stats` })).json();
    expect(stats.sales).toMatchObject({ ticketsSold: 2, oversold: 0, paidOrders: 1 });
  });

  it('returns 409 with the contested seat when someone else holds it', async () => {
    const a = await enterStore();
    const b = await enterStore();
    const seatId = (await app.inject({ url: `/events/${ctx.eventId}/seats` })).json().seats[5].id;
    await app.inject({ method: 'PUT', url: `/events/${ctx.eventId}/cart`, headers: { authorization: `Bearer ${a.token}` }, payload: { seatIds: [seatId] } });
    const res = await app.inject({
      method: 'PUT',
      url: `/events/${ctx.eventId}/cart`,
      headers: { authorization: `Bearer ${b.token}` },
      payload: { seatIds: [seatId] },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: 'seat_held', seatId });
  });

  it('enforces the per-session seat limit', async () => {
    const { token } = await enterStore();
    const seatIds = (await app.inject({ url: `/events/${ctx.eventId}/seats` })).json().seats.slice(0, 9).map((s: { id: string }) => s.id);
    const res = await app.inject({ method: 'PUT', url: `/events/${ctx.eventId}/cart`, headers: { authorization: `Bearer ${token}` }, payload: { seatIds } });
    expect(res.statusCode).toBe(400);
  });

  it('only allows a public reset once the demo is nearly sold out', async () => {
    const res = await app.inject({ method: 'POST', url: `/events/${ctx.eventId}/reset` });
    expect(res.statusCode).toBe(403);
  });

  it('exposes Prometheus metrics and OpenAPI docs', async () => {
    expect((await app.inject({ url: '/metrics' })).body).toContain('onsale_checkouts_total');
    expect((await app.inject({ url: '/docs/json' })).json().paths).toHaveProperty('/events/{eventId}/checkout');
  });
});
