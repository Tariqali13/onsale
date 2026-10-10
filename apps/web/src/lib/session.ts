/**
 * Per-tab buyer session. sessionStorage (not localStorage) on purpose: each tab
 * is its own place in line, exactly like a real onsale.
 */
export interface BuyerSession {
  eventId: string;
  sessionId: string;
  accessToken?: string;
  accessExpiresAt?: number;
}

const KEY = 'onsale.session';

export function loadSession(eventId: string): BuyerSession | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as BuyerSession;
    return s.eventId === eventId ? s : null;
  } catch {
    return null;
  }
}

export function saveSession(s: BuyerSession): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable (private mode); the session lives in memory for this page */
  }
}

export function clearAccess(eventId: string): void {
  const s = loadSession(eventId);
  if (s) saveSession({ eventId: s.eventId, sessionId: s.sessionId });
}
