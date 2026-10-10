import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { checkout } from '../src/checkout/checkout.js';
import { reconcilePending } from '../src/checkout/reconciler.js';
import type { ChargeRequest, ChargeResult, PaymentProvider } from '../src/payments/provider.js';
import { admitDirectly, firstSeats, reset, setup, type TestContext } from './helpers.js';

/** A provider we can make crash mid-charge, to exercise the reconciler. */
class ControllablePayments implements PaymentProvider {
  readonly name = 'controllable';
  failNext = false;
  readonly charged = new Map<string, ChargeResult>();
  async charge(req: ChargeRequest): Promise<ChargeResult> {
    const prior = this.charged.get(req.orderId);
    if (prior) return prior;
    const result: ChargeResult =
      req.paymentMethod === 'pm_card_chargeDeclined'
        ? { status: 'declined', reason: 'Your card was declined.' }
        : { status: 'succeeded', reference: `pi_${req.orderId}` };
    this.charged.set(req.orderId, result);
    if (this.failNext) {
      this.failNext = false;
      throw new Error('socket hang up'); // money moved, but we never heard back
    }
    return result;
  }
  async lookup(orderId: string) {
    return this.charged.get(orderId) ?? null;
  }
}

let ctx: TestContext;
const payments = new ControllablePayments();

beforeAll(async () => {
  ctx = await setup({}, payments);
});
afterAll(() => ctx.close());
beforeEach(async () => {
  await reset(ctx);
  payments.charged.clear();
});

const statusOf = (r: PromiseSettledResult<{ statusCode: number }>) =>
  r.status === 'fulfilled' ? r.value.statusCode : (r.reason as { statusCode?: number }).statusCode;

async function buy(session: string, seatIds: string[], opts: { key?: string; pm?: string; hold?: boolean } = {}) {
  if (opts.hold !== false) await ctx.services.holds.hold(ctx.eventId, session, seatIds);
  return checkout(ctx.services, {
    eventId: ctx.eventId,
    session,
    idempotencyKey: opts.key ?? randomUUID(),
    seatIds,
    paymentMethod: opts.pm ?? 'pm_card_visa',
  });
}

