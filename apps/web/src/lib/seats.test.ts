import { bestAvailable, placeSeats } from './seats';
import type { CatalogSeat, SectionLayout } from './api';

const layout: SectionLayout[] = [
  { id: 'F', name: 'Floor', tier: 'floor', priceCents: 100, rows: 2, seatsPerRow: 5, x: 100, y: 100, rotate: 0 },
  { id: 'U', name: 'Upper', tier: 'upper', priceCents: 50, rows: 1, seatsPerRow: 5, x: 100, y: 300, rotate: 90 },
];
const catalog: CatalogSeat[] = [];
for (const s of layout)
  for (let r = 0; r < s.rows; r++)
    for (let n = 1; n <= s.seatsPerRow; n++)
      catalog.push({ id: `${s.id}${'AB'[r]}${n}`, section: s.id, row: 'AB'[r]!, number: n, priceCents: s.priceCents });

describe('placeSeats', () => {
  it('centres each section on its anchor and puts row A nearest the stage', () => {
    const placed = placeSeats(layout, catalog);
    const a3 = placed.find((s) => s.id === 'FA3')!;
    const b3 = placed.find((s) => s.id === 'FB3')!;
    expect(a3.x).toBeCloseTo(100);
    expect(a3.y).toBeLessThan(b3.y);
  });

  it('rotates sections', () => {
    const placed = placeSeats(layout, catalog);
    const u1 = placed.find((s) => s.id === 'UA1')!;
    const u5 = placed.find((s) => s.id === 'UA5')!;
    expect(u1.x).toBeCloseTo(100);
    expect(u5.y).toBeGreaterThan(u1.y);
  });
});

describe('bestAvailable', () => {
  const allFree = () => true;

  it('prefers the front row of the best tier and the most central run', () => {
    expect(bestAvailable(layout, catalog, allFree, 3)).toEqual(['FA2', 'FA3', 'FA4']);
  });

  it('only returns adjacent free seats', () => {
    const taken = new Set(['FA3']);
    expect(bestAvailable(layout, catalog, (s) => !taken.has(s.id), 2)).toEqual(['FA1', 'FA2']);
  });

  it('falls back to worse rows, then returns null when nothing fits', () => {
    const takenFront = (s: CatalogSeat) => !(s.section === 'F' && s.row === 'A');
    expect(bestAvailable(layout, catalog, takenFront, 5)).toEqual(['FB1', 'FB2', 'FB3', 'FB4', 'FB5']);
    expect(bestAvailable(layout, catalog, allFree, 6)).toBeNull();
  });
});
