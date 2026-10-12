// Gap statistics from daily bars. A "gap" is the return from one session's close to the next session's open: the move that
// happens while the market is closed and a lender cannot act on a fresh price. Classified by how long the market was shut.
import { UNITS, mean, quantile, sorted, stdev } from './stats.js';

/** A daily bar with prices as integer micro-dollars (price * 1,000,000, rounded). */
export type Bar = { date: string; open: number; high: number; low: number; close: number };

/** How long the market was closed before the open. Overnight: one day. Weekend: Friday to Monday. Long: a holiday weekend or longer. */
export type Closure = 'overnight' | 'weekend' | 'long';

export type Gap = {
  /** The date of the open that ended the closure. */
  date: string;
  closure: Closure;
  /** Calendar days between the two sessions. */
  days: number;
  /** open / previous close - 1, in units (1 unit = 0.0001 percent). */
  ret: number;
  /** The previous close and this open, micro-dollars. */
  from: number;
  to: number;
};

const dayNumber = (d: string) => Math.floor(Date.parse(`${d}T00:00:00Z`) / 86_400_000);

export function classify(days: number): Closure {
  return days <= 1 ? 'overnight' : days <= 3 ? 'weekend' : 'long';
}

/** Every close-to-open gap in a series of bars in date order. Bars with a non-positive price are rejected loudly. */
export function gapsOf(bars: readonly Bar[]): Gap[] {
  const out: Gap[] = [];
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1]!;
    const cur = bars[i]!;
    if (prev.close <= 0 || cur.open <= 0) throw new Error(`non-positive price near ${cur.date}`);
    const days = dayNumber(cur.date) - dayNumber(prev.date);
    if (days <= 0) throw new Error(`bars out of order at ${cur.date}`);
    // Integer arithmetic on micro-dollars: ret = round((open - close) * UNITS / close).
    const ret = Math.round(((cur.open - prev.close) * UNITS) / prev.close);
    out.push({ date: cur.date, closure: classify(days), days, ret, from: prev.close, to: cur.open });
  }
  return out;
}

export type GapStats = {
  closure: Closure;
  n: number;
  mean: number;
  stdev: number;
  /** Ascending returns, kept so the certified bound can be computed; derived statistics only are published (see GapSummary). */
  returns: number[];
};

export function statsOf(gaps: readonly Gap[], closure: Closure): GapStats {
  const returns = sorted(gaps.filter((g) => g.closure === closure).map((g) => g.ret));
  return { closure, n: returns.length, mean: returns.length ? mean(returns) : 0, stdev: returns.length ? stdev(returns) : 0, returns };
}

/** What is published about an asset: no raw prices, only the shape of the gap distribution. */
export type GapSummary = {
  closure: Closure;
  n: number;
  /** Quantiles of the return, in units. */
  q: { p001: number; p005: number; p01: number; p025: number; p05: number; p50: number; p95: number };
  worst: number;
  best: number;
  /** How many gaps fell below -5%, -10%, -20%. */
  below: { m5: number; m10: number; m20: number };
};

export function summarise(s: GapStats): GapSummary | null {
  if (s.n === 0) return null;
  const r = s.returns;
  const count = (floor: number) => r.filter((x) => x < floor).length;
  return {
    closure: s.closure,
    n: s.n,
    q: { p001: quantile(r, 0.001), p005: quantile(r, 0.005), p01: quantile(r, 0.01), p025: quantile(r, 0.025), p05: quantile(r, 0.05), p50: quantile(r, 0.5), p95: quantile(r, 0.95) },
    worst: r[0]!,
    best: r[r.length - 1]!,
    below: { m5: count(-0.05 * UNITS), m10: count(-0.1 * UNITS), m20: count(-0.2 * UNITS) },
  };
}
