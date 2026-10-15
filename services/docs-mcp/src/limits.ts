// A fixed-window request limiter per client, in memory. The service is read-only and cheap, so the limit exists to keep one client from
// starving the rest, not to protect a secret.
export interface Limiter {
  /** Counts one request from `key`. `allowed` is false once the client has used its requests for the current minute. */
  take(key: string): { allowed: boolean; retryAfterSeconds: number };
}

export function createLimiter(perMinute: number, now: () => number = Date.now, maxClients = 10_000): Limiter {
  if (perMinute <= 0) return { take: () => ({ allowed: true, retryAfterSeconds: 0 }) };
  const windows = new Map<string, { start: number; count: number }>();
  return {
    take(key) {
      const t = now();
      let w = windows.get(key);
      if (!w || t - w.start >= 60_000) {
        w = { start: t, count: 0 };
        // Forget expired windows before the table can grow without bound.
        if (windows.size >= maxClients) for (const [k, v] of windows) if (t - v.start >= 60_000) windows.delete(k);
        if (windows.size >= maxClients) windows.delete(windows.keys().next().value as string);
        windows.set(key, w);
      }
      w.count++;
      return w.count <= perMinute ? { allowed: true, retryAfterSeconds: 0 } : { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((w.start + 60_000 - t) / 1000)) };
    },
  };
}
