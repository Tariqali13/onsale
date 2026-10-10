import type { Db } from './pool.js';

export interface SectionLayout {
  id: string;
  name: string;
  tier: 'floor' | 'lower' | 'upper';
  priceCents: number;
  rows: number;
  seatsPerRow: number;
  /** Centre of the section on a 1000x700 canvas, and rotation in degrees (facing the stage). */
  x: number;
  y: number;
  rotate: number;
}

export const DEMO_EVENT_SLUG = 'midnight-signal-live';

/** A fictional arena layout: two floor blocks, a lower bowl and an upper bowl. */
export const DEMO_LAYOUT: SectionLayout[] = [
  { id: 'FL-A', name: 'Floor A', tier: 'floor', priceCents: 18900, rows: 6, seatsPerRow: 12, x: 400, y: 250, rotate: 0 },
  { id: 'FL-B', name: 'Floor B', tier: 'floor', priceCents: 18900, rows: 6, seatsPerRow: 12, x: 600, y: 250, rotate: 0 },
  { id: '101', name: 'Section 101', tier: 'lower', priceCents: 12900, rows: 7, seatsPerRow: 10, x: 165, y: 300, rotate: -32 },
  { id: '102', name: 'Section 102', tier: 'lower', priceCents: 12900, rows: 7, seatsPerRow: 14, x: 380, y: 420, rotate: 0 },
  { id: '103', name: 'Section 103', tier: 'lower', priceCents: 12900, rows: 7, seatsPerRow: 14, x: 620, y: 420, rotate: 0 },
  { id: '104', name: 'Section 104', tier: 'lower', priceCents: 12900, rows: 7, seatsPerRow: 10, x: 835, y: 300, rotate: 32 },
  { id: '201', name: 'Section 201', tier: 'upper', priceCents: 6900, rows: 6, seatsPerRow: 18, x: 300, y: 575, rotate: -8 },
  { id: '202', name: 'Section 202', tier: 'upper', priceCents: 6900, rows: 6, seatsPerRow: 18, x: 700, y: 575, rotate: 8 },
];

const ROW_LABELS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

export async function seedDemo(db: Db, opts: { onsaleInSec?: number } = {}): Promise<string> {
  const onsaleAt = new Date(Date.now() + (opts.onsaleInSec ?? 0) * 1000);
  const startsAt = new Date(Date.now() + 30 * 24 * 3600 * 1000);

  const existing = await db.query<{ id: string }>('SELECT id FROM events WHERE slug = $1', [DEMO_EVENT_SLUG]);
  if (existing.rows[0]) return existing.rows[0].id;

  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO events (slug, name, venue, starts_at, onsale_at, layout)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [DEMO_EVENT_SLUG, 'Midnight Signal — Live in Concert', 'Harbourfront Arena', startsAt, onsaleAt, JSON.stringify(DEMO_LAYOUT)],
  );
  const eventId = rows[0]!.id;

  // Bulk insert all seats in one statement via unnest.
  const sections: string[] = [];
  const rowLabels: string[] = [];
  const numbers: number[] = [];
  const prices: number[] = [];
  for (const s of DEMO_LAYOUT) {
    for (let r = 0; r < s.rows; r++) {
      for (let n = 1; n <= s.seatsPerRow; n++) {
        sections.push(s.id);
        rowLabels.push(ROW_LABELS[r]!);
        numbers.push(n);
        prices.push(s.priceCents);
      }
    }
  }
  await db.query(
    `INSERT INTO seats (event_id, section, row_label, seat_number, price_cents)
     SELECT $1, * FROM unnest($2::text[], $3::text[], $4::int[], $5::int[])`,
    [eventId, sections, rowLabels, numbers, prices],
  );
  return eventId;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { createPool } = await import('./pool.js');
  const { loadConfig } = await import('../config.js');
  const { migrate } = await import('./migrate.js');
  const db = createPool(loadConfig().DATABASE_URL);
  await migrate(db);
  const id = await seedDemo(db);
  console.log(`seeded demo event ${id}`);
  await db.end();
}
