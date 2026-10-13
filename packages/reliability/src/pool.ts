// Health scoring for a set of RPC endpoints. Every call to an endpoint reports how it went; the pool turns that into an
// order to try them in. Nothing here talks to the network: the failover client feeds it, so it is testable with a clock.

export type Outcome =
  | { kind: 'ok'; ms: number }
  /** HTTP 429 or a JSON-RPC rate-limit error. `retryAfterMs` is the server's own request when it gave one. */
  | { kind: 'rate-limited'; retryAfterMs?: number }
  /** Unreachable, a timeout, HTTP 5xx or an "unhealthy node" JSON-RPC error. */
  | { kind: 'failed'; reason: string };

export interface EndpointStats {
  url: string;
  /** Exponentially weighted success rate, 0 to 1. */
  successRate: number;
  /** Exponentially weighted latency of successful calls, milliseconds. */
  latencyMs: number;
  calls: number;
  rateLimited: number;
  failures: number;
  consecutiveFailures: number;
  /** Unix milliseconds until which the endpoint is skipped, or 0. */
  cooldownUntil: number;
  /** Slots behind the best endpoint at the last probe, or null if never probed. */
  slotLag: number | null;
  lastError: string | null;
  score: number;
}

export interface PoolOptions {
  now?: () => number;
  /** Weight of the newest observation. Default 0.2. */
  alpha?: number;
  /** Longest an endpoint is skipped after repeated trouble. Default 60 s. */
  maxCooldownMs?: number;
  /** Endpoints this many slots behind the best are not used for reads while a better one is available. Default 40. */
  maxSlotLag?: number;
}

interface State {
  url: string;
  successRate: number;
  latencyMs: number;
  calls: number;
  rateLimited: number;
  failures: number;
  consecutiveBad: number;
  cooldownUntil: number;
  slotLag: number | null;
  lastError: string | null;
}

export class EndpointPool {
  private readonly states: State[];
  private readonly now: () => number;
  private readonly alpha: number;
  private readonly maxCooldownMs: number;
  private readonly maxSlotLag: number;

  constructor(urls: readonly string[], opts: PoolOptions = {}) {
    const unique = [...new Set(urls.map((u) => u.trim()).filter(Boolean))];
    if (unique.length === 0) throw new Error('an endpoint pool needs at least one URL');
    this.now = opts.now ?? Date.now;
    this.alpha = opts.alpha ?? 0.2;
    this.maxCooldownMs = opts.maxCooldownMs ?? 60_000;
    this.maxSlotLag = opts.maxSlotLag ?? 40;
    // An endpoint nobody has tried yet is assumed good but not perfect, and the order given breaks ties: the first URL is the one the operator trusts most.
    this.states = unique.map((url) => ({ url, successRate: 0.9, latencyMs: 300, calls: 0, rateLimited: 0, failures: 0, consecutiveBad: 0, cooldownUntil: 0, slotLag: null, lastError: null }));
  }

  get urls(): string[] {
    return this.states.map((s) => s.url);
  }

  private find(url: string): State {
    const s = this.states.find((x) => x.url === url);
    if (!s) throw new Error(`unknown endpoint ${url}`);
    return s;
  }

  private score(s: State): number {
    return (s.successRate * 1000) / (s.latencyMs + 100);
  }

  /** Endpoints in the order to try them: those not cooling down and not lagging first, best score first; the rest after, soonest to recover first. */
  order(): string[] {
    const t = this.now();
    const usable = (s: State) => s.cooldownUntil <= t && (s.slotLag === null || s.slotLag <= this.maxSlotLag);
    const idx = new Map(this.states.map((s, i) => [s.url, i]));
    const good = this.states.filter(usable).sort((a, b) => this.score(b) - this.score(a) || idx.get(a.url)! - idx.get(b.url)!);
    const rest = this.states.filter((s) => !usable(s)).sort((a, b) => a.cooldownUntil - b.cooldownUntil || (a.slotLag ?? 0) - (b.slotLag ?? 0));
    return [...good, ...rest].map((s) => s.url);
  }

  record(url: string, outcome: Outcome): void {
    const s = this.find(url);
    const t = this.now();
    s.calls += 1;
    const a = this.alpha;
    if (outcome.kind === 'ok') {
      s.successRate += a * (1 - s.successRate);
      s.latencyMs += a * (Math.max(1, outcome.ms) - s.latencyMs);
      s.consecutiveBad = 0;
      s.cooldownUntil = 0;
      return;
    }
    s.consecutiveBad += 1;
    s.successRate += a * (0 - s.successRate);
    if (outcome.kind === 'rate-limited') {
      s.rateLimited += 1;
      s.lastError = 'rate limited';
      // A rate limit clears: honour what the server asked, else back off from one second.
      const own = Math.min(this.maxCooldownMs, 1_000 * 2 ** (s.consecutiveBad - 1));
      s.cooldownUntil = t + Math.min(this.maxCooldownMs, Math.max(outcome.retryAfterMs ?? 0, own));
    } else {
      s.failures += 1;
      s.lastError = outcome.reason;
      // One failure may be a blip; from the second on, the endpoint rests for longer each time.
      if (s.consecutiveBad >= 2) s.cooldownUntil = t + Math.min(this.maxCooldownMs, 2_000 * 2 ** (s.consecutiveBad - 2));
    }
  }

  /** Records how far behind the best endpoint each one is, from a round of slot probes. `null` marks a probe that failed. */
  recordSlots(slots: ReadonlyMap<string, number | null>): void {
    const known = [...slots.values()].filter((v): v is number => v !== null);
    const best = known.length ? Math.max(...known) : null;
    for (const [url, slot] of slots) {
      const s = this.find(url);
      s.slotLag = slot === null || best === null ? null : best - slot;
    }
  }

  snapshot(): EndpointStats[] {
    return this.states.map((s) => ({
      url: s.url,
      successRate: s.successRate,
      latencyMs: s.latencyMs,
      calls: s.calls,
      rateLimited: s.rateLimited,
      failures: s.failures,
      consecutiveFailures: s.consecutiveBad,
      cooldownUntil: s.cooldownUntil,
      slotLag: s.slotLag,
      lastError: s.lastError,
      score: this.score(s),
    }));
  }
}
