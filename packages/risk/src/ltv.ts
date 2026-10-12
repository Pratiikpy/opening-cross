// Gap-aware maximum loan-to-value. The loan is safe against a closed-market gap if, after the gap, the collateral sold at the
// liquidation discount still covers the debt:
//
//     debt <= collateral * (1 + gap) * (1 - bonus)        =>        LTV <= (1 + gap) * (1 - bonus)
//
// `gap` is the worst return the policy is willing to be exposed to, chosen so that the chance of a worse one is at most `alpha`,
// certified from the asset's own history by a distribution-free bound (stats.ts). All results are integer basis points.
import type { Closure, GapStats } from './gaps.js';
import { certifiedRank, minimumSample } from './stats.js';

export type LtvPolicy = {
  /**
   * Highest acceptable probability that one closure of each class produces bad debt. Weekends and holiday weekends are rarer than
   * overnight closures, so the same history certifies a looser alpha for them; the numbers are the policy's, not the data's.
   */
  alpha: Record<Closure, number>;
  /** Confidence that the history bounds that probability (default 0.95). */
  confidence: number;
  /** Discount at which a liquidator buys the collateral, in bps. */
  liquidationBonusBps: number;
  /** Safety margin subtracted from the result, in bps. */
  bufferBps: number;
  /** Never lend above this, whatever the history says. */
  capBps: number;
  /** Assume at least this loss even if history is calm: no asset is certified to never gap. */
  minLossBps: number;
  /** When history is too short to certify alpha, scale the worst observed loss by this (default 1.5) and cap the LTV at `uncertifiedCapBps`. */
  stressFactor: number;
  uncertifiedCapBps: number;
};

export const DEFAULT_POLICY: LtvPolicy = {
  alpha: { overnight: 0.005, weekend: 0.01, long: 0.02 },
  confidence: 0.95,
  liquidationBonusBps: 500,
  bufferBps: 100,
  capBps: 8_000,
  minLossBps: 1_000,
  stressFactor: 1.5,
  uncertifiedCapBps: 4_000,
};

export type LtvResult = {
  ltvBps: number;
  /** True when the history certifies `alpha` at `confidence`; false means the stressed fallback was used. */
  certified: boolean;
  /** The loss the LTV covers, in bps of the collateral value. */
  coveredLossBps: number;
  /** Observations behind it and the rank used (1 = the worst observation). */
  n: number;
  rank: number | null;
  basis: string;
};

const bpsOfUnits = (units: number) => units / 100;

/** Maximum LTV for one closure class from that asset's history. */
export function maxLtv(stats: GapStats, policy: LtvPolicy = DEFAULT_POLICY): LtvResult {
  const { n } = stats;
  const alpha = policy.alpha[stats.closure];
  const rank = certifiedRank(n, alpha, policy.confidence);
  let lossBps: number;
  let certified: boolean;
  let basis: string;
  if (rank !== null) {
    lossBps = Math.max(0, -bpsOfUnits(stats.returns[rank - 1]!));
    certified = true;
    basis = `${rank === 1 ? 'worst' : `${rank}th worst`} of ${n} ${stats.closure} gaps bounds P(bad debt) <= ${alpha} at ${policy.confidence} confidence`;
  } else {
    const worst = n > 0 ? Math.max(0, -bpsOfUnits(stats.returns[0]!)) : policy.minLossBps;
    lossBps = Math.max(policy.minLossBps, worst * policy.stressFactor);
    certified = false;
    basis = `only ${n} ${stats.closure} gaps; ${minimumSample(alpha, policy.confidence)} are needed to certify P(bad debt) <= ${alpha} at ${policy.confidence}; worst observed x ${policy.stressFactor}, capped at ${policy.uncertifiedCapBps} bps`;
  }
  lossBps = Math.max(lossBps, policy.minLossBps);
  const raw = Math.floor(((10_000 - lossBps) * (10_000 - policy.liquidationBonusBps)) / 10_000) - policy.bufferBps;
  const cap = certified ? policy.capBps : Math.min(policy.capBps, policy.uncertifiedCapBps);
  return { ltvBps: Math.max(0, Math.min(cap, raw)), certified, coveredLossBps: Math.round(lossBps), n, rank, basis };
}

/**
 * Pools peers' returns into a target's sample, each peer's returns scaled by sigma(target) / sigma(peer), so a rare-event bound can be
 * certified when the target's own history is too short. The scaling assumes peers' tails look like the target's after rescaling for
 * volatility, which is an assumption the target's own data cannot confirm: the result says so in `closure`-level basis text via
 * `pooled: true`, and callers should prefer own history whenever it certifies.
 */
export function pooled(target: GapStats, peers: readonly GapStats[]): GapStats & { pooled: true } {
  const sigma = target.n > 2 ? target.stdev : 0;
  const returns = [...target.returns];
  for (const p of peers) {
    if (p.n < 2 || p.stdev === 0 || sigma === 0) continue;
    const k = sigma / p.stdev;
    for (const r of p.returns) returns.push(Math.round(r * k));
  }
  returns.sort((a, b) => a - b);
  return { ...target, n: returns.length, returns, pooled: true };
}

/** Hours the market stays closed -> which closure class governs the loan until the next open. */
export function closureForHours(hoursClosed: number): Closure {
  return hoursClosed <= 26 ? 'overnight' : hoursClosed <= 80 ? 'weekend' : 'long';
}

/**
 * The LTV to apply now, given how long the market will stay closed from now: a position opened on Friday afternoon must survive the
 * weekend, one opened on Monday only the next night. `statsByClosure` holds the asset's history per class; a class with no history
 * falls back to the stressed rule with n = 0 (and so a low, uncertified LTV).
 */
export function ltvFor(hoursClosed: number, statsByClosure: Partial<Record<Closure, GapStats>>, policy: LtvPolicy = DEFAULT_POLICY): LtvResult & { closure: Closure } {
  const closure = closureForHours(hoursClosed);
  // A longer closure also covers a shorter one's exposure: never lend more for a weekend than the overnight history allows.
  const classes: Closure[] = closure === 'overnight' ? ['overnight'] : closure === 'weekend' ? ['overnight', 'weekend'] : ['overnight', 'weekend', 'long'];
  let worst: LtvResult | null = null;
  for (const c of classes) {
    const s = statsByClosure[c] ?? { closure: c, n: 0, mean: 0, stdev: 0, returns: [] };
    const r = maxLtv(s, policy);
    if (!worst || r.ltvBps < worst.ltvBps) worst = r;
  }
  return { ...worst!, closure };
}
