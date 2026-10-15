// K2: does the weekend risk engine hold up when the collateral is a tokenized stock that trades all weekend?
//
// The engine (ltv.ts) sets a loan-to-value from the underlying's close-to-open gaps and is measured against those gaps (backtest.ts). A tokenized stock changes two things:
//   1. the token has a price while the market is closed, so a lender sees a weekend print, and may be asked to trust it (fair-value.ts) or liquidate on it;
//   2. the token's weekend path can leave the loan underwater at some hour and come back, which a close-to-open gap never sees.
// This module measures both against real data, per weekend: how well the token's weekend move predicts the underlying's Monday gap, how far the token trades from the underlying
// when the market closes, and how often the token's path (at the pre-open print, and at its worst hour) would have breached the loan the engine set for that weekend.
//
// Inputs are hourly bars: the token's in USD (a DEX pool's trades, so an hour with no trade has no bar) and the underlying's regular-session hours. Prices are floats here: this is
// research on observed prices, not money arithmetic, and the engine's own integer arithmetic is untouched.
import { median, quantile, sorted } from './stats.js';

export interface HourBar {
  /** Start of the bar, unix seconds. */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

export interface WeekendObs {
  symbol: string;
  /** The Monday (or first session) date the closure ended on, in New York time, as in the engine's events. */
  date: string;
  /** Underlying's last price of the Friday session and its first price of the Monday session. */
  friday: number;
  monday: number;
  /** Unix seconds of the close and of the open that bound the closure. */
  closeT: number;
  openT: number;
  /** Token price at the close, and at the last hour boundary before the open (what a lender sees pre-open). */
  tokenClose: number;
  tokenPreOpen: number;
  /** Lowest and highest price the token traded between the close and the pre-open print. */
  tokenLow: number;
  tokenHigh: number;
  /** Share of the closure's hours in which the token had a real trade bar (the rest are carried forward). */
  coverage: number;
  /** Hours since the token's last real bar before the pre-open print. */
  preOpenStaleHours: number;
}

const HOUR = 3600;

/**
 * Closures of 2 to 4 days between two sessions (a weekend, or a long weekend) found in the underlying's hourly bars, with the token's prices around them. A closure with no token
 * bar at the close or before the open is skipped, not guessed.
 */
export function weekendObservations(symbol: string, token: readonly HourBar[], underlying: readonly HourBar[], dateOf: (t: number) => string): WeekendObs[] {
  const byT = new Map(token.map((b) => [b.t, b]));
  const out: WeekendObs[] = [];
  // Sessions: split the underlying into runs separated by more than 12 hours.
  const sessions: HourBar[][] = [];
  for (const b of underlying) {
    const last = sessions.at(-1);
    if (last && b.t - last.at(-1)!.t <= 12 * HOUR) last.push(b);
    else sessions.push([b]);
  }
  const tokenAt = (t: number): { price: number; real: boolean; staleHours: number } | null => {
    // The price at time t is the close of the bar that started an hour earlier; failing that, carry the last close forward (at most 12 hours).
    for (let back = 0; back <= 12; back++) {
      const b = byT.get(t - HOUR - back * HOUR);
      if (b) return { price: b.c, real: back === 0, staleHours: back };
    }
    return null;
  };
  for (let i = 1; i < sessions.length; i++) {
    const prev = sessions[i - 1]!;
    const cur = sessions[i]!;
    const lastBar = prev.at(-1)!;
    const firstBar = cur[0]!;
    const closeT = Math.ceil((lastBar.t + 1) / HOUR) * HOUR; // the last regular bar starts at :30 and runs to the close
    const openT = firstBar.t;
    const days = (openT - closeT) / 86_400;
    if (days < 1.5 || days > 4.6) continue;
    const preOpenT = Math.floor(openT / HOUR) * HOUR;
    const atClose = tokenAt(closeT);
    const atPre = tokenAt(preOpenT);
    if (!atClose || !atPre) continue;
    let low = Math.min(atClose.price, atPre.price);
    let high = Math.max(atClose.price, atPre.price);
    let real = 0;
    let hours = 0;
    for (let t = closeT; t < preOpenT; t += HOUR) {
      hours += 1;
      const b = byT.get(t);
      if (b) {
        real += 1;
        low = Math.min(low, b.l);
        high = Math.max(high, b.h);
      }
    }
    out.push({
      symbol,
      date: dateOf(openT),
      friday: lastBar.c,
      monday: firstBar.o,
      closeT,
      openT,
      tokenClose: atClose.price,
      tokenPreOpen: atPre.price,
      tokenLow: low,
      tokenHigh: high,
      coverage: hours === 0 ? 0 : real / hours,
      preOpenStaleHours: atPre.staleHours,
    });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ statistics

const bps = (x: number) => x * 10_000;
const abs = (xs: number[]) => xs.map(Math.abs);

export interface Tracking {
  n: number;
  /** Token price at the market close against the underlying's close, in bps: signed median and the 95th percentile of the absolute value. */
  closeBasisMedianBps: number;
  closeBasisP95Bps: number;
  /** The underlying's actual gap against the token's weekend move: how well the token anticipates Monday. */
  gapMedianAbsBps: number;
  /** |Friday x (tokenPreOpen / tokenClose) - Monday| / Monday, the error of the token-implied Monday open. */
  tokenImpliedErrorMedianBps: number;
  tokenImpliedErrorP95Bps: number;
  /** The same for assuming no move (Friday close as the forecast). */
  naiveErrorMedianBps: number;
  naiveErrorP95Bps: number;
  /** Share of closures in which the token-implied forecast was closer to the Monday open than Friday's close was. */
  tokenBeatsNaive: number;
  /** Among closures where the underlying gapped by at least 50 bps, how often the token's weekend move had the same sign. */
  directionAgreement: { n: number; share: number | null };
  /** OLS slope and R-squared of the actual gap on the token's weekend move (1 and 1 would be a perfect anticipation). */
  slope: number | null;
  rSquared: number | null;
}

export function tracking(obs: readonly WeekendObs[]): Tracking {
  const basis = obs.map((o) => bps(o.tokenClose / o.friday - 1));
  const actual = obs.map((o) => o.monday / o.friday - 1);
  const tokenMove = obs.map((o) => o.tokenPreOpen / o.tokenClose - 1);
  const implied = obs.map((o, i) => Math.abs(o.friday * (1 + tokenMove[i]!) - o.monday) / o.monday);
  const naive = obs.map((o) => Math.abs(o.friday - o.monday) / o.monday);
  const asc = (xs: number[]) => sorted(xs);
  const big = actual.map((g, i) => [g, tokenMove[i]!] as const).filter(([g]) => Math.abs(g) >= 0.005);
  const agree = big.filter(([g, m]) => Math.sign(g) === Math.sign(m)).length;
  let slope: number | null = null;
  let r2: number | null = null;
  if (obs.length >= 3) {
    const mx = tokenMove.reduce((s, x) => s + x, 0) / obs.length;
    const my = actual.reduce((s, x) => s + x, 0) / obs.length;
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < obs.length; i++) {
      sxy += (tokenMove[i]! - mx) * (actual[i]! - my);
      sxx += (tokenMove[i]! - mx) ** 2;
      syy += (actual[i]! - my) ** 2;
    }
    if (sxx > 0 && syy > 0) {
      slope = sxy / sxx;
      r2 = (sxy * sxy) / (sxx * syy);
    }
  }
  const q = (xs: number[], p: number) => (xs.length ? quantile(asc(xs), p) : NaN);
  return {
    n: obs.length,
    closeBasisMedianBps: obs.length ? median(asc(basis)) : NaN,
    closeBasisP95Bps: q(abs(basis), 0.95),
    gapMedianAbsBps: obs.length ? bps(median(asc(abs(actual)))) : NaN,
    tokenImpliedErrorMedianBps: obs.length ? bps(median(asc(implied))) : NaN,
    tokenImpliedErrorP95Bps: bps(q(implied, 0.95)),
    naiveErrorMedianBps: obs.length ? bps(median(asc(naive))) : NaN,
    naiveErrorP95Bps: bps(q(naive, 0.95)),
    tokenBeatsNaive: obs.length ? implied.filter((e, i) => e < naive[i]!).length / obs.length : NaN,
    directionAgreement: { n: big.length, share: big.length ? agree / big.length : null },
    slope,
    rSquared: r2,
  };
}

export interface BreachRow {
  n: number;
  /** The engine's loan-to-value for the weekend, mean, in bps. */
  meanLtvBps: number;
  /** Closures in which the underlying's Monday gap left the loan underwater after the liquidation discount (what the engine's backtest counts). */
  gapBreaches: number;
  /** ... in which the token's price at the pre-open print did. */
  preOpenBreaches: number;
  /** ... in which the token traded at or below the underwater line at any hour of the weekend. */
  weekendLowBreaches: number;
  /** Worst token drawdown from the close, bps (negative), over the weekend, and the worst underlying gap. */
  worstTokenDrawdownBps: number;
  worstGapBps: number;
}

/** A loan at `ltvBps` is underwater once the collateral falls below ltv / (1 - bonus) of its value at the close. */
export const underwaterMove = (ltvBps: number, bonusBps: number): number => ltvBps / (10_000 - bonusBps) - 1;

export function breaches(obs: readonly WeekendObs[], ltvByDate: ReadonlyMap<string, number>, bonusBps: number): BreachRow {
  let n = 0, gap = 0, pre = 0, low = 0, ltvSum = 0;
  let worstDd = 0;
  let worstGap = 0;
  for (const o of obs) {
    const ltv = ltvByDate.get(o.date);
    if (ltv === undefined) continue;
    n += 1;
    ltvSum += ltv;
    const line = underwaterMove(ltv, bonusBps);
    const g = o.monday / o.friday - 1;
    const dd = o.tokenLow / o.tokenClose - 1;
    if (g < line) gap += 1;
    if (o.tokenPreOpen / o.tokenClose - 1 < line) pre += 1;
    if (dd < line) low += 1;
    worstDd = Math.min(worstDd, dd);
    worstGap = Math.min(worstGap, g);
  }
  return { n, meanLtvBps: n ? ltvSum / n : NaN, gapBreaches: gap, preOpenBreaches: pre, weekendLowBreaches: low, worstTokenDrawdownBps: bps(worstDd), worstGapBps: bps(worstGap) };
}
