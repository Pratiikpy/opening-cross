// Fair value with a confidence band, from several references of different quality. Prices are integers (micro-USD per whole token);
// the band is integer basis points. The rule is deliberately conservative about WHEN a price may be acted on: a value built from
// stale, thin or disagreeing sources says so (`usable: false`) instead of producing a number a liquidation could be built on.

export type SourceKind = 'cross-print' | 'oracle' | 'reference' | 'last-close';

export type Source = {
  kind: SourceKind;
  /** Micro-USD per whole token. */
  price: bigint;
  /** Unix seconds when the price was observed. */
  at: number;
  /** The source's own stated half-width in bps, if it has one (a Pyth confidence interval). */
  confidenceBps?: number;
  /**
   * True when the price came from a guarded process: a lender-eligible cross print or a Pyth update that passed full
   * verification and the freshness bound. Only guarded prices may justify a liquidation.
   */
  guarded?: boolean;
};

export type ValuationPolicy = {
  now: number;
  /** Is the underlying market open now? A closed market widens the band. */
  marketOpen: boolean;
  /** A source older than this is ignored, per kind, in seconds. */
  maxAgeSec: Record<SourceKind, number>;
  /** The band never narrower than this for the best source's kind, in bps. */
  baseBandBps: Record<SourceKind, number>;
  /** Extra half-width while the market is closed, in bps. */
  closedWideningBps: number;
  /** Sources further apart than this (max versus min fresh price) make the value unusable. */
  disagreementBps: number;
  /** Relative trust when taking the weighted median. */
  trust: Record<SourceKind, number>;
};

export const DEFAULT_VALUATION: Omit<ValuationPolicy, 'now' | 'marketOpen'> = {
  maxAgeSec: { 'cross-print': 7 * 86_400, oracle: 120, reference: 300, 'last-close': 4 * 86_400 },
  baseBandBps: { 'cross-print': 25, oracle: 50, reference: 100, 'last-close': 300 },
  closedWideningBps: 150,
  disagreementBps: 400,
  trust: { 'cross-print': 4, oracle: 3, reference: 2, 'last-close': 1 },
};

export type Valuation = {
  mid: bigint;
  lo: bigint;
  hi: bigint;
  /** Full width of the band, (hi - lo) / mid in bps. */
  widthBps: number;
  usable: boolean;
  guarded: boolean;
  /** Sources that survived the age filter. */
  used: SourceKind[];
  reasons: string[];
};

const bps = (a: bigint, b: bigint) => Number(((a - b) * 10_000n) / (b === 0n ? 1n : b));

/** Weighted median of (price, weight) pairs: the smallest price at which the cumulative weight reaches half. */
function weightedMedian(items: { price: bigint; weight: number }[]): bigint {
  const asc = [...items].sort((a, b) => (a.price < b.price ? -1 : a.price > b.price ? 1 : 0));
  const total = asc.reduce((a, x) => a + x.weight, 0);
  let acc = 0;
  for (const x of asc) {
    acc += x.weight;
    if (acc * 2 >= total) return x.price;
  }
  return asc.at(-1)!.price;
}

export function fairValue(sources: readonly Source[], policy: ValuationPolicy): Valuation {
  const reasons: string[] = [];
  const fresh = sources.filter((s) => {
    const age = policy.now - s.at;
    if (s.price <= 0n) {
      reasons.push(`${s.kind}: non-positive price ignored`);
      return false;
    }
    if (age < 0) {
      reasons.push(`${s.kind}: timestamp in the future ignored`);
      return false;
    }
    if (age > policy.maxAgeSec[s.kind]) {
      reasons.push(`${s.kind}: ${age}s old, limit ${policy.maxAgeSec[s.kind]}s`);
      return false;
    }
    return true;
  });
  if (fresh.length === 0) return { mid: 0n, lo: 0n, hi: 0n, widthBps: 0, usable: false, guarded: false, used: [], reasons: [...reasons, 'no fresh source'] };

  const weighted = fresh.map((s) => {
    const freshness = Math.max(0.1, 1 - (policy.now - s.at) / policy.maxAgeSec[s.kind]);
    return { price: s.price, weight: policy.trust[s.kind] * freshness };
  });
  const mid = weightedMedian(weighted);

  // Half-width: the widest of the best source's floor, the sources' own stated confidence, and twice the sources' spread around the median.
  const best = fresh.reduce((a, b) => (policy.trust[b.kind] > policy.trust[a.kind] ? b : a));
  const stated = Math.max(0, ...fresh.map((s) => s.confidenceBps ?? 0));
  const deviations = fresh.map((s) => Math.abs(bps(s.price, mid))).sort((a, b) => a - b);
  const mad = deviations[Math.floor(deviations.length / 2)] ?? 0;
  let half = Math.max(policy.baseBandBps[best.kind], stated, 2 * mad);
  if (!policy.marketOpen) half += policy.closedWideningBps;
  const lo = (mid * BigInt(10_000 - Math.min(half, 9_999))) / 10_000n;
  const hi = (mid * BigInt(10_000 + half)) / 10_000n;

  let usable = true;
  if (fresh.length >= 2) {
    const prices = fresh.map((s) => s.price);
    const min = prices.reduce((a, b) => (b < a ? b : a));
    const max = prices.reduce((a, b) => (b > a ? b : a));
    const spread = bps(max, min);
    if (spread > policy.disagreementBps) {
      usable = false;
      reasons.push(`sources disagree by ${spread} bps (limit ${policy.disagreementBps})`);
    }
  }
  // A band that already reaches zero says nothing.
  if (half >= 5_000) {
    usable = false;
    reasons.push(`band half-width ${half} bps is too wide to mean anything`);
  }
  // Guarded only if a guarded source is inside the band around the median.
  const guarded = fresh.some((s) => s.guarded === true && s.price >= lo && s.price <= hi);
  if (!guarded) reasons.push('no guarded source inside the band');
  return { mid, lo, hi, widthBps: bps(hi, lo), usable, guarded, used: fresh.map((s) => s.kind), reasons };
}
