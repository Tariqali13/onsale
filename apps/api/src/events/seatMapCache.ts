import type { SeatHolds, SeatState } from '../holds/seatHolds.js';
import type { EventsRepo } from './eventsRepo.js';

interface Snapshot {
  states: Map<string, SeatState>;
  /** One character per seat, in catalog order: a = available, h = held, s = sold. */
  code: string;
  available: number;
  sold: number;
  at: number;
}

const CODE: Record<SeatState, string> = { available: 'a', held: 'h', mine: 'h', sold: 's' };

/**
 * Micro-cache for the seat map.
 *
 * During an onsale every admitted shopper polls the seat map. Resolving ~700 seat
 * states costs a Redis MGET; doing that per request makes Redis load grow with the
 * number of shoppers. Instead, one snapshot is built per event at most every
 * `ttlMs` (with single-flight, so a burst of requests triggers one fetch). Each
 * shopper's own held seats come from their small cart set and are overlaid client-side.
 *
 * Staleness is bounded by `ttlMs` and is harmless: the authoritative check is the
 * atomic hold, which returns 409 if a seat was taken in the meantime.
 */
export class SeatMapCache {
  private readonly snapshots = new Map<string, Snapshot>();
  private readonly inflight = new Map<string, Promise<Snapshot>>();

  constructor(
    private readonly events: EventsRepo,
    private readonly holds: SeatHolds,
    private readonly ttlMs = 250,
  ) {}

  async snapshot(eventId: string, now = Date.now()): Promise<Snapshot> {
    const cached = this.snapshots.get(eventId);
    if (cached && now - cached.at < this.ttlMs) return cached;
    let pending = this.inflight.get(eventId);
    if (!pending) {
      pending = this.build(eventId).finally(() => this.inflight.delete(eventId));
      this.inflight.set(eventId, pending);
    }
    return pending;
  }

  invalidate(eventId: string): void {
    this.snapshots.delete(eventId);
  }

  private async build(eventId: string): Promise<Snapshot> {
    const { seats } = await this.events.seats(eventId);
    const states = await this.holds.states(eventId, seats.map((s) => s.id));
    let available = 0;
    let sold = 0;
    let code = '';
    for (const seat of seats) {
      const st = states.get(seat.id)!;
      if (st === 'available') available++;
      else if (st === 'sold') sold++;
      code += CODE[st];
    }
    const snap = { states, code, available, sold, at: Date.now() };
    this.snapshots.set(eventId, snap);
    return snap;
  }
}
