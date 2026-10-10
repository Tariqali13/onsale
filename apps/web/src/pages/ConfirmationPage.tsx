import { Link, useLocation } from 'react-router';
import { money, type PaidOrder, type SectionLayout } from '../lib/api';
import type { PlacedSeat } from '../lib/seats';
import { formatDate } from '../lib/hooks';

interface ConfirmationState {
  order: PaidOrder;
  seats: PlacedSeat[];
  layout: SectionLayout[];
  eventName: string;
  venue: string;
  startsAt: string;
}

export function ConfirmationPage() {
  const state = useLocation().state as ConfirmationState | null;

  if (!state) {
    return (
      <div className="center-msg">
        <div>
          <h1>No order to show</h1>
          <p>Confirmations only appear right after checkout.</p>
          <p style={{ marginTop: 16 }}>
            <Link to="/">Back to the event</Link>
          </p>
        </div>
      </div>
    );
  }

  const { order, seats, layout } = state;
  const sectionName = new Map(layout.map((s) => [s.id, s.name]));
  const [act] = state.eventName.split(' — ');

  return (
    <section className="confirm">
      <article className="ticket stub" aria-labelledby="stub-heading">
        <div className="ticket-top">
          <p className="fineprint">You’re going</p>
          <h1 id="stub-heading">{act}</h1>
          <dl>
            <dt>When</dt>
            <dd>{formatDate(state.startsAt)}</dd>
            <dt>Where</dt>
            <dd>{state.venue}</dd>
            <dt>Seats</dt>
            <dd>
              {seats.map((s) => (
                <div key={s.id}>
                  {sectionName.get(s.section)}, row {s.row}, seat {s.number}
                </div>
              ))}
            </dd>
          </dl>
        </div>
        <div className="ticket-bottom">
          <dl>
            <dt>Tickets</dt>
            <dd>{money(order.subtotalCents)}</dd>
            <dt>Fees</dt>
            <dd>{money(order.feesCents)}</dd>
            <dt>Paid</dt>
            <dd>{money(order.totalCents)}</dd>
            <dt>Order</dt>
            <dd>{order.orderId.slice(0, 8).toUpperCase()}</dd>
          </dl>
          <div className="barcode" role="img" aria-label="Ticket barcode (decorative)" />
        </div>
      </article>
      <p>
        <Link to="/ops">See where your order landed in the live onsale</Link>
      </p>
    </section>
  );
}
