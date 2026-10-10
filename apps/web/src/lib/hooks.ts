import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';

export const EVENT_SLUG = 'midnight-signal-live';

export function useEvent() {
  return useQuery({ queryKey: ['event', EVENT_SLUG], queryFn: () => api.event(EVENT_SLUG), staleTime: Infinity });
}

export function useStats(eventId: string | undefined, intervalMs = 2000) {
  return useQuery({
    queryKey: ['stats', eventId],
    queryFn: () => api.stats(eventId!),
    enabled: !!eventId,
    refetchInterval: intervalMs,
  });
}

/** Re-renders every `ms` so countdowns stay live. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export function formatDate(iso: string): string {
  return new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date(iso));
}
