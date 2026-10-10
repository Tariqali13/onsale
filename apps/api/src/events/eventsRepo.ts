import type { Db } from '../db/pool.js';
import type { SeatHolds } from '../holds/seatHolds.js';
import type { SectionLayout } from '../db/seed.js';
import { AppError } from '../lib/errors.js';

export interface EventRecord {
  id: string;
  slug: string;
  name: string;
  venue: string;
  startsAt: string;
  onsaleAt: string;
  layout: SectionLayout[];
}

export interface SeatRecord {
  id: string;
  section: string;
  row: string;
  number: number;
  priceCents: number;
}

/**
 * Events and seat inventory are effectively immutable during an onsale, so they
 * are cached in-process. The hot path (seat map polling) then costs one Redis
 * round trip and zero database queries.
 */
export class EventsRepo {
  private readonly seatCache = new Map<string, { seats: SeatRecord[]; byId: Map<string, SeatRecord> }>();
  private openEvents: { ids: string[]; fetchedAt: number } = { ids: [], fetchedAt: 0 };

  constructor(
    private readonly db: Db,
    private readonly holds: SeatHolds,
  ) {}

  async get(idOrSlug: string): Promise<EventRecord> {
    const isUuid = /^[0-9a-f-]{36}$/i.test(idOrSlug);
    const { rows } = await this.db.query(
      `SELECT id, slug, name, venue, starts_at, onsale_at, layout FROM events WHERE ${isUuid ? 'id' : 'slug'} = $1`,
      [idOrSlug],
    );
    const r = rows[0];
    if (!r) throw new AppError(404, 'event_not_found', 'Event not found');
    return {
      id: r.id,
      slug: r.slug,
      name: r.name,
      venue: r.venue,
      startsAt: r.starts_at.toISOString(),
      onsaleAt: r.onsale_at.toISOString(),
      layout: r.layout,
    };
  }

  async seats(eventId: string) {
    let cached = this.seatCache.get(eventId);
    if (!cached) {
      const { rows } = await this.db.query(
        `SELECT id, section, row_label, seat_number, price_cents FROM seats WHERE event_id = $1
         ORDER BY section, row_label, seat_number`,
        [eventId],
      );
      const seats: SeatRecord[] = rows.map((r) => ({
        id: r.id,
        section: r.section,
        row: r.row_label,
        number: r.seat_number,
        priceCents: r.price_cents,
      }));
      cached = { seats, byId: new Map(seats.map((s) => [s.id, s])) };
      this.seatCache.set(eventId, cached);
    }
    await this.ensureSoldLoaded(eventId);
    return cached;
  }

  /** Make sure Redis knows which seats are sold. Postgres is the source of truth. */
  async ensureSoldLoaded(eventId: string, force = false): Promise<void> {
    if (!force && (await this.holds.isSoldLoaded(eventId))) return;
    const { rows } = await this.db.query<{ seat_id: string }>(
      `SELECT os.seat_id FROM order_seats os JOIN orders o ON o.id = os.order_id
       WHERE os.event_id = $1 AND o.status = 'paid'`,
      [eventId],
    );
    await this.holds.loadSold(eventId, rows.map((r) => r.seat_id));
  }

  async listOpenEvents(): Promise<string[]> {
    if (Date.now() - this.openEvents.fetchedAt < 10_000) return this.openEvents.ids;
    const { rows } = await this.db.query<{ id: string }>(
      `SELECT id FROM events WHERE onsale_at <= now() AND starts_at > now()`,
    );
    this.openEvents = { ids: rows.map((r) => r.id), fetchedAt: Date.now() };
    return this.openEvents.ids;
  }

  async salesSummary(eventId: string) {
    const { rows } = await this.db.query(
      `SELECT
         count(*) FILTER (WHERE o.status = 'paid')                                   AS paid_orders,
         count(*) FILTER (WHERE o.status = 'failed')                                 AS failed_orders,
         count(*) FILTER (WHERE o.status = 'pending')                                AS pending_orders,
         COALESCE(sum(o.total_cents) FILTER (WHERE o.status = 'paid'), 0)            AS revenue_cents,
         (SELECT count(*) FROM order_seats os JOIN orders p ON p.id = os.order_id
           WHERE os.event_id = $1 AND p.status = 'paid')                              AS tickets_sold,
         (SELECT count(*) - count(DISTINCT os.seat_id) FROM order_seats os JOIN orders p ON p.id = os.order_id
           WHERE os.event_id = $1 AND p.status = 'paid')                              AS oversold
       FROM orders o WHERE o.event_id = $1`,
      [eventId],
    );
    const r = rows[0];
    return {
      paidOrders: Number(r.paid_orders),
      failedOrders: Number(r.failed_orders),
      pendingOrders: Number(r.pending_orders),
      revenueCents: Number(r.revenue_cents),
      ticketsSold: Number(r.tickets_sold),
      oversold: Number(r.oversold),
    };
  }
}
