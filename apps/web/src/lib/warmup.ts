import { API_URL } from './api';

/**
 * The demo API runs on a free host that sleeps when idle and takes 30-60 s to wake.
 * While it wakes, the host answers with its own HTML holding page (no CORS headers,
 * not JSON), so ordinary requests fail fast. This polls /health until the real API
 * answers, so the app can wait instead of showing an error.
 */
export const WAKE_TIMEOUT_MS = 120_000;
const ATTEMPT_TIMEOUT_MS = 10_000;
const RETRY_EVERY_MS = 2_000;

export async function apiIsUp(signal?: AbortSignal): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ATTEMPT_TIMEOUT_MS);
  const onAbort = () => ctrl.abort();
  signal?.addEventListener('abort', onAbort);
  try {
    const res = await fetch(`${API_URL}/health`, { signal: ctrl.signal, cache: 'no-store' });
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('application/json')) return false;
    const body = (await res.json()) as { ok?: boolean };
    return body.ok === true;
  } catch {
    return false; // network error, CORS-less holding page, or timeout: still waking
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });

/** Resolves true once the API is up, false if it isn't up within `timeoutMs`. */
export async function waitForApi(
  { timeoutMs = WAKE_TIMEOUT_MS, signal, now = Date.now }: { timeoutMs?: number; signal?: AbortSignal; now?: () => number } = {},
): Promise<boolean> {
  const deadline = now() + timeoutMs;
  while (!signal?.aborted) {
    if (await apiIsUp(signal)) return true;
    if (now() >= deadline) return false;
    await sleep(RETRY_EVERY_MS, signal);
  }
  return false;
}

// One check per page load, shared by every route, so navigating doesn't re-check.
let ready = false;
export const apiKnownUp = () => ready;
export const markApiUp = () => { ready = true; };
