export const API_URL = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ?? 'http://localhost:4000';

export interface SectionLayout {
  id: string;
  name: string;
  tier: 'floor' | 'lower' | 'upper';
  priceCents: number;
  rows: number;
  seatsPerRow: number;
  x: number;
  y: number;
  rotate: number;
}

export interface EventInfo {
  id: string;
  slug: string;
  name: string;
  venue: string;
  startsAt: string;
  onsaleAt: string;
  layout: SectionLayout[];
}

export interface CatalogSeat {
  id: string;
  section: string;
  row: string;
  number: number;
  priceCents: number;
}

export interface Availability {
  /** one char per catalog seat: a = available, h = held, s = sold */
  states: string;
  mine: string[];
  holdExpiresAt: number | null;
  available: number;
  sold: number;
  generatedAt: number;
}

export type QueueStatus =
  | { state: 'waiting'; position: number; ahead: number; etaSeconds: number; queueSize: number }
  | { state: 'admitted'; expiresAt: number; accessToken: string }
  | { state: 'sold_out' }
  | { state: 'unknown' };

export interface Stats {
  queue: { waiting: number; active: number; joined: number; admitted: number; abandoned: number; admitRatePerSec: number; maxActive: number };
  sales: {
    paidOrders: number;
    failedOrders: number;
    pendingOrders: number;
    revenueCents: number;
    ticketsSold: number;
    oversold: number;
    capacity: number;
    held: number;
  };
  simulator: { activeBots: number; enabled: boolean };
  generatedAt: number;
}

export interface PaidOrder {
  orderId: string;
  status: 'paid';
  seatIds: string[];
  subtotalCents: number;
  feesCents: number;
  totalCents: number;
  paymentReference: string;
}

export type PaymentMethod = 'pm_card_visa' | 'pm_card_chargeDeclined' | 'pm_card_visa_slow';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly body: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit & { token?: string; idempotencyKey?: string } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  if (init.idempotencyKey) headers['idempotency-key'] = init.idempotencyKey;

  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, { ...init, headers });
  } catch {
    throw new ApiError(0, 'network_error', 'Can’t reach the box office. Check your connection; your place is kept.');
  }
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const err = body?.error ?? {};
    throw new ApiError(res.status, err.code ?? 'error', err.message ?? `Request failed (${res.status})`, err);
  }
  return body as T;
}

export const api = {
  event: (slug: string) => request<EventInfo>(`/events/${slug}`),
  catalog: (eventId: string) => request<{ seats: CatalogSeat[] }>(`/events/${eventId}/seats`),
  availability: (eventId: string, session?: string) =>
    request<Availability>(`/events/${eventId}/availability${session ? `?session=${encodeURIComponent(session)}` : ''}`),
  stats: (eventId: string) => request<Stats>(`/events/${eventId}/stats`),

  joinQueue: (eventId: string, sessionId?: string) =>
    request<{ sessionId: string } & QueueStatus>(`/events/${eventId}/queue`, {
      method: 'POST',
      body: JSON.stringify(sessionId ? { sessionId } : {}),
    }),
  queueStatus: (eventId: string, sessionId: string) => request<QueueStatus>(`/events/${eventId}/queue/${sessionId}`),
  leave: (eventId: string, token: string) =>
    request<{ released: number }>(`/events/${eventId}/queue/leave`, { method: 'POST', body: '{}', token }),

  hold: (eventId: string, token: string, seatIds: string[]) =>
    request<{ seatIds: string[]; expiresAt: number }>(`/events/${eventId}/cart`, {
      method: 'PUT',
      body: JSON.stringify({ seatIds }),
      token,
    }),
  checkout: (eventId: string, token: string, idempotencyKey: string, seatIds: string[], paymentMethod: PaymentMethod) =>
    request<PaidOrder>(`/events/${eventId}/checkout`, {
      method: 'POST',
      body: JSON.stringify({ seatIds, paymentMethod }),
      token,
      idempotencyKey,
    }),

  simulate: (eventId: string, bots: number) =>
    request<{ spawned: number }>(`/events/${eventId}/simulate`, { method: 'POST', body: JSON.stringify({ bots }) }),
  reset: (eventId: string) => request<{ ok: true }>(`/events/${eventId}/reset`, { method: 'POST', body: '{}' }),
};

export const money = (cents: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: cents % 100 === 0 ? 0 : 2 }).format(
    cents / 100,
  );
