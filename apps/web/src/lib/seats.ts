import type { CatalogSeat, SectionLayout } from './api';

export type SeatState = 'available' | 'held' | 'sold' | 'mine' | 'selected';

export const SEAT_PITCH = 11;
export const ROW_PITCH = 12;

export interface PlacedSeat extends CatalogSeat {
  index: number;
  x: number;
  y: number;
}

/** Place every catalog seat on the 1000×700 venue canvas using its section's geometry. */
export function placeSeats(layout: SectionLayout[], catalog: CatalogSeat[]): PlacedSeat[] {
  const sections = new Map(layout.map((s) => [s.id, s]));
  const rowIndex = new Map<string, Map<string, number>>();
  for (const seat of catalog) {
    const rows = rowIndex.get(seat.section) ?? new Map<string, number>();
    if (!rows.has(seat.row)) rows.set(seat.row, rows.size);
    rowIndex.set(seat.section, rows);
  }

  return catalog.map((seat, index) => {
    const s = sections.get(seat.section);
    if (!s) return { ...seat, index, x: 0, y: 0 };
    const r = rowIndex.get(seat.section)!.get(seat.row)!;
    // Local coordinates centred on the section; row A faces the stage (top).
    const lx = (seat.number - 1 - (s.seatsPerRow - 1) / 2) * SEAT_PITCH;
    const ly = (r - (s.rows - 1) / 2) * ROW_PITCH;
    const a = (s.rotate * Math.PI) / 180;
    return {
      ...seat,
      index,
      x: s.x + lx * Math.cos(a) - ly * Math.sin(a),
      y: s.y + lx * Math.sin(a) + ly * Math.cos(a),
    };
  });
}

const TIER_RANK: Record<SectionLayout['tier'], number> = { floor: 0, lower: 1, upper: 2 };

/**
 * "Best available": the closest rows to the stage, then the most central run of
 * `count` adjacent free seats in that row. Returns null if no row has room.
 */
export function bestAvailable(
  layout: SectionLayout[],
  catalog: CatalogSeat[],
  isFree: (seat: CatalogSeat, index: number) => boolean,
  count: number,
): string[] | null {
  const tier = new Map(layout.map((s) => [s.id, TIER_RANK[s.tier]]));
  const rows = new Map<string, { seats: { seat: CatalogSeat; index: number }[]; rank: number; row: string }>();
  catalog.forEach((seat, index) => {
    const key = `${seat.section}|${seat.row}`;
    const entry = rows.get(key) ?? { seats: [], rank: tier.get(seat.section) ?? 9, row: seat.row };
    entry.seats.push({ seat, index });
    rows.set(key, entry);
  });

  const ordered = [...rows.values()].sort((a, b) => a.rank - b.rank || a.row.localeCompare(b.row));
  for (const { seats } of ordered) {
    const mid = (seats.length - 1) / 2;
    let best: { ids: string[]; dist: number } | null = null;
    for (let start = 0; start + count <= seats.length; start++) {
      const run = seats.slice(start, start + count);
      if (!run.every(({ seat, index }) => isFree(seat, index))) continue;
      const dist = Math.abs(start + (count - 1) / 2 - mid);
      if (!best || dist < best.dist) best = { ids: run.map(({ seat }) => seat.id), dist };
    }
    if (best) return best.ids;
  }
  return null;
}

export function decodeState(code: string | undefined): Exclude<SeatState, 'mine' | 'selected'> {
  return code === 's' ? 'sold' : code === 'h' ? 'held' : 'available';
}
