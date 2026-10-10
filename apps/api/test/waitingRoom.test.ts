import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { WaitingRoom } from '../src/queue/waitingRoom.js';
import { startAdmitter } from '../src/queue/admitter.js';
import { reset, setup, type TestContext } from './helpers.js';

let ctx: TestContext;
let room: WaitingRoom;

beforeAll(async () => {
  ctx = await setup();
});
afterAll(() => ctx.close());
beforeEach(async () => {
  await reset(ctx);
  room = new WaitingRoom(ctx.redis, { admitRatePerSec: 10, maxActive: 25, accessWindowSec: 60 });
});

describe('WaitingRoom', () => {
  it('admits strictly in join order', async () => {
    const t0 = Date.now();
    const sessions = Array.from({ length: 30 }, (_, i) => `session_fifo_${String(i).padStart(4, '0')}`);
    for (const [i, s] of sessions.entries()) await room.join(ctx.eventId, s, t0 + i);

    const first = await room.admit(ctx.eventId, 1000, t0 + 100);
    expect(first).toEqual(sessions.slice(0, 10));
    const second = await room.admit(ctx.eventId, 1000, t0 + 1100);
    expect(second).toEqual(sessions.slice(10, 20));
  });

  it('never exceeds the active-session cap, and reuses capacity as windows expire', async () => {
    const t0 = Date.now();
    for (let i = 0; i < 100; i++) await room.join(ctx.eventId, `session_cap_${String(i).padStart(4, '0')}`, t0);

    let admitted = 0;
    for (let tick = 0; tick < 10; tick++) admitted += (await room.admit(ctx.eventId, 1000, t0 + tick * 1000)).length;
    expect(admitted).toBe(25); // capped at maxActive despite 10 ticks × 10/sec

    // After the 60s access window lapses, a full batch can come in again.
    const later = await room.admit(ctx.eventId, 1000, t0 + 61_000);
    expect(later).toHaveLength(10);
  });

  it('join is idempotent: rejoining keeps your place', async () => {
    const t0 = Date.now();
    await room.join(ctx.eventId, 'session_a_000000000', t0);
    await room.join(ctx.eventId, 'session_b_000000000', t0 + 1);
    expect(await room.join(ctx.eventId, 'session_a_000000000', t0 + 5000)).toBe('waiting');
    const status = await room.status(ctx.eventId, 'session_a_000000000');
    expect(status).toMatchObject({ state: 'waiting', position: 1 });
  });

  it('reports position, ETA and admission', async () => {
    for (let i = 0; i < 25; i++) await room.join(ctx.eventId, `session_eta_${String(i).padStart(4, '0')}`, Date.now() + i);
    expect(await room.status(ctx.eventId, 'session_eta_0024')).toMatchObject({ state: 'waiting', position: 25, etaSeconds: 3 });
    await room.admit(ctx.eventId, 1000);
    expect(await room.status(ctx.eventId, 'session_eta_0000')).toMatchObject({ state: 'admitted' });
    expect(await room.status(ctx.eventId, 'never-joined-xxxxxx')).toEqual({ state: 'unknown' });
  });

  it('release with grace only ever shortens the window', async () => {
    await room.join(ctx.eventId, 'session_grace_00000');
    await room.admit(ctx.eventId, 1000);
    const now = Date.now();
    await room.release(ctx.eventId, 'session_grace_00000', 5, now);
    expect(await room.isActive(ctx.eventId, 'session_grace_00000', now + 4000)).toBe(true);
    expect(await room.isActive(ctx.eventId, 'session_grace_00000', now + 6000)).toBe(false);
  });
});

describe('admitter leader election', () => {
  it('only one of several instances admits at a time', async () => {
    const noop = { info: () => undefined, error: () => undefined };
    let calls = 0;
    const counting = new Proxy(room, {
      get(target, prop, recv) {
        if (prop === 'admit') return async (...args: Parameters<WaitingRoom['admit']>) => (calls++, target.admit(...args));
        return Reflect.get(target, prop, recv);
      },
    });
    const stops = Array.from({ length: 3 }, () =>
      startAdmitter({ redis: ctx.redis, room: counting, listOpenEvents: async () => [ctx.eventId], log: noop, tickMs: 50 }),
    );
    await new Promise((r) => setTimeout(r, 520));
    await Promise.all(stops.map((s) => s()));
    // ~10 ticks of 50ms happened; with three instances, a split-brain would give ~30.
    expect(calls).toBeGreaterThanOrEqual(7);
    expect(calls).toBeLessThanOrEqual(12);
  });
});
