import type { AuctionOptions, Scenario } from "./params.js";
import { simulate, type SimResult } from "./engine.js";
import type { MechName } from "./mechanisms.js";
import { bootstrapMean, type Interval } from "./stats.js";

export interface CellSummary {
  mech: MechName;
  scenario: string;
  label: string;
  runs: number;
  failed: number;
  /** Mean over runs of the per-run sniper gain share, with a 95% bootstrap CI (the definition R2 uses). */
  share: Interval;
  /** Sum of snipers' positive P&L over sum of everyone's positive P&L across all runs (pooled, robustness view). */
  pooledShare: number;
  /** Median over runs of the per-run share. */
  medianShare: number;
  /** Median of the discovery price divided by the latent fair price. */
  medianDiscRatio: number;
  /** Fraction of runs with at least one sniper or bundler holding a positive P&L. */
  runsWithFastGain: number;
  retailRoi: Interval;
  sniperShareOfSale: Interval;
  discRatio: Interval;
  maxLedgerResidualRel: number;
}

export interface CellSpec {
  mech: MechName;
  sc: Scenario;
  label: string;
  auction?: Partial<AuctionOptions> | undefined;
}

export function runCell(spec: CellSpec, seeds: readonly number[], bootSeed = 0): CellSummary {
  const res: SimResult[] = seeds.map((s) => simulate(spec.mech, spec.sc, s, { auction: spec.auction }));
  const ok = res.filter((r) => !r.failed);
  let fastSum = 0;
  let allSum = 0;
  let withGain = 0;
  let maxRel = 0;
  for (const r of ok) {
    fastSum += r.fastPositivePnl;
    allSum += r.allPositivePnl;
    if (r.fastPositivePnl > 0) withGain++;
    maxRel = Math.max(maxRel, Math.abs(r.ledgerResidual) / r.ledgerScale);
  }
  return {
    mech: spec.mech,
    scenario: spec.sc.name,
    label: spec.label,
    runs: res.length,
    failed: res.length - ok.length,
    share: bootstrapMean(ok.map((r) => r.sniperGainShare), 1000, bootSeed),
    pooledShare: allSum > 0 ? fastSum / allSum : 0,
    medianShare: median(ok.map((r) => r.sniperGainShare)),
    medianDiscRatio: median(ok.map((r) => r.discRatio)),
    runsWithFastGain: ok.length > 0 ? withGain / ok.length : 0,
    retailRoi: bootstrapMean(ok.map((r) => r.retailRoi), 1000, bootSeed),
    sniperShareOfSale: bootstrapMean(ok.map((r) => r.sniperShareSale), 1000, bootSeed),
    discRatio: bootstrapMean(ok.map((r) => r.discRatio), 1000, bootSeed),
    maxLedgerResidualRel: maxRel,
  };
}

export function seedRange(first: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) => first + i);
}

function median(xs: number[]): number {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return NaN;
  const m = v.length >> 1;
  return v.length % 2 ? v[m]! : (v[m - 1]! + v[m]!) / 2;
}
