import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { api, type QueueStatus } from '../lib/api';
import { useEvent } from '../lib/hooks';
import { loadSession, saveSession } from '../lib/session';

/** Polling is the heartbeat: a tab that stops polling loses its place. */
const POLL_MS = 2000;

export function QueuePage() {
  const navigate = useNavigate();
  const { data: event } = useEvent();
  const [status, setStatus] = useState<QueueStatus | null>(null);
  const [offline, setOffline] = useState(false);
  const firstPosition = useRef<number | null>(null);

  useEffect(() => {
    if (!event) return;
    const session = loadSession(event.id);
    if (!session) {
      navigate('/');
      return;
    }
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;

    const poll = async () => {
      try {
        const s = await api.queueStatus(event.id, session.sessionId);
        if (stop) return;
        setOffline(false);
        setStatus(s);
        if (s.state === 'waiting' && firstPosition.current === null) firstPosition.current = s.position;
        if (s.state === 'admitted') {
          saveSession({ ...session, accessToken: s.accessToken, accessExpiresAt: s.expiresAt });
          setTimeout(() => !stop && navigate('/seats'), 900);
          return;
        }
        if (s.state === 'sold_out') return;
      } catch {
        if (!stop) setOffline(true);
      }
      timer = setTimeout(poll, POLL_MS);
    };
    poll();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [event, navigate]);

  if (!status) return <p aria-busy="true">Finding your place in line…</p>;

  if (status.state === 'sold_out') {
    return (
      <div className="center-msg">
        <div>
          <h1>Sold out</h1>
          <p>Every seat has been sold. Thanks for waiting.</p>
          <p style={{ marginTop: 16 }}>
            <Link to="/ops">See how the onsale went</Link>
          </p>
        </div>
      </div>
    );
  }

  if (status.state === 'unknown') {
    return (
      <div className="center-msg">
        <div>
          <h1>Your place has expired</h1>
          <p>You were away for a while, so your spot went to someone who was still here.</p>
          <p style={{ marginTop: 16 }}>
            <Link to="/" className="btn btn-primary">
              Join the queue again
            </Link>
          </p>
        </div>
      </div>
    );
  }

  const admitted = status.state === 'admitted';
  const start = firstPosition.current ?? (status.state === 'waiting' ? status.position : 1);
  const progress = admitted ? 1 : 1 - (status.position - 1) / Math.max(start, 1);

  return (
    <section className="queue" aria-live="polite">
      <div className="queue-inner">
        {admitted ? (
          <>
            <div className="queue-number admitted" aria-hidden="true">
              0
            </div>
            <p className="queue-caption">It’s your turn. Taking you to the seat map.</p>
          </>
        ) : (
          <>
            <div className="queue-number" aria-hidden="true">
              {status.ahead.toLocaleString()}
            </div>
            <p className="queue-caption">
              {status.ahead === 0 ? 'You’re next.' : `${status.ahead === 1 ? 'person' : 'people'} ahead of you`}
              <span className="visually-hidden">: {status.ahead}</span>
            </p>
            <p>
              About {formatEta(status.etaSeconds)} to go. Keep this tab open: we hold your place while you’re here, and give it to
              the next person if you leave.
            </p>
          </>
        )}
        <div className="drain" aria-hidden="true">
          <i style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
        {offline && <p className="notice">Connection lost. Retrying; your place is kept for 20 seconds.</p>}
      </div>
    </section>
  );
}

function formatEta(sec: number): string {
  if (sec < 60) return `${sec} second${sec === 1 ? '' : 's'}`;
  const m = Math.round(sec / 60);
  return `${m} minute${m === 1 ? '' : 's'}`;
}
