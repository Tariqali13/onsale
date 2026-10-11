import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const holdingPage = () =>
  new Response('<html>SERVICE WAKING UP</html>', { status: 200, headers: { 'content-type': 'text/html' } });

// Fresh module per test: the "API is up" flag is module-level by design.
async function load() {
  vi.resetModules();
  return (await import('./WarmUpGate')).WarmUpGate;
}

describe('WarmUpGate', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('renders the app straight away when the API is already up, without flashing the wake-up card', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ ok: true })));
    const WarmUpGate = await load();
    render(<WarmUpGate><p>the app</p></WarmUpGate>);
    expect(await screen.findByText('the app')).toBeInTheDocument();
    expect(screen.queryByText(/Waking the demo server/)).not.toBeInTheDocument();
  });

  it('shows the wake-up card while the host serves its holding page, then the app', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () => { throw new TypeError('CORS'); }) // holding page has no CORS headers
      .mockImplementationOnce(async () => holdingPage())
      .mockImplementation(async () => json({ ok: true, db: true, redis: true }));
    vi.stubGlobal('fetch', fetchMock);
    const WarmUpGate = await load();
    render(<WarmUpGate><p>the app</p></WarmUpGate>);

    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(screen.getByText('Waking the demo server…')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toBeInTheDocument();

    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(await screen.findByText('the app')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('offers a retry if the server never wakes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => holdingPage()));
    const WarmUpGate = await load();
    render(<WarmUpGate><p>the app</p></WarmUpGate>);
    await act(() => vi.advanceTimersByTimeAsync(125_000));
    expect(screen.getByText('The demo server didn’t wake up')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.queryByText('the app')).not.toBeInTheDocument();
  });
});
