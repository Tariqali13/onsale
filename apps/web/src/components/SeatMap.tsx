import { memo, useMemo } from 'react';
import type { SectionLayout } from '../lib/api';
import { ROW_PITCH, type PlacedSeat, type SeatState } from '../lib/seats';
import { money } from '../lib/api';

const FILL: Record<SeatState, string> = {
  available: 'var(--signal)',
  held: 'var(--held)',
  sold: 'var(--sold)',
  mine: 'var(--spot)',
  selected: 'var(--paper)',
};

interface Props {
  layout: SectionLayout[];
  seats: PlacedSeat[];
  stateOf: (seat: PlacedSeat) => SeatState;
  onToggle: (seat: PlacedSeat) => void;
}

/**
 * ~700 seats as plain SVG circles with one delegated click handler.
 * Mouse and touch users click seats; keyboard and screen-reader users use
 * "Best available", which is announced next to the map.
 */
export const SeatMap = memo(function SeatMap({ layout, seats, stateOf, onToggle }: Props) {
  const byId = useMemo(() => new Map(seats.map((s) => [s.id, s])), [seats]);
  const sectionNames = useMemo(() => new Map(layout.map((s) => [s.id, s.name])), [layout]);

  return (
    <svg
      viewBox="40 20 920 620"
      role="img"
      aria-label="Venue seat map. Stage at the top. To choose seats with a keyboard, use Best available."
      onClick={(e) => {
        const id = (e.target as Element).getAttribute('data-id');
        const seat = id ? byId.get(id) : undefined;
        if (seat) onToggle(seat);
      }}
    >
      <rect x="380" y="34" width="240" height="56" rx="10" fill="var(--night-3)" />
      <text x="500" y="70" textAnchor="middle" fill="var(--text-soft)" fontFamily="var(--display)" fontWeight="800" fontSize="22">
        STAGE
      </text>

      {layout.map((s) => (
        <text
          key={s.id}
          x={s.x}
          y={s.y - (s.rows * ROW_PITCH) / 2 - 8}
          transform={`rotate(${s.rotate} ${s.x} ${s.y})`}
          textAnchor="middle"
          fill="var(--text-soft)"
          fontSize="12"
        >
          {s.name}
        </text>
      ))}

      {seats.map((seat) => {
        const state = stateOf(seat);
        return (
          <circle
            key={seat.id}
            className="seat"
            data-id={seat.id}
            data-state={state}
            cx={seat.x}
            cy={seat.y}
            r={state === 'selected' || state === 'mine' ? 5 : 4.4}
            fill={FILL[state]}
            stroke={state === 'selected' ? 'var(--spot)' : 'none'}
            strokeWidth={2}
          >
            <title>{`${sectionNames.get(seat.section)}, row ${seat.row}, seat ${seat.number}: ${money(seat.priceCents)}`}</title>
          </circle>
        );
      })}
    </svg>
  );
});

export function Legend() {
  return (
    <div className="legend" aria-hidden="true">
      <span>
        <i style={{ background: 'var(--signal)' }} /> Available
      </span>
      <span>
        <i style={{ background: 'var(--paper)', boxShadow: 'inset 0 0 0 2px var(--spot)' }} /> Selected
      </span>
      <span>
        <i style={{ background: 'var(--spot)' }} /> Held for you
      </span>
      <span>
        <i style={{ background: 'var(--held)' }} /> In someone’s cart
      </span>
      <span>
        <i style={{ background: 'var(--sold)' }} /> Sold
      </span>
    </div>
  );
}
