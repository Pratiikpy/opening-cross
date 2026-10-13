'use client';

import { useEffect, useState } from 'react';

/**
 * Unix seconds, ticking. The first value is the server's, so the markup the browser first renders matches the server's;
 * the clock switches to the browser's own once mounted. `ms` is the tick (a countdown wants 1000).
 */
export function useClock(serverNow: number, ms = 1000): number {
  const [now, setNow] = useState(serverNow);
  useEffect(() => {
    setNow(Math.floor(Date.now() / 1000));
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** The viewer's time zone once mounted; UTC on the server, which cannot know it. */
export function useZone(): string {
  const [zone, setZone] = useState('UTC');
  useEffect(() => setZone(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'), []);
  return zone;
}
