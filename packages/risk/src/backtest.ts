// Walk-forward backtest: for every closed-market gap in an asset's history, set the LTV from ONLY the gaps before it (no lookahead),
// open a loan at that LTV at the previous close, and see whether the gap would have caused bad debt. The same events are replayed
// against fixed-LTV policies, which is what a lender without a gap model does.
import { type Bar, type Closure, type Gap, gapsOf, statsOf } from './gaps.js';
import { DEFAULT_POLICY, type LtvPolicy, maxLtv } from './ltv.js';

export type Outcome = { policy: string; events: number; badDebt: number; badDebtRate: number; meanLtvBps: number; lossOfDebtBps: number; worstLossOfDebtBps: number; certifiedShare: number };

export type BacktestEvent = { ticker: string; date: string; closure: Closure; retBps: number; ltvBps: number; certified: boolean };

/** Bad-debt test in integers: the collateral after the gap, sold at the liquidation discount, must cover the debt. */
export function badDebtBps(ltvBps: number, retUnits: number, bonusBps: number): number {
  const retBps = retUnits / 100; // units are 1e-6, bps are 1e-4
  const recoverableOfCollateral = ((10_000 + retBps) * (10_000 - bonusBps)) / 10_000; // in bps of the collateral's pre-gap value
  if (recoverableOfCollateral >= ltvBps) return 0;
  return Math.round(((ltvBps - recoverableOfCollateral) * 10_000) / ltvBps); // loss as bps of the debt
}

/** Events for one asset: each gap with the LTV the engine would have set from the gaps before it. */
export function engineEvents(ticker: string, gaps: readonly Gap[], policy: LtvPolicy, minHistory: number, closures: readonly Closure[] = ['weekend', 'long']): BacktestEvent[] {
  const events: BacktestEvent[] = [];
  const history: Record<Closure, number[]> = { overnight: [], weekend: [], long: [] };
  for (const g of gaps) {
    if (closures.includes(g.closure)) {
      const classes: Closure[] = g.closure === 'overnight' ? ['overnight'] : g.closure === 'weekend' ? ['overnight', 'weekend'] : ['overnight', 'weekend', 'long'];
      // The loan must survive the whole closure class and the shorter ones inside it, as ltvFor does.
      if (history[g.closure].length >= minHistory) {
        let ltv = Infinity;
        let certified = true;
        for (const c of classes) {
          const s = statsOf(history[c].map((ret) => ({ ret, closure: c }) as Gap), c);
          const r = maxLtv(s, policy);
          ltv = Math.min(ltv, r.ltvBps);
          certified &&= r.certified;
        }
        events.push({ ticker, date: g.date, closure: g.closure, retBps: g.ret / 100, ltvBps: ltv, certified });
      }
    }
    history[g.closure].push(g.ret);
  }
  return events;
}

export function summariseOutcomes(name: string, events: readonly { retBps: number; ltvBps: number; certified?: boolean }[], bonusBps: number): Outcome {
  let bad = 0;
  let debt = 0;
  let lost = 0;
  let worst = 0;
  let certified = 0;
  let ltvSum = 0;
  for (const e of events) {
    const loss = badDebtBps(e.ltvBps, e.retBps * 100, bonusBps);
    ltvSum += e.ltvBps;
    debt += e.ltvBps; // the collateral is 10,000 per event, so debt is its LTV in the same units
    if (loss > 0) {
      bad++;
      lost += (loss * e.ltvBps) / 10_000;
      worst = Math.max(worst, loss);
    }
    if (e.certified) certified++;
  }
  const n = events.length;
  return { policy: name, events: n, badDebt: bad, badDebtRate: n ? bad / n : 0, meanLtvBps: n ? Math.round(ltvSum / n) : 0, lossOfDebtBps: debt ? Math.round((lost * 10_000) / debt) : 0, worstLossOfDebtBps: worst, certifiedShare: n ? certified / n : 0 };
}

export type Report = { bonusBps: number; minHistory: number; assets: number; perPolicy: Outcome[]; perAsset: { ticker: string; engine: Outcome; fixed70: Outcome }[] };

export function backtest(series: Record<string, readonly Bar[]>, policy: LtvPolicy = DEFAULT_POLICY, minHistory = 100, fixed: readonly number[] = [5_000, 6_000, 7_000, 8_000]): Report {
  const all: BacktestEvent[] = [];
  const perAsset: Report['perAsset'] = [];
  for (const [ticker, bars] of Object.entries(series)) {
    const ev = engineEvents(ticker, gapsOf(bars), policy, minHistory);
    all.push(...ev);
    perAsset.push({
      ticker,
      engine: summariseOutcomes('engine', ev, policy.liquidationBonusBps),
      fixed70: summariseOutcomes('fixed 70%', ev.map((e) => ({ ...e, ltvBps: 7_000 })), policy.liquidationBonusBps),
    });
  }
  const perPolicy = [summariseOutcomes('engine (gap-aware, certified)', all, policy.liquidationBonusBps), ...fixed.map((f) => summariseOutcomes(`fixed ${f / 100}%`, all.map((e) => ({ ...e, ltvBps: f })), policy.liquidationBonusBps))];
  return { bonusBps: policy.liquidationBonusBps, minHistory, assets: Object.keys(series).length, perPolicy, perAsset };
}
