import { randomUUID } from 'node:crypto';
import type { WaitingRoom } from '../queue/waitingRoom.js';
import { WaitingRoom as WR } from '../queue/waitingRoom.js';
import type { SeatHolds } from '../holds/seatHolds.js';
import type { EventsRepo, SeatRecord } from '../events/eventsRepo.js';
import type { SeatMapCache } from '../events/seatMapCache.js';
import { checkout, type CheckoutDeps } from '../checkout/checkout.js';

interface Bot {
  session: string;
  eventId: string;
  stage: 'queued' | 'shopping' | 'done';
  attempts: number;
  nextActionAt: number;
}

/**
 * Synthetic crowd for the public demo. Bots go through exactly the same code
 * paths as real buyers — queue, atomic holds, idempotent checkout — so a demo
 * visitor competes with real contention and can watch the numbers on /ops.
 *
 * (Load testing over HTTP is done separately with k6; see /load.)
 */
export class CrowdSimulator {
  private bots: Bot[] = [];
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  static readonly MAX_BOTS = 3000;

  constructor(
    private readonly deps: CheckoutDeps & { room: WaitingRoom; holds: SeatHolds; events: EventsRepo; seatMap: SeatMapCache },
    private readonly log: { error: (o: object, msg: string) => void },
  ) {}

  get activeBots(): number {
    return this.bots.filter((b) => b.stage !== 'done').length;
  }

  async spawn(eventId: string, count: number): Promise<number> {
    if (await this.isSoldOut(eventId)) return 0;
    const room = Math.max(0, CrowdSimulator.MAX_BOTS - this.activeBots);
    const n = Math.min(count, room);
    const now = Date.now();
    const created: Bot[] = [];
    for (let i = 0; i < n; i++) {
      created.push({ session: `bot_${WR.newSessionId()}`, eventId, stage: 'queued', attempts: 0, nextActionAt: now });
    }
    for (const bot of created) await this.deps.room.join(eventId, bot.session, now + Math.random() * 50, 900);
    this.bots.push(...created);
    this.start();
    return n;
  }

  private async isSoldOut(eventId: string): Promise<boolean> {
    const [{ seats }, sold] = await Promise.all([this.deps.events.seats(eventId), this.deps.holds.soldCount(eventId)]);
    return sold >= seats.length;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  clear(eventId?: string): void {
    this.bots = eventId ? this.bots.filter((b) => b.eventId !== eventId) : [];
  }

  private start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.busy) return;
      this.busy = true;
      this.step()
        .catch((err) => this.log.error({ err }, 'simulator step failed'))
        .finally(() => (this.busy = false));
    }, 250);
  }

  private async step() {
    const now = Date.now();
    if (this.bots.length === 0) return this.stop();
    const events = [...new Set(this.bots.filter((b) => b.stage === 'queued').map((b) => b.eventId))];
    // Like real buyers told "sold out", queued bots leave the line at once.
    for (const e of events) {
      if (!(await this.isSoldOut(e))) continue;
      const leaving = this.bots.filter((b) => b.eventId === e && b.stage === 'queued');
      await this.deps.room.abandon(e, leaving.map((b) => b.session));
      for (const b of leaving) b.stage = 'done';
    }
    // One round trip per event tells every queued bot whether it has been admitted.
    const admitted = new Map(await Promise.all(events.map(async (e) => [e, await this.deps.room.activeSessions(e)] as const)));
    for (const bot of this.bots) {
      if (bot.stage === 'queued' && admitted.get(bot.eventId)?.has(bot.session)) {
        bot.stage = 'shopping';
        bot.nextActionAt = now + 800 + Math.random() * 2500; // "browsing the seat map"
      }
    }
    const due = this.bots.filter((b) => b.stage === 'shopping' && b.nextActionAt <= now).slice(0, 60);
    await Promise.all(due.map((b) => this.act(b, now)));
    this.bots = this.bots.filter((b) => b.stage !== 'done');
    if (this.bots.length === 0) this.stop();
  }

  private async act(bot: Bot, now: number) {
    const { seats } = await this.deps.events.seats(bot.eventId);
    const { states } = await this.deps.seatMap.snapshot(bot.eventId);
    const pick = pickAdjacent(seats, (id) => states.get(id) === 'available', 1 + Math.floor(Math.random() * 4));
    if (!pick) {
      bot.stage = 'done'; // sold out
      await this.deps.room.release(bot.eventId, bot.session);
      return;
    }
    const held = await this.deps.holds.hold(bot.eventId, bot.session, pick);
    if (!held.ok) {
      bot.attempts++;
      bot.nextActionAt = now + 300 + Math.random() * 700;
      if (bot.attempts >= 4) {
        bot.stage = 'done';
        await this.deps.holds.release(bot.eventId, bot.session);
        await this.deps.room.release(bot.eventId, bot.session);
      }
      return;
    }
    const declined = Math.random() < 0.08;
    const res = await checkout(this.deps, {
      eventId: bot.eventId,
      session: bot.session,
      idempotencyKey: randomUUID(),
      seatIds: pick,
      paymentMethod: declined ? 'pm_card_chargeDeclined' : 'pm_card_visa',
    });
    if (res.statusCode !== 201) {
      await this.deps.holds.release(bot.eventId, bot.session);
      await this.deps.room.release(bot.eventId, bot.session);
    }
    bot.stage = 'done';
  }
}

/** Find `count` adjacent available seats in one row, starting from a random row. */
export function pickAdjacent(seats: SeatRecord[], isFree: (id: string) => boolean, count: number): string[] | null {
  const rows = new Map<string, SeatRecord[]>();
  for (const s of seats) {
    const key = `${s.section}|${s.row}`;
    if (!rows.has(key)) rows.set(key, []);
    rows.get(key)!.push(s);
  }
  const rowList = [...rows.values()];
  const offset = Math.floor(Math.random() * rowList.length);
  for (let want = count; want >= 1; want--) {
    for (let i = 0; i < rowList.length; i++) {
      const row = rowList[(i + offset) % rowList.length]!;
      let run: string[] = [];
      for (const s of row) {
        run = isFree(s.id) ? [...run, s.id] : [];
        if (run.length === want) return run;
      }
    }
  }
  return null;
}
