// A fixed-window request limiter per client address, with no dependency. It is a first line of defence for a public
// deployment (THREAT_MODEL open gap 3), not a WAF: it stops one address from hammering the API or the RPC behind it.
// Counters live in memory, so each API process limits independently.

export type RateLimit = {
  /** Requests one address may make per window; 0 or less disables the limiter. */
  perWindow: number;
  windowMs?: number;
  /** Paths that are never limited (health checks by a monitor). */
  exempt?: readonly string[];
};

export type Decision = { allowed: true } | { allowed: false; retryAfterSeconds: number };

export function createLimiter(cfg: RateLimit, now: () => number = Date.now) {
  const windowMs = cfg.windowMs ?? 60_000;
  const windows = new Map<string, { start: number; count: number }>();
  let lastSweep = now();
  return {
    check(key: string, path: string): Decision {
      if (cfg.perWindow <= 0 || cfg.exempt?.includes(path)) return { allowed: true };
      const t = now();
      // Drop windows that have ended, so the map is bounded by the addresses seen in one window.
      if (t - lastSweep >= windowMs) {
        for (const [k, w] of windows) if (t - w.start >= windowMs) windows.delete(k);
        lastSweep = t;
      }
      const w = windows.get(key);
      if (!w || t - w.start >= windowMs) {
        windows.set(key, { start: t, count: 1 });
        return { allowed: true };
      }
      w.count += 1;
      if (w.count <= cfg.perWindow) return { allowed: true };
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((w.start + windowMs - t) / 1000)) };
    },
  };
}
