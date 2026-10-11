import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AUTO_RESET_AFTER_MS, maybeAutoReset } from '../src/events/autoReset.js';
import { reset, setup, type TestContext } from './helpers.js';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await setup();
});
afterAll(() => ctx.close());
beforeEach(() => reset(ctx));

/** Sell `count` seats in one paid order, last updated `agoMs` ago. */
async function sell(count: number, agoMs: number) {
  const { rows } = await ctx.db.query<{ id: string }>(
    `INSERT INTO orders (event_id, session_id, status, subtotal_cents, fees_cents, total_cents, updated_at)
     VALUES ($1, 'test', 'paid', 0, 0, 0, now() - make_interval(secs => $2)) RETURNING id`,
    [ctx.eventId, agoMs / 1000],
  );
  await ctx.db.query(
    `INSERT INTO order_seats (order_id, event_id, seat_id)
     SELECT $1, $2, id FROM seats WHERE event_id = $2 ORDER BY id LIMIT $3`,
    [rows[0]!.id, ctx.eventId, count],
  );
}

const sold = async () => (await ctx.services.events.salesSummary(ctx.eventId)).ticketsSold;

describe('auto-reset of a sold-out demo', () => {
  it('leaves a fresh sell-out alone so people can watch it', async () => {
    await sell(696, 60_000);
    expect(await maybeAutoReset(ctx.services, ctx.eventId)).toBe(false);
    expect(await sold()).toBe(696);
  });

  it('puts the seats back on sale once it has been sold out for a while', async () => {
    await sell(696, AUTO_RESET_AFTER_MS + 60_000);
    expect(await maybeAutoReset(ctx.services, ctx.eventId)).toBe(true);
    expect(await sold()).toBe(0);
    expect(await ctx.services.holds.soldCount(ctx.eventId)).toBe(0);
  });

  it('never resets an onsale that still has seats, however old the last sale', async () => {
    await sell(695, AUTO_RESET_AFTER_MS * 10);
    expect(await maybeAutoReset(ctx.services, ctx.eventId)).toBe(false);
    expect(await sold()).toBe(695);
  });

  it('resets only once when several visitors arrive together', async () => {
    await sell(696, AUTO_RESET_AFTER_MS + 60_000);
    const results = await Promise.all([1, 2, 3, 4].map(() => maybeAutoReset(ctx.services, ctx.eventId)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await sold()).toBe(0);
  });
});
