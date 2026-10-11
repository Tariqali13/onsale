import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { apiKnownUp, markApiUp, waitForApi, WAKE_TIMEOUT_MS } from '../lib/warmup';

type Phase = 'checking' | 'waking' | 'ready' | 'failed';

/** Only show the wake-up card if the first check is slow, so a warm API never flickers. */
const SHOW_CARD_AFTER_MS = 900;
/** Typical cold start, used to pace the progress bar (it slows, never stops, near the end). */
const TYPICAL_WAKE_S = 45;

export function WarmUpGate({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>(() => (apiKnownUp() ? 'ready' : 'checking'));
  const [startedAt, setStartedAt] = useState(() => Date.now());
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (apiKnownUp()) return;
    const ctrl = new AbortController();
    const showCard = setTimeout(() => setPhase((p) => (p === 'checking' ? 'waking' : p)), SHOW_CARD_AFTER_MS);
    waitForApi({ signal: ctrl.signal }).then((up) => {
      if (ctrl.signal.aborted) return;
      if (up) markApiUp();
      setPhase(up ? 'ready' : 'failed');
    });
    return () => {
      ctrl.abort();
      clearTimeout(showCard);
    };
  }, [attempt]);

  const retry = useCallback(() => {
    setStartedAt(Date.now());
    setPhase('waking');
    setAttempt((a) => a + 1);
  }, []);

  if (phase === 'ready') return <>{children}</>;
  if (phase === 'checking') return <div className="warmup-placeholder" aria-busy="true" />;
  return <WakeCard failed={phase === 'failed'} startedAt={startedAt} onRetry={retry} />;
}

function WakeCard({ failed, startedAt, onRetry }: { failed: boolean; startedAt: number; onRetry: () => void }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (failed) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [failed]);

  const elapsed = Math.max(0, (now - startedAt) / 1000);
  // Eases towards 95% around the typical wake time, then creeps; never claims 100% before it's true.
  const progress = failed ? 1 : Math.min(0.97, 1 - Math.exp(-elapsed / (TYPICAL_WAKE_S / 2.2)));

  return (
    <section className="warmup" aria-live="polite" aria-busy={!failed}>
      <div className="warmup-ticket">
        <p className="warmup-kicker">{failed ? 'Still asleep' : 'Opening the box office'}</p>
        <h1>{failed ? 'The demo server didn’t wake up' : 'Waking the demo server…'}</h1>
        {failed ? (
          <p>
            It hasn’t answered for {Math.round(WAKE_TIMEOUT_MS / 1000)} seconds, which usually means the free host is
            busy. Try again in a moment.
          </p>
        ) : (
          <p>
            This demo runs on a free host that sleeps when nobody’s using it. The first visit wakes it up, which takes
            about 30–60 seconds. After that, everything is instant.
          </p>
        )}
        <div
          className="warmup-bar"
          role="progressbar"
          aria-label="Waking the server"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress * 100)}
        >
          <span style={{ transform: `scaleX(${progress})` }} />
        </div>
        <p className="warmup-meta">
          {failed ? (
            <button className="btn btn-primary" onClick={onRetry}>
              Try again
            </button>
          ) : (
            <span className="warmup-time">{Math.floor(elapsed)}s</span>
          )}
        </p>
      </div>
    </section>
  );
}
