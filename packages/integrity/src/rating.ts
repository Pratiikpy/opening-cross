// An open rating of a cross (V5), and the honest record of how well such ratings have predicted anything.
//
// The rating is a weighted sum of components each computed from a published fact; the weights are ours, chosen to be readable, not
// fitted to outcomes, and the version says so. A rating is not a prediction until its track record shows it predicts. The track
// record is therefore part of the product: it publishes the hit rate against the rate of always guessing the commoner outcome, the
// rank correlation with a permutation p-value, and a plain statement when the rating does NOT beat chance or when the sample is
// too small to say. No AUC or accuracy is claimed anywhere else.
import type { BackingResult } from './backing.js';
import type { ConflictReport } from './conflicts.js';
import type { HolderReport } from './holders.js';
import type { OrganicReport } from './organic.js';

export const RATING_VERSION = 'v0-unfitted';

export interface RatingInput {
  /** True once the cross has printed; false if it ended without a price; null while it is live. */
  printed: boolean | null;
  clearing?: { matched: bigint; demand: bigint; supply: bigint } | null;
  organic?: OrganicReport | null;
  conflicts?: ConflictReport | null;
  holders?: HolderReport | null;
  mintAuthority?: string | null;
  /** Present only for a token that claims real-asset backing. */
  backing?: BackingResult | null;
}

export interface Component {
  name: string;
  weight: number;
  /** 0 to 100, or null when the fact is not available. */
  score: number | null;
  basis: string;
}

export interface Rating {
  version: typeof RATING_VERSION;
  /** 0 to 100, or null when the rating abstains. */
  score: number | null;
  status: 'rated' | 'abstained' | 'unrated';
  reason: string;
  components: Component[];
  /** Weight of the components that had data, out of 100. */
  coverage: number;
}

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

export function rateCross(i: RatingInput): Rating {
  if (i.printed === null) return { version: RATING_VERSION, score: null, status: 'unrated', reason: 'The cross is still live; it is rated once it has printed.', components: [], coverage: 0 };
  if (i.printed === false) return { version: RATING_VERSION, score: null, status: 'unrated', reason: 'The cross ended without a price, so there is no outcome to rate.', components: [], coverage: 0 };
  const c: Component[] = [];
  c.push(
    i.organic
      ? { name: 'breadth', weight: 20, score: clamp(i.organic.breadth.independentGroups * 5), basis: `${i.organic.breadth.independentGroups} independent bidder groups (20 or more scores 100)` }
      : { name: 'breadth', weight: 20, score: null, basis: 'no organic-volume analysis' },
    i.organic
      ? { name: 'organic-volume', weight: 20, score: clamp(i.organic.lowerBps / 100), basis: `${i.organic.lowerBps / 100}% of volume shown organic (upper bound ${i.organic.upperBps / 100}%)` }
      : { name: 'organic-volume', weight: 20, score: null, basis: 'no organic-volume analysis' },
    i.clearing && (i.clearing.demand > 0n || i.clearing.supply > 0n)
      ? (() => {
          const side = i.clearing.demand > i.clearing.supply ? i.clearing.demand : i.clearing.supply;
          const s = side === 0n ? 0 : Number((i.clearing.matched * 10_000n) / side) / 100;
          return { name: 'clearing', weight: 20, score: clamp(s), basis: `${i.clearing.matched} of the larger side's ${side} atoms traded` };
        })()
      : { name: 'clearing', weight: 20, score: null, basis: 'no clearing summary' },
    i.conflicts
      ? { name: 'conflicts', weight: 15, score: clamp(100 - i.conflicts.flagged.volumeBps / 100), basis: `${i.conflicts.flagged.volumeBps / 100}% of known volume is from flagged bidders` }
      : { name: 'conflicts', weight: 15, score: null, basis: 'no conflict analysis' },
  );
  if (i.holders || i.mintAuthority !== undefined) {
    const insiders = (i.holders?.byKind.issuer?.shareBps ?? 0) + (i.holders?.byKind.team?.shareBps ?? 0);
    const authority = i.mintAuthority ? 25 : 0;
    c.push({ name: 'openness', weight: 15, score: clamp(100 - insiders / 100 - authority), basis: `issuer and team hold ${insiders / 100}% of listed holdings${i.mintAuthority ? '; the mint authority is still set' : ''}` });
  } else c.push({ name: 'openness', weight: 15, score: null, basis: 'no holder or mint data' });
  if (i.backing) {
    const m = { verified: 100, stale: 40, undercollateralised: 0, unverifiable: 0 }[i.backing.status];
    c.push({ name: 'backing', weight: 10, score: m, basis: `backing is ${i.backing.status}` });
  }
  const have = c.filter((x) => x.score !== null);
  const coverage = have.reduce((s, x) => s + x.weight, 0);
  if (coverage < 50) return { version: RATING_VERSION, score: null, status: 'abstained', reason: `Only ${coverage} of 100 weight has data; the rating abstains rather than guess.`, components: c, coverage };
  const score = Math.round(have.reduce((s, x) => s + x.weight * x.score!, 0) / coverage);
  return { version: RATING_VERSION, score, status: 'rated', reason: coverage < 100 ? `Rated on ${coverage} of 100 weight; the missing components are listed.` : 'Rated on all components.', components: c, coverage };
}

