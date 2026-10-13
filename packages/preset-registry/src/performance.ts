// How crosses that used a preset fared. Every figure carries the number of crosses behind it; below the minimum sample there is no
// headline, because three crosses say nothing about a preset. Nothing here ranks presets or says one is good: it reports outcomes a
// reader can weigh, and what they do not show.

export interface UsedCross {
  cross: string;
  state: 'Live' | 'Cleared' | 'NoPrint' | 'Finalized';
  creator: string;
  /** Orders placed, and distinct bidding wallets. */
  orders: number;
  wallets: number;
  /** Matched volume against the larger side at the clearing price, in basis points, when the cross printed. */
  matchedBps: number | null;
  /** Wallets that are not the creator and not in the operator's own list. */
  externalWallets: number;
}

export interface Performance {
  /** Crosses that used this preset version (or all versions, by the caller's choice). */
  crosses: number;
  finished: number;
  printed: number;
  /** Share of finished crosses that printed, with a Wilson 95% interval. */
  printRate: { value: number; lo: number; hi: number } | null;
  medianOrders: number | null;
  medianWallets: number | null;
  /** Median share of the larger side that traded, over crosses that printed. */
  medianMatchedBps: number | null;
  /** Crosses whose bidders were all the issuer's own wallets: their numbers say nothing about demand. */
  onlyOwnWallets: number;
  minimumSample: number;
  headline: boolean;
  caveats: string[];
}

function wilson(k: number, n: number): { lo: number; hi: number } {
  const z = 1.959964;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return { lo: k === 0 ? 0 : Math.max(0, c - h), hi: k === n ? 1 : Math.min(1, c + h) };
}
const median = (xs: readonly number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

export function performance(used: readonly UsedCross[], minimumSample = 5): Performance {
  const finished = used.filter((u) => u.state === 'Finalized' || u.state === 'NoPrint');
  const printed = finished.filter((u) => u.matchedBps !== null);
  const n = finished.length;
  const w = n > 0 ? wilson(printed.length, n) : null;
  return {
    crosses: used.length,
    finished: n,
    printed: printed.length,
    printRate: n > 0 && w ? { value: printed.length / n, ...w } : null,
    medianOrders: median(finished.map((u) => u.orders)),
    medianWallets: median(finished.map((u) => u.wallets)),
    medianMatchedBps: median(printed.map((u) => u.matchedBps!)),
    onlyOwnWallets: finished.filter((u) => u.orders > 0 && u.externalWallets === 0).length,
    minimumSample,
    headline: n >= minimumSample,
    caveats: [
      'Outcomes of crosses that used the preset are outcomes of the tokens as much as of the preset: a preset that attracts better issuers looks better without being better.',
      'A cross counts only if its creation transaction carries the preset memo; one that used the same values without the memo is not counted.',
      n < minimumSample ? `Only ${n} finished crosses: below ${minimumSample}, no headline is shown.` : 'No claim is made that the preset caused these outcomes.',
    ],
  };
}
