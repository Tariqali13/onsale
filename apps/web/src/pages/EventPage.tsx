import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { formatDate, useEvent, useStats } from '../lib/hooks';
import { loadSession, saveSession } from '../lib/session';
import { REPO_URL } from '../components/Layout';

export function EventPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: event, error } = useEvent();
  const { data: stats } = useStats(event?.id);
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);

  if (error) return <Unavailable />;
  if (!event) return <p aria-busy="true">Loading the event…</p>;

  const sold = stats?.sales.ticketsSold ?? 0;
  const capacity = stats?.sales.capacity ?? 696;
  const soldOut = sold >= capacity;

  async function join() {
    if (!event) return;
    setJoining(true);
    setJoinError(null);
    try {
      const existing = loadSession(event.id);
      const res = await api.joinQueue(event.id, existing?.sessionId);
      saveSession({ eventId: event.id, sessionId: res.sessionId });
      navigate('/queue');
    } catch (err) {
      setJoinError(err instanceof ApiError ? err.message : 'Could not join the queue. Try again.');
      setJoining(false);
    }
  }

  async function reset() {
    if (!event) return;
    setJoining(true);
    try {
      await api.reset(event.id);
      await queryClient.invalidateQueries();
    } catch (err) {
      setJoinError(err instanceof ApiError ? err.message : 'Could not reset the demo.');
    } finally {
      setJoining(false);
    }
  }

  const [first, ...rest] = event.name.split(' — ')[0]!.split(' ');

  return (
    <>
      <section className="event-hero">
        <div>
          <h1 className="poster-title">
            <span>{first}</span>
            <span className="outline">{rest.join(' ')}</span>
          </h1>
          <div className="poster-meta">
            <strong>Live in concert</strong>
            <span>
              {formatDate(event.startsAt)}, {event.venue}
            </span>
          </div>
        </div>

        <aside className="ticket onsale-card" aria-labelledby="onsale-heading">
          <div className="ticket-top">
            <h2 id="onsale-heading">{soldOut ? 'Sold out' : 'Tickets on sale now'}</h2>
            <p className="lede">
              {soldOut
                ? 'Every seat has gone. Reset the demo to put all 696 seats back on sale.'
                : 'Demand is high, so everyone queues first. You’ll get a place in line, then 10 minutes to pick seats and pay.'}
            </p>
            <div className="tally">
              <div>
                <b>{stats ? capacity - sold : '—'}</b>
                <span>of {capacity} seats left</span>
              </div>
              <div>
                <b>{stats ? stats.queue.waiting.toLocaleString() : '—'}</b>
                <span>people waiting</span>
              </div>
            </div>
            <div
              className="sellbar"
              role="progressbar"
              aria-label="Seats sold"
              aria-valuemin={0}
              aria-valuemax={capacity}
              aria-valuenow={sold}
            >
              <i style={{ width: `${(sold / capacity) * 100}%` }} />
            </div>
          </div>
          <div className="ticket-bottom">
            {joinError && (
              <p className="notice" role="alert">
                {joinError}
              </p>
            )}
            {soldOut ? (
              <button className="btn btn-primary btn-block" onClick={reset} disabled={joining}>
                {joining ? 'Resetting…' : 'Reset and run it again'}
              </button>
            ) : (
              <button className="btn btn-primary btn-block" onClick={join} disabled={joining}>
                {joining ? 'Joining…' : 'Join the queue'}
              </button>
            )}
            <button className="btn btn-quiet btn-block" onClick={() => navigate('/ops')}>
              Watch the onsale live
            </button>
            <p className="fineprint">Demo only. No real tickets, no real payments, no card numbers collected.</p>
          </div>
        </aside>
      </section>

      <section className="journey" aria-labelledby="journey-heading">
        <h2 id="journey-heading">What happens when you buy</h2>
        <ol>
          <li>
            <h3>You wait in a fair line</h3>
            <p>
              Thousands can arrive in the same second. A Redis-backed waiting room admits buyers in arrival order at a fixed rate,
              so the seat map and payments only ever see as many shoppers as they can serve. People who close the tab lose their
              place to someone who’s still here.
            </p>
          </li>
          <li>
            <h3>Your seats are held for you</h3>
            <p>
              Picking four seats together reserves all four or none, in one atomic step. They’re yours for 5 minutes; if you walk
              away they return to the pool on their own.
            </p>
          </li>
          <li>
            <h3>You pay exactly once</h3>
            <p>
              Checkout is idempotent: a double-click or a dropped connection replays the first result instead of charging again. A
              database constraint makes selling the same seat twice impossible, even if everything else failed.
            </p>
          </li>
        </ol>
        <p>
          <a href={REPO_URL}>Read the code, the architecture notes and the load-test results on GitHub.</a>
        </p>
      </section>
    </>
  );
}

function Unavailable() {
  return (
    <div className="center-msg">
      <div>
        <h1>The box office is waking up</h1>
        <p>The demo API runs on a free host that sleeps when idle. Give it about 30 seconds, then refresh.</p>
      </div>
    </div>
  );
}