// ---------------------------------------------------------------------------------------------------- track record

export interface RatedOutcome {
  cross: string;
  score: number;
  /** What happened afterwards, in basis points (for example the price return from the clearing price to a later price). */
  outcomeBps: number;
}

export interface TrackRecord {
  n: number;
  status: 'insufficient-sample' | 'beats-chance' | 'does-not-beat-chance';
  /** Share of ratings on the right side of the median whose outcome was on the same side of zero. */
  hitRate: number | null;
  /** The hit rate of always guessing the commoner outcome. */
  baselineRate: number | null;
  /** One-sided exact binomial p-value that the hit rate exceeds the baseline by luck. */
  hitPValue: number | null;
  spearman: number | null;
  /** One-sided permutation p-value that the rank correlation is positive by luck (seeded, repeatable). */
  spearmanPValue: number | null;
  statement: string;
}

/** Fractional ranks, ties averaged. */
function ranks(xs: readonly number[]): number[] {
  const idx = xs.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  const r = new Array<number>(xs.length);
  for (let i = 0; i < idx.length; ) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1]![0] === idx[i]![0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[idx[k]![1]] = avg;
    i = j + 1;
  }
  return r;
}
function pearson(a: readonly number[], b: readonly number[]): number {
  const n = a.length;
  const ma = a.reduce((s, x) => s + x, 0) / n;
  const mb = b.reduce((s, x) => s + x, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i]! - ma) * (b[i]! - mb);
    da += (a[i]! - ma) ** 2;
    db += (b[i]! - mb) ** 2;
  }
  return da === 0 || db === 0 ? 0 : num / Math.sqrt(da * db);
}
/** P(X >= k) for X ~ Binomial(n, p). */
export function binomialUpperTail(n: number, k: number, p: number): number {
  if (k <= 0) return 1;
  let logC = 0; // log C(n, 0)
  const terms: number[] = [];
  for (let i = 0; i <= n; i++) {
    if (i > 0) logC += Math.log(n - i + 1) - Math.log(i);
    terms.push(logC + (i === 0 ? 0 : i * Math.log(p)) + (n - i === 0 ? 0 : (n - i) * Math.log(1 - p)));
  }
  let s = 0;
  for (let i = k; i <= n; i++) s += Math.exp(terms[i]!);
  return Math.min(1, s);
}
function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function trackRecord(rows: readonly RatedOutcome[], opts: { minSample?: number; permutations?: number; seed?: number } = {}): TrackRecord {
  const n = rows.length;
  const min = opts.minSample ?? 20;
  if (n < min) return { n, status: 'insufficient-sample', hitRate: null, baselineRate: null, hitPValue: null, spearman: null, spearmanPValue: null, statement: `${n} rated crosses have a recorded outcome; at least ${min} are needed before a hit rate means anything. No claim is made.` };
  const sorted = [...rows].map((r) => r.score).sort((a, b) => a - b);
  const median = sorted[Math.floor(n / 2)]!;
  let hits = 0;
  let positives = 0;
  let counted = 0;
  for (const r of rows) {
    if (r.outcomeBps === 0) continue; // no direction to call
    counted += 1;
    const predictUp = r.score >= median;
    const up = r.outcomeBps > 0;
    if (up) positives += 1;
    if (predictUp === up) hits += 1;
  }
  const baseline = counted === 0 ? 0.5 : Math.max(positives, counted - positives) / counted;
  const hitRate = counted === 0 ? 0 : hits / counted;
  const hitP = counted === 0 ? 1 : binomialUpperTail(counted, hits, baseline);
  const rs = ranks(rows.map((r) => r.score));
  const ro = ranks(rows.map((r) => r.outcomeBps));
  const rho = pearson(rs, ro);
  const rand = mulberry(opts.seed ?? 1);
  const perms = opts.permutations ?? 2000;
  let ge = 0;
  const shuffled = [...ro];
  for (let p = 0; p < perms; p++) {
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
    }
    if (pearson(rs, shuffled) >= rho - 1e-12) ge += 1;
  }
  const rhoP = (ge + 1) / (perms + 1);
  const beats = hitP < 0.05 && rhoP < 0.05 && hitRate > baseline;
  return {
    n,
    status: beats ? 'beats-chance' : 'does-not-beat-chance',
    hitRate,
    baselineRate: baseline,
    hitPValue: hitP,
    spearman: rho,
    spearmanPValue: rhoP,
    statement: beats
      ? `Over ${n} crosses the rating's call matched the outcome ${(hitRate * 100).toFixed(1)}% of the time against ${(baseline * 100).toFixed(1)}% for always guessing the commoner outcome (p = ${hitP.toFixed(3)}); rank correlation ${rho.toFixed(2)} (p = ${rhoP.toFixed(3)}).`
      : `Over ${n} crosses the rating does NOT beat chance: it matched the outcome ${(hitRate * 100).toFixed(1)}% of the time against ${(baseline * 100).toFixed(1)}% for always guessing the commoner outcome (p = ${hitP.toFixed(3)}); rank correlation ${rho.toFixed(2)} (p = ${rhoP.toFixed(3)}).`,
  };
}
