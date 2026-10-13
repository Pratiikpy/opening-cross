import { Rng } from "./prng.js";

export interface Interval {
  mean: number;
  lo: number;
  hi: number;
  n: number;
}

/** Mean with a 95% percentile-bootstrap confidence interval (as research/scripts/sim/mc.py:boot_ci). */
export function bootstrapMean(xs: readonly number[], nBoot = 1000, seed = 0): Interval {
  const x = xs.filter((v) => Number.isFinite(v));
  const n = x.length;
  if (n === 0) return { mean: NaN, lo: NaN, hi: NaN, n: 0 };
  const mean = x.reduce((a, b) => a + b, 0) / n;
  const rng = new Rng(seed, 0xb007);
  const means: number[] = [];
  for (let b = 0; b < nBoot; b++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += x[Math.floor(rng.random() * n)]!;
    means.push(s / n);
  }
  means.sort((a, b) => a - b);
  const q = (p: number) => means[Math.min(nBoot - 1, Math.max(0, Math.floor(p * nBoot)))]!;
  return { mean, lo: q(0.025), hi: q(0.975), n };
}

export function pct(x: number, digits = 2): string {
  return Number.isFinite(x) ? `${(100 * x).toFixed(digits)}%` : "n/a";
}

export function fmtInterval(i: Interval, digits = 2): string {
  return `${pct(i.mean, digits)} [${pct(i.lo, digits)}, ${pct(i.hi, digits)}]`;
}
