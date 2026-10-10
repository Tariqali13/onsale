import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, money, type PaymentMethod } from '../lib/api';
import { bestAvailable, decodeState, placeSeats, type PlacedSeat, type SeatState } from '../lib/seats';
import { formatCountdown, useEvent, useNow } from '../lib/hooks';
import { clearAccess, loadSession } from '../lib/session';
import { Legend, SeatMap } from '../components/SeatMap';

const MAX_SEATS = 8;

const CARDS: { id: PaymentMethod; label: string; hint: string }[] = [
  { id: 'pm_card_visa', label: 'Test Visa that succeeds', hint: 'Payment goes through.' },
  { id: 'pm_card_chargeDeclined', label: 'Test card that’s declined', hint: 'Your seats stay held so you can try another card.' },
  {
    id: 'pm_card_visa_slow',
    label: 'Test Visa on a slow network',
    hint: 'Takes ~3 seconds. Double-click Pay: you’re charged once.',
  },
];

type Notice = { tone: 'error' | 'info'; text: string } | null;

export function SeatsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: event } = useEvent();
  const session = event ? loadSession(event.id) : null;
  const token = session?.accessToken;
  const now = useNow(1000);

  const { data: catalog } = useQuery({
    queryKey: ['catalog', event?.id],
    queryFn: () => api.catalog(event!.id),
    enabled: !!event,
    staleTime: Infinity,
  });
  const { data: avail, refetch: refetchAvail } = useQuery({
    queryKey: ['availability', event?.id, session?.sessionId],
    queryFn: () => api.availability(event!.id, session?.sessionId),
    enabled: !!event,
    refetchInterval: 1500,
  });

  const [selected, setSelected] = useState<string[]>([]);
  const [phase, setPhase] = useState<'pick' | 'pay'>('pick');
  const [card, setCard] = useState<PaymentMethod>('pm_card_visa');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [qty, setQty] = useState(2);
  const idempotencyKey = useRef<string | null>(null);

  useEffect(() => {
    if (event && !token) navigate('/');
  }, [event, token, navigate]);

  const placed = useMemo(() => (event && catalog ? placeSeats(event.layout, catalog.seats) : []), [event, catalog]);
  const mine = useMemo(() => new Set(avail?.mine ?? []), [avail?.mine]);
  const selectedSet = useMemo(() => new Set(selected), [selected]);

  // The hold expired (or never existed) while paying: return to picking.
  const holdExpiresAt = avail?.holdExpiresAt ?? null;
  const holdLeft = holdExpiresAt ? holdExpiresAt - now : 0;
  useEffect(() => {
    if (phase === 'pay' && avail && avail.mine.length === 0 && !busy) {
      setPhase('pick');
      setNotice({ tone: 'error', text: 'Your hold ran out and the seats went back on sale. Pick seats again.' });
    }
  }, [phase, avail, busy]);

  const stateOf = useCallback(
    (seat: PlacedSeat): SeatState => {
      if (selectedSet.has(seat.id)) return mine.has(seat.id) ? 'mine' : 'selected';
      const s = decodeState(avail?.states[seat.index]);
      return mine.has(seat.id) && s !== 'sold' ? 'mine' : s;
    },
    [avail?.states, mine, selectedSet],
  );

  const onToggle = useCallback(
    (seat: PlacedSeat) => {
      if (phase !== 'pick') return;
      const state = stateOf(seat);
      if (state === 'held' || state === 'sold') return;
      setNotice(null);
      setSelected((cur) => {
        if (cur.includes(seat.id)) return cur.filter((id) => id !== seat.id);
        if (cur.length >= MAX_SEATS) {
          setNotice({ tone: 'info', text: `You can buy up to ${MAX_SEATS} seats.` });
          return cur;
        }
        return [...cur, seat.id];
      });
    },
    [phase, stateOf],
  );

  const onAuthLost = useCallback(() => {
    if (event) clearAccess(event.id);
    navigate('/', { replace: true });
  }, [event, navigate]);

  async function hold(seatIds: string[]) {
    if (!event || !token) return;
    setBusy(true);
    setNotice(null);
    try {
      await api.hold(event.id, token, seatIds);
      setSelected(seatIds);
      setPhase('pay');
      idempotencyKey.current = null;
      await refetchAvail();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return onAuthLost();
      if (err instanceof ApiError && err.status === 409) {
        const lost = String(err.body.seatId ?? '');
        setSelected((cur) => cur.filter((id) => id !== lost));
        setNotice({ tone: 'error', text: `${err.message} We’ve removed it from your selection.` });
        await refetchAvail();
      } else {
        setNotice({ tone: 'error', text: err instanceof ApiError ? err.message : 'Could not hold those seats. Try again.' });
      }
    } finally {
      setBusy(false);
    }
  }

  function chooseBest() {
    if (!event || !catalog || !avail) return;
    const pick = bestAvailable(event.layout, catalog.seats, (seat, i) => mine.has(seat.id) || avail.states[i] === 'a', qty);
    if (!pick) {
      setNotice({ tone: 'info', text: `There aren’t ${qty} seats together any more. Try a smaller group.` });
      return;
    }
    void hold(pick);
  }

  async function pay() {
    if (!event || !token) return;
    // One key per payment attempt. A retry of the same attempt (double-click, network
    // blip) reuses it, so the server replays the first result instead of charging again.
    idempotencyKey.current ??= crypto.randomUUID();
    setBusy(true);
    setNotice(null);
    const seatIds = [...mine];
    try {
      const order = await api.checkout(event.id, token, idempotencyKey.current, seatIds, card);
      const seats = placed.filter((s) => order.seatIds.includes(s.id));
      queryClient.removeQueries({ queryKey: ['availability'] });
      navigate('/confirmation', {
        state: { order, seats, layout: event.layout, eventName: event.name, venue: event.venue, startsAt: event.startsAt },
      });
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      if (err.code === 'network_error') {
        setNotice({ tone: 'error', text: `${err.message} Press Pay again: you won’t be charged twice.` });
      } else if (err.status === 401) {
        onAuthLost();
      } else if (err.status === 402) {
        idempotencyKey.current = null; // a new attempt with another card gets a new key
        setNotice({ tone: 'error', text: `${err.message} Your seats are still held. Choose another card.` });
      } else if (err.status === 409 && err.code === 'request_in_progress') {
        setNotice({ tone: 'info', text: 'Your payment is still being processed. Hold on a moment, then press Pay again.' });
      } else {
        idempotencyKey.current = null;
        setPhase('pick');
        setNotice({ tone: 'error', text: err.message });
        await refetchAvail();
      }
    } finally {
      setBusy(false);
    }
  }

  async function leave() {
    if (event && token) await api.leave(event.id, token).catch(() => undefined);
    onAuthLost();
  }

  if (!event || !catalog || !avail) return <p aria-busy="true">Loading the seat map…</p>;

  const cartIds = phase === 'pay' ? [...mine] : selected;
  const cartSeats = placed.filter((s) => cartIds.includes(s.id));
  const total = cartSeats.reduce((sum, s) => sum + s.priceCents, 0);
  const sectionName = new Map(event.layout.map((s) => [s.id, s.name]));

  return (
    <div className="buy">
      <div className="venue">
        <SeatMap layout={event.layout} seats={placed} stateOf={stateOf} onToggle={onToggle} />
        <Legend />
      </div>

      <aside className="ticket cart" aria-labelledby="cart-heading">
        <div className="ticket-top">
          <h2 id="cart-heading">{phase === 'pick' ? 'Choose your seats' : 'Pay for your seats'}</h2>

          {phase === 'pick' && (
            <>
              <p className="fineprint">
                {avail.available} seats available. Click seats on the map, or let us find the best ones together.
              </p>
              <div className="qty">
                <label htmlFor="qty">Seats</label>
                <select id="qty" value={qty} onChange={(e) => setQty(Number(e.target.value))}>
                  {Array.from({ length: MAX_SEATS }, (_, i) => (
                    <option key={i + 1} value={i + 1}>
                      {i + 1}
                    </option>
                  ))}
                </select>
                <button className="btn btn-quiet" onClick={chooseBest} disabled={busy}>
                  Best available
                </button>
              </div>
            </>
          )}

          {phase === 'pay' && holdExpiresAt && (
            <div className={`timer${holdLeft < 60_000 ? ' urgent' : ''}`} role="timer" aria-live="off">
              <span>Seats held for you</span>
              <b>{formatCountdown(holdLeft)}</b>
            </div>
          )}

          {cartSeats.length > 0 && (
            <ul className="cart-seats" aria-label="Your seats">
              {cartSeats.map((s) => (
                <li key={s.id}>
                  <span>
                    {sectionName.get(s.section)}, row {s.row}, seat {s.number}
                  </span>
                  <span>{money(s.priceCents)}</span>
                </li>
              ))}
            </ul>
          )}

          {cartSeats.length > 0 && (
            <div className="cart-total">
              <span>Total, fees included</span>
              <b>{money(total)}</b>
            </div>
          )}
        </div>
        <div className="ticket-bottom">
          {notice && (
            <p className={`notice${notice.tone === 'info' ? ' info' : ''}`} role={notice.tone === 'error' ? 'alert' : 'status'}>
              {notice.text}
            </p>
          )}

          {phase === 'pick' ? (
            <button className="btn btn-primary btn-block" onClick={() => hold(selected)} disabled={busy || selected.length === 0}>
              {busy
                ? 'Holding…'
                : selected.length
                  ? `Hold ${selected.length} seat${selected.length > 1 ? 's' : ''}`
                  : 'Select seats to continue'}
            </button>
          ) : (
            <>
              <fieldset className="cards">
                <legend>Payment</legend>
                {CARDS.map((c) => (
                  <label key={c.id}>
                    <input
                      type="radio"
                      name="card"
                      value={c.id}
                      checked={card === c.id}
                      onChange={() => {
                        setCard(c.id);
                        idempotencyKey.current = null;
                      }}
                    />
                    <span>
                      {c.label}
                      <small>{c.hint}</small>
                    </span>
                  </label>
                ))}
              </fieldset>
              <button className="btn btn-primary btn-block" onClick={pay} disabled={busy && card !== 'pm_card_visa_slow'}>
                {busy ? 'Paying…' : `Pay ${money(total)}`}
              </button>
              <button
                className="btn btn-quiet btn-block"
                onClick={() => {
                  setPhase('pick');
                  setNotice(null);
                }}
                disabled={busy}
              >
                Change seats
              </button>
            </>
          )}
          <button className="btn btn-quiet btn-block" onClick={leave} disabled={busy}>
            Leave and release my place
          </button>
        </div>
      </aside>
    </div>
  );
}
