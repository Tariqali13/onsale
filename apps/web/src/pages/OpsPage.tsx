import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError, money, type Stats } from '../lib/api';
import { useEvent, useStats } from '../lib/hooks';
import { REPO_URL } from '../components/Layout';

const HISTORY = 90; // seconds of history in the sparklines

interface Sample {
  t: number;
  waiting: number;
  active: number;
  sold: number;
  admitted: number;
}

export function OpsPage() {
  const queryClient = useQueryClient();
  const { data: event } = useEvent();
  const { data: stats } = useStats(event?.id, 1000);
  const [history, setHistory] = useState<Sample[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const lastAt = useRef(0);

  useEffect(() => {
    if (!stats || stats.generatedAt === lastAt.current) return;
    lastAt.current = stats.generatedAt;
    setHistory((h) =>
      [
        ...h,
        {
          t: stats.generatedAt,
          waiting: stats.queue.waiting,
          active: stats.queue.active,
          sold: stats.sales.ticketsSold,
          admitted: stats.queue.admitted,
        },
      ].slice(-HISTORY),
    );
  }, [stats]);

  async function run(action: () => Promise<unknown>, done: string) {
    setBusy(true);
    setMessage(null);
    try {
      await action();
      setMessage(done);
      if (done.startsWith('Reset')) setHistory([]);
      await queryClient.invalidateQueries();
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : 'That didn’t work. Try again.');
    } finally {
      setBusy(false);
    }
  }

  if (!event || !stats) return <p aria-busy="true">Connecting to the onsale…</p>;

  const { queue, sales } = stats;
  const admitRate = rate(history, 'admitted');
  const sellRate = rate(history, 'sold');
  const canReset = sales.ticketsSold >= sales.capacity * 0.9;

  return (
    <>
      <div className="ops-head">
        <div>
          <h1>Live onsale</h1>
          <p>Real numbers from the API, refreshed every second. Release a crowd and watch the system hold up.</p>
        </div>
        <div className="ops-actions">
          <button
            className="btn btn-primary"
            disabled={busy || !stats.simulator.enabled}
            onClick={() => run(() => api.simulate(event.id, 500), '500 buyers joined the queue.')}
          >
            Release 500 buyers
          </button>
          <button
            className="btn btn-quiet"
            disabled={busy || !stats.simulator.enabled}
            onClick={() => run(() => api.simulate(event.id, 2000), '2,000 buyers joined the queue.')}
          >
            Release 2,000
          </button>
          <button
            className="btn btn-quiet"
            disabled={busy || !canReset}
            onClick={() => run(() => api.reset(event.id), 'Reset. The onsale is open again.')}
          >
            Reset the onsale
          </button>
        </div>
      </div>
      {message && (
        <p className="notice info" role="status" style={{ marginBottom: 20 }}>
          {message}
        </p>
      )}

      <div className="ops-grid">
        <Metric label="Waiting in line" value={queue.waiting.toLocaleString()} series={history.map((h) => h.waiting)} />
        <Metric
          label="Shopping now"
          value={queue.active.toLocaleString()}
          note={`limit ${queue.maxActive}`}
          series={history.map((h) => h.active)}
        />
        <Metric label="Admitted per second" value={admitRate.toFixed(0)} note={`target ${queue.admitRatePerSec}/s`} />
        <Metric label="People who left the line" value={queue.abandoned.toLocaleString()} note="skipped, never given a slot" />

        <Metric label="Tickets sold" value={`${sales.ticketsSold}/${sales.capacity}`} series={history.map((h) => h.sold)} />
        <Metric label="Selling per second" value={sellRate.toFixed(1)} />
        <Metric label="Seats in carts" value={sales.held.toLocaleString()} note="return to sale after 5 min" />
        <Metric
          label="Revenue"
          value={money(sales.revenueCents)}
          note={`${sales.paidOrders} orders, ${sales.failedOrders} declined`}
        />

        <Metric
          label="Seats sold twice"
          value={String(sales.oversold)}
          note="checked against Postgres every second"
          guarantee={sales.oversold === 0}
        />
        <Metric label="Payments in limbo" value={String(sales.pendingOrders)} note="settled by the reconciler" />
        <Metric label="Simulated buyers active" value={stats.simulator.activeBots.toLocaleString()} />
        <Metric label="Joined in total" value={queue.joined.toLocaleString()} />
      </div>

      <div className="ops-notes">
        <div>
          <h2>Why “seats sold twice” stays at zero</h2>
          <p>
            Three independent layers: the waiting room limits how many people shop at once, Redis holds seats atomically with Lua
            scripts, and a unique constraint in Postgres rejects a second sale of any seat even if Redis were wrong. The test
            suite proves the last layer by deliberately breaking the first two.
          </p>
        </div>
        <div>
          <h2>What the simulated buyers do</h2>
          <p>
            They go through the same code paths you do: queue, hold 1–4 adjacent seats, pay (8% of their cards are declined). For
            HTTP-level load numbers, see the k6 results in the <a href={`${REPO_URL}/tree/main/load`}>repository</a>.
          </p>
        </div>
      </div>
    </>
  );
}

function Metric({
  label,
  value,
  note,
  series,
  guarantee,
}: {
  label: string;
  value: string;
  note?: string;
  series?: number[];
  guarantee?: boolean;
}) {
  return (
    <div className={`metric${guarantee ? ' guarantee' : ''}`}>
      <span>{label}</span>
      <b>{value}</b>
      {note && <small>{note}</small>}
      {series && series.length > 1 && <Sparkline values={series} />}
    </div>
  );
}

function Sparkline({ values }: { values: number[] }) {
  const max = Math.max(1, ...values);
  const w = 200;
  const h = 44;
  const step = w / (HISTORY - 1);
  const offset = (HISTORY - values.length) * step;
  const points = values.map((v, i) => `${(offset + i * step).toFixed(1)},${(h - 2 - (v / max) * (h - 6)).toFixed(1)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
      <polyline points={points} fill="none" stroke="var(--signal)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function rate(history: Sample[], key: 'admitted' | 'sold'): number {
  const recent = history.slice(-6);
  if (recent.length < 2) return 0;
  const first = recent[0]!;
  const last = recent[recent.length - 1]!;
  const secs = (last.t - first.t) / 1000;
  return secs > 0 ? Math.max(0, (last[key] - first[key]) / secs) : 0;
}

export type { Stats };
