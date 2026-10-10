import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SeatHolds } from '../src/holds/seatHolds.js';
import { firstSeats, reset, setup, type TestContext } from './helpers.js';

let ctx: TestContext;
let holds: SeatHolds;

beforeAll(async () => {
  ctx = await setup();
});
afterAll(() => ctx.close());
beforeEach(async () => {
  await reset(ctx);
  holds = new SeatHolds(ctx.redis, 300);
});

describe('SeatHolds', () => {
  it('holds a set of seats for one session', async () => {
    const seats = await firstSeats(ctx, 4);
    const res = await holds.hold(ctx.eventId, 'alice', seats);
    expect(res.ok).toBe(true);
    const states = await holds.states(ctx.eventId, seats, 'alice');
    expect([...states.values()]).toEqual(['mine', 'mine', 'mine', 'mine']);
    expect([...(await holds.states(ctx.eventId, seats, 'bob')).values()]).toEqual(['held', 'held', 'held', 'held']);
  });

  it('is all-or-nothing: one contested seat means no seats are taken', async () => {
    const [a, b, c, d] = await firstSeats(ctx, 4);
    await holds.hold(ctx.eventId, 'alice', [c!]);
    const res = await holds.hold(ctx.eventId, 'bob', [a!, b!, c!, d!]);
    expect(res).toEqual({ ok: false, reason: 'held', seatId: c });
    const states = await holds.states(ctx.eventId, [a!, b!, d!]);
    expect([...states.values()]).toEqual(['available', 'available', 'available']);
  });

  it('replaces the cart and releases seats no longer wanted', async () => {
    const [a, b, c] = await firstSeats(ctx, 3);
    await holds.hold(ctx.eventId, 'alice', [a!, b!]);
    await holds.hold(ctx.eventId, 'alice', [b!, c!]);
    const states = await holds.states(ctx.eventId, [a!, b!, c!], 'alice');
    expect(states.get(a!)).toBe('available');
    expect(states.get(b!)).toBe('mine');
    expect(states.get(c!)).toBe('mine');
    expect((await holds.cart(ctx.eventId, 'alice')).seatIds.sort()).toEqual([b!, c!].sort());
  });

  it('holds expire on their own', async () => {
    const short = new SeatHolds(ctx.redis, 1);
    const [a] = await firstSeats(ctx, 1);
    await short.hold(ctx.eventId, 'alice', [a!]);
    await new Promise((r) => setTimeout(r, 1200));
    expect((await short.hold(ctx.eventId, 'bob', [a!])).ok).toBe(true);
  });

  it('sold seats can never be held again', async () => {
    const [a] = await firstSeats(ctx, 1);
    await holds.hold(ctx.eventId, 'alice', [a!]);
    await holds.commitSold(ctx.eventId, 'alice', [a!]);
    expect(await holds.hold(ctx.eventId, 'bob', [a!])).toEqual({ ok: false, reason: 'sold', seatId: a });
    expect(await holds.hold(ctx.eventId, 'alice', [a!])).toEqual({ ok: false, reason: 'sold', seatId: a });
  });

  it('under 200 concurrent buyers racing for the same 2 seats, exactly one wins', async () => {
    const seats = await firstSeats(ctx, 2);
    const results = await Promise.all(
      Array.from({ length: 200 }, (_, i) => holds.hold(ctx.eventId, `racer_${i}`, seats)),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });

  it('verifyAndExtend reports seats the session lost', async () => {
    const [a, b] = await firstSeats(ctx, 2);
    await holds.hold(ctx.eventId, 'alice', [a!]);
    expect(await holds.verifyAndExtend(ctx.eventId, 'alice', [a!, b!], 60)).toEqual([b]);
    expect(await holds.verifyAndExtend(ctx.eventId, 'alice', [a!], 60)).toEqual([]);
  });
});
