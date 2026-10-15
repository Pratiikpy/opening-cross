// The cross-venue venture index (V5), version 0. It follows launches on the Solana venues a public feed shows, from the moment they are first seen, and reports for each venue and
// launch week how many were still alive after a horizon and how their price moved. It is deliberately modest about what it knows:
//
//   * It sees a SAMPLE of each venue's launches, not every one. The feed returns the newest 30 tokens per request; the collector polls it often, records every poll, and the index
//     reports how many polls came back with nothing already seen (a sign that tokens were launched between two polls and missed). No figure is presented as the venue's population.
//   * It follows launches forward. A token is never added because it is still trading today, so the index is not built from survivors.
//   * Where an outcome could not be read (the token is no longer listed, or the resolver ran late), the row says so, and each figure is a pair of bounds: unresolved launches counted
//     as dead (the lower bound), or left out (the upper bound). It never picks one.
//   * The first price is the price when the collector first saw the token (minutes after launch), not the launch price, which nobody could have bought at; the row says so.
//   Venues whose raises are not in the feed (MetaDAO, a team's own sale page) are not covered and the report lists the venues it did see.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface Launch {
  venue: string;
  mint: string;
  /** When the token's first pool was created, unix seconds. */
  createdAt: number;
  firstSeenAt: number;
  firstSeen: { priceUsd: number; liquidityUsd: number; holders: number | null };
}
export type ResolutionStatus = 'priced' | 'no-liquidity' | 'unresolved' | 'missed';
export interface Resolution {
  mint: string;
  horizonDays: number;
  /** When the resolver looked. */
  at: number;
  status: ResolutionStatus;
  priceUsd?: number;
  liquidityUsd?: number;
  why?: string;
}
export interface PollRecord {
  at: number;
  returned: number;
  fresh: number;
}

export interface LaunchStore {
  launches(): Launch[];
  has(mint: string): boolean;
  addLaunch(l: Launch): boolean;
  resolution(mint: string, horizonDays: number): Resolution | null;
  addResolution(r: Resolution): void;
  polls(): PollRecord[];
  addPoll(p: PollRecord): void;
}

export class MemoryLaunchStore implements LaunchStore {
  protected readonly l = new Map<string, Launch>();
  protected readonly r = new Map<string, Resolution>();
  protected readonly p: PollRecord[] = [];
  launches() {
    return [...this.l.values()];
  }
  has(mint: string) {
    return this.l.has(mint);
  }
  addLaunch(x: Launch) {
    if (this.l.has(x.mint)) return false;
    this.l.set(x.mint, x);
    return true;
  }
  resolution(mint: string, h: number) {
    return this.r.get(`${mint}|${h}`) ?? null;
  }
  addResolution(x: Resolution) {
    if (!this.r.has(`${x.mint}|${x.horizonDays}`)) this.r.set(`${x.mint}|${x.horizonDays}`, x);
  }
  polls() {
    return [...this.p];
  }
  addPoll(x: PollRecord) {
    this.p.push(x);
  }
}

/** An append-only JSON-lines file. A line that does not parse is skipped (a write cut short costs one line, not the history). */
export class FileLaunchStore extends MemoryLaunchStore {
  readonly skippedLines: number;
  constructor(readonly path: string) {
    super();
    let skipped = 0;
    if (existsSync(path)) {
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const o = JSON.parse(line) as { type: string } & Record<string, unknown>;
          if (o.type === 'launch') super.addLaunch(o.launch as Launch);
          else if (o.type === 'resolution') super.addResolution(o.resolution as Resolution);
          else if (o.type === 'poll') super.addPoll(o.poll as PollRecord);
          else throw new Error('unknown record');
        } catch {
          skipped += 1;
        }
      }
    } else mkdirSync(dirname(path), { recursive: true });
    this.skippedLines = skipped;
  }
  override addLaunch(x: Launch) {
    const added = super.addLaunch(x);
    if (added) appendFileSync(this.path, `${JSON.stringify({ type: 'launch', launch: x })}\n`);
    return added;
  }
  override addResolution(x: Resolution) {
    if (this.resolution(x.mint, x.horizonDays)) return;
    super.addResolution(x);
    appendFileSync(this.path, `${JSON.stringify({ type: 'resolution', resolution: x })}\n`);
  }
  override addPoll(x: PollRecord) {
    super.addPoll(x);
    appendFileSync(this.path, `${JSON.stringify({ type: 'poll', poll: x })}\n`);
  }
}

// ----------------------------------------------------------------------------------------------------- collecting

interface JupToken {
  id?: unknown;
  launchpad?: unknown;
  metaLaunchpad?: unknown;
  usdPrice?: unknown;
  liquidity?: unknown;
  holderCount?: unknown;
  firstPool?: { createdAt?: unknown };
}

