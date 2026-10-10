import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { reset, setup, type TestContext } from './helpers.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await setup({ MAX_ACTIVE_SESSIONS: '1000', ADMIT_RATE_PER_SEC: '1000' });
  await reset(ctx);
});
afterAll(() => ctx.close());

describe('crowd simulator', () => {
  it('a crowd larger than the venue sells it out exactly once, then leaves the line', async () => {
    const { services, eventId } = ctx;
    const capacity = (await services.events.seats(eventId)).seats.length;
    await services.simulator.spawn(eventId, 600);

    // Drive admission ourselves (no admitter loop in tests) until the bots are done.
    const deadline = Date.now() + 60_000;
    while (services.simulator.activeBots > 0 && Date.now() < deadline) {
      await services.room.admit(eventId, 1000);
      await new Promise((r) => setTimeout(r, 250));
    }

    const sales = await services.events.salesSummary(eventId);
    expect(services.simulator.activeBots).toBe(0);
    expect(sales.oversold).toBe(0);
    expect(sales.ticketsSold).toBeGreaterThan(capacity * 0.9);
    expect(sales.pendingOrders).toBe(0);
  }, 70_000);
});