describe('checkout', () => {
  it('sells held seats and marks them sold', async () => {
    const seats = await firstSeats(ctx, 2);
    await admitDirectly(ctx, 'alice');
    const res = await buy('alice', seats);
    expect(res.statusCode).toBe(201);
    expect(res.body).toMatchObject({ status: 'paid', seatIds: [...seats].sort() });
    expect(await ctx.services.events.salesSummary(ctx.eventId)).toMatchObject({ paidOrders: 1, ticketsSold: 2 });
    const states = await ctx.services.holds.states(ctx.eventId, seats);
    expect([...states.values()]).toEqual(['sold', 'sold']);
  });

  it('rejects seats the buyer does not hold', async () => {
    const [a, b] = await firstSeats(ctx, 2);
    await ctx.services.holds.hold(ctx.eventId, 'bob', [b!]);
    const res = await buy('alice', [a!, b!], { hold: false });
    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ error: { code: 'hold_expired' } });
  });

  it('a declined card keeps the seats held so the buyer can retry', async () => {
    const seats = await firstSeats(ctx, 2);
    const declined = await buy('alice', seats, { pm: 'pm_card_chargeDeclined' });
    expect(declined.statusCode).toBe(402);
    const states = await ctx.services.holds.states(ctx.eventId, seats, 'alice');
    expect([...states.values()]).toEqual(['mine', 'mine']);
    const retry = await buy('alice', seats, { hold: false });
    expect(retry.statusCode).toBe(201);
  });

  describe('idempotency', () => {
    it('replays the original response for a retried request — one order, one charge', async () => {
      const seats = await firstSeats(ctx, 2);
      const key = randomUUID();
      const first = await buy('alice', seats, { key });
      const retry = await buy('alice', seats, { key, hold: false });
      expect(retry).toEqual(first);
      const { rows } = await ctx.db.query('SELECT count(*)::int AS n FROM orders');
      expect(rows[0].n).toBe(1);
    });

    it('concurrent duplicates: one runs, the rest get 409 or the replay', async () => {
      const seats = await firstSeats(ctx, 2);
      await ctx.services.holds.hold(ctx.eventId, 'alice', seats);
      const key = randomUUID();
      const results = (
        await Promise.allSettled(Array.from({ length: 10 }, () => buy('alice', seats, { key, hold: false })))
      ).map(statusOf);
      expect(results.filter((c) => c === 201).length).toBeGreaterThanOrEqual(1);
      expect(results.every((c) => c === 201 || c === 409)).toBe(true);
      const { rows } = await ctx.db.query('SELECT count(*)::int AS n FROM orders');
      expect(rows[0].n).toBe(1);
    });

    it('rejects reuse of a key with a different body', async () => {
      const [a, b] = await firstSeats(ctx, 2);
      const key = randomUUID();
      await buy('alice', [a!], { key });
      await expect(buy('alice', [b!], { key })).rejects.toMatchObject({ statusCode: 422 });
    });
  });

  describe('no oversell', () => {
    it('300 concurrent buyers, 40 seats: every seat sold exactly once', async () => {
      const seats = await firstSeats(ctx, 40);
      const buyers = Array.from({ length: 300 }, (_, i) => `buyer_${i}`);

      await Promise.all(
        buyers.map(async (session) => {
          // Each buyer wants 1–4 random seats from the same small pool.
          const want = [...seats].sort(() => Math.random() - 0.5).slice(0, 1 + Math.floor(Math.random() * 4));
          const held = await ctx.services.holds.hold(ctx.eventId, session, want);
          if (held.ok) await buy(session, want, { hold: false });
        }),
      );

      const { rows } = await ctx.db.query(
        `SELECT os.seat_id, count(*)::int AS n FROM order_seats os JOIN orders o ON o.id = os.order_id
         WHERE o.status = 'paid' GROUP BY os.seat_id`,
      );
      expect(rows.every((r) => r.n === 1)).toBe(true);
      expect((await ctx.services.events.salesSummary(ctx.eventId)).oversold).toBe(0);
    });

    it('the database still refuses a double sale even if Redis is wrong', async () => {
      // Simulate a Redis failover that lost holds: the hold check wrongly passes for everyone.
      const [seat] = await firstSeats(ctx, 1);
      const brokenHolds = Object.assign(Object.create(ctx.services.holds), { verifyAndExtend: async () => [] });
      const deps = { ...ctx.services, holds: brokenHolds };
      const attempt = (session: string) =>
        checkout(deps, { eventId: ctx.eventId, session, idempotencyKey: randomUUID(), seatIds: [seat!], paymentMethod: 'pm_card_visa' });

      const results = (await Promise.allSettled(Array.from({ length: 20 }, (_, i) => attempt(`ghost_${i}`)))).map(statusOf);
      expect(results.filter((c) => c === 201)).toHaveLength(1);
      expect(results.filter((c) => c === 409)).toHaveLength(19);
      expect((await ctx.services.events.salesSummary(ctx.eventId)).ticketsSold).toBe(1);
    });
  });

  describe('reconciler', () => {
    it('settles an order whose payment succeeded but whose response was lost', async () => {
      const seats = await firstSeats(ctx, 2);
      const key = randomUUID();
      payments.failNext = true;
      await expect(buy('alice', seats, { key })).rejects.toThrow('socket hang up');

      const { rows } = await ctx.db.query(`SELECT status FROM orders`);
      expect(rows[0].status).toBe('pending'); // we don't know yet: that's the point

      // A client retry while unresolved is told to wait, not charged again.
      await expect(buy('alice', seats, { key, hold: false })).rejects.toMatchObject({ statusCode: 409 });

      await ctx.db.query(`UPDATE orders SET created_at = now() - interval '5 minutes'`);
      expect(await reconcilePending(ctx.services)).toMatchObject({ paid: 1 });

      // The retried request now replays the settled result.
      const replay = await buy('alice', seats, { key, hold: false });
      expect(replay.statusCode).toBe(201);
      expect(payments.charged.size).toBe(1);
    });
  });
});