export interface FeedDeps {
  fetch?: typeof fetch;
  /** Unix seconds. */
  now?: () => number;
  base?: string;
}

const BASE = 'https://lite-api.jup.ag/tokens/v2';
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

async function jup(path: string, d: FeedDeps): Promise<unknown> {
  const res = await (d.fetch ?? fetch)(`${d.base ?? BASE}${path}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`the token feed answered HTTP ${res.status}`);
  return res.json();
}

/** One poll of the newest launches. A token with no launchpad is recorded under `unknown`; one with no first-pool time or no price is skipped (it cannot be followed). */
export async function collectOnce(store: LaunchStore, d: FeedDeps = {}): Promise<{ returned: number; fresh: number; skipped: number }> {
  const now = (d.now ? d.now() : Math.floor(Date.now() / 1000));
  const list = (await jup('/recent?limit=100', d)) as JupToken[];
  if (!Array.isArray(list)) throw new Error('the token feed did not answer a list');
  let fresh = 0;
  let skipped = 0;
  for (const t of list) {
    const id = typeof t.id === 'string' ? t.id : null;
    const created = typeof t.firstPool?.createdAt === 'string' ? Math.floor(Date.parse(t.firstPool.createdAt) / 1000) : NaN;
    const price = num(t.usdPrice);
    const liq = num(t.liquidity);
    if (!id || !Number.isFinite(created) || price === null || !(price > 0) || liq === null) {
      skipped += 1;
      continue;
    }
    const venue = typeof t.launchpad === 'string' && t.launchpad ? t.launchpad : 'unknown';
    if (store.addLaunch({ venue, mint: id, createdAt: created, firstSeenAt: now, firstSeen: { priceUsd: price, liquidityUsd: liq, holders: num(t.holderCount) } })) fresh += 1;
  }
  store.addPoll({ at: now, returned: list.length, fresh });
  return { returned: list.length, fresh, skipped };
}

export const ALIVE_LIQUIDITY_USD = 5_000;
/** A resolution made later than this after the horizon fell is `missed`: the price it would read is no longer the price at the horizon. */
export const RESOLVE_GRACE_SECS = 6 * 3_600;

/** Reads the current price and liquidity of every launch whose horizon has just passed. */
export async function resolveDue(store: LaunchStore, horizonDays: number, d: FeedDeps = {}): Promise<{ priced: number; noLiquidity: number; unresolved: number; missed: number }> {
  const now = (d.now ? d.now() : Math.floor(Date.now() / 1000));
  const tally = { priced: 0, noLiquidity: 0, unresolved: 0, missed: 0 };
  for (const l of store.launches()) {
    const due = l.createdAt + horizonDays * 86_400;
    if (due > now || store.resolution(l.mint, horizonDays)) continue;
    if (now - due > RESOLVE_GRACE_SECS) {
      store.addResolution({ mint: l.mint, horizonDays, at: now, status: 'missed', why: `looked ${Math.round((now - due) / 3600)} hours after the horizon` });
      tally.missed += 1;
      continue;
    }
    let found: JupToken | undefined;
    try {
      const r = (await jup(`/search?query=${encodeURIComponent(l.mint)}`, d)) as JupToken[];
      found = Array.isArray(r) ? r.find((t) => t.id === l.mint) : undefined;
    } catch (e) {
      // A failed request is not an answer; the launch is tried again on the next pass while it is within the grace window.
      void e;
      continue;
    }
    const price = num(found?.usdPrice);
    const liq = num(found?.liquidity);
    if (!found || price === null || liq === null) {
      store.addResolution({ mint: l.mint, horizonDays, at: now, status: 'unresolved', why: 'the feed no longer lists the token' });
      tally.unresolved += 1;
    } else if (liq < ALIVE_LIQUIDITY_USD || !(price > 0)) {
      store.addResolution({ mint: l.mint, horizonDays, at: now, status: 'no-liquidity', priceUsd: price, liquidityUsd: liq });
      tally.noLiquidity += 1;
    } else {
      store.addResolution({ mint: l.mint, horizonDays, at: now, status: 'priced', priceUsd: price, liquidityUsd: liq });
      tally.priced += 1;
    }
  }
  return tally;
}

// --------------------------------------------------------------------------------------------------------- the index

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function medianOf(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
/** A seeded bootstrap interval for the median. Null when there are fewer than 5 values: a median of four is not worth an interval. */
export function bootstrapMedian(xs: readonly number[], opts: { seed?: number; draws?: number; level?: number } = {}): { median: number; lo: number; hi: number } | null {
  if (xs.length < 5) return null;
  const r = rng(opts.seed ?? 1);
  const draws = opts.draws ?? 2000;
  const ms: number[] = [];
  for (let i = 0; i < draws; i++) ms.push(medianOf(Array.from({ length: xs.length }, () => xs[Math.floor(r() * xs.length)]!)));
  ms.sort((a, b) => a - b);
  const tail = (1 - (opts.level ?? 0.95)) / 2;
  return { median: medianOf([...xs]), lo: ms[Math.floor(tail * draws)]!, hi: ms[Math.min(draws - 1, Math.floor((1 - tail) * draws))]! };
}

const weekOf = (t: number): string => {
  const d = new Date(t * 1000);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
  return monday.toISOString().slice(0, 10);
};

export interface IndexRow {
  venue: string;
  /** Monday of the week the launches' first pools were created. */
  week: string;
  observed: number;
  /** Launches whose horizon has passed and that have a resolution record of any status. */
  due: number;
  alive: number;
  /** Alive over due, as a lower bound (every unresolved or missed launch counted dead) and an upper bound (every one counted alive). */
  survival: { lower: number | null; upper: number | null };
  unresolved: number;
  missed: number;
  /** Median price change from the first-seen price to the horizon, among launches that were priced alive: bounds as described above. */
  medianReturn: { observedOnly: { median: number; lo: number; hi: number } | null; deadAsLoss: { median: number; lo: number; hi: number } | null };
}

export interface VentureIndex {
  version: 'venture-v0';
  horizonDays: number;
  asOf: number;
  rows: IndexRow[];
  venuesSeen: string[];
  collection: { polls: number; overflowPolls: number; overflowShare: number | null; firstPoll: number | null; lastPoll: number | null };
  limits: string[];
}

export function ventureIndex(store: LaunchStore, horizonDays: number, asOf: number, opts: { seed?: number } = {}): VentureIndex {
  const groups = new Map<string, Launch[]>();
  for (const l of store.launches()) {
    const k = `${l.venue}|${weekOf(l.createdAt)}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(l);
  }
  const rows: IndexRow[] = [];
  for (const [k, ls] of groups) {
    const [venue, week] = k.split('|') as [string, string];
    const res = ls.map((l) => ({ l, r: store.resolution(l.mint, horizonDays) }));
    const resolved = res.filter((x): x is { l: Launch; r: Resolution } => x.r !== null);
    const priced = resolved.filter((x) => x.r.status === 'priced');
    const unresolved = resolved.filter((x) => x.r.status === 'unresolved').length;
    const missed = resolved.filter((x) => x.r.status === 'missed').length;
    const noLiq = resolved.filter((x) => x.r.status === 'no-liquidity').length;
    const due = resolved.length;
    const ret = priced.map((x) => x.r.priceUsd! / x.l.firstSeen.priceUsd - 1);
    const lossAdjusted = [...ret, ...Array.from({ length: noLiq + unresolved + missed }, () => -1)];
    rows.push({
      venue,
      week,
      observed: ls.length,
      due,
      alive: priced.length,
      survival: due === 0 ? { lower: null, upper: null } : { lower: priced.length / due, upper: (priced.length + unresolved + missed) / due },
      unresolved,
      missed,
      medianReturn: {
        observedOnly: bootstrapMedian(ret, { seed: opts.seed ?? 1 }),
        deadAsLoss: bootstrapMedian(lossAdjusted, { seed: opts.seed ?? 1 }),
      },
    });
  }
  rows.sort((a, b) => (a.week === b.week ? a.venue.localeCompare(b.venue) : a.week < b.week ? 1 : -1));
  const polls = store.polls();
  const overflow = polls.filter((p) => p.returned > 0 && p.fresh === p.returned).length;
  return {
    version: 'venture-v0',
    horizonDays,
    asOf,
    rows,
    venuesSeen: [...new Set(store.launches().map((l) => l.venue))].sort(),
    collection: { polls: polls.length, overflowPolls: overflow, overflowShare: polls.length ? overflow / polls.length : null, firstPoll: polls[0]?.at ?? null, lastPoll: polls.at(-1)?.at ?? null },
    limits: [
      'A sample, not a census: the feed returns the newest launches per request. A poll in which every returned token was new means launches may have been missed between polls (overflowPolls).',
      'Followed forward from first sight; the first price is the price when the token was first seen, not a price anyone could have bought at launch.',
      'Venues whose raises are not in the feed (MetaDAO, a team\'s own sale) are not covered.',
      'survival and the two median returns are pairs of bounds: unresolved or missed launches counted dead (lower, or as a loss of everything) or left out (upper, or observed only).',
      'Alive means at least 5,000 USD of liquidity and a price at the horizon.',
    ],
  };
}
