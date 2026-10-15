// Whether a rated cross's token was still alive thirty days after trading began: the label the organic-volume bar (V-A) is scored against. "Alive" is the same test the venture index
// uses: a listed price and at least 5,000 USD of liquidity. A look made long after the thirty days is `missed`, because today's liquidity says nothing about day thirty.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ALIVE_LIQUIDITY_USD, RESOLVE_GRACE_SECS, type FeedDeps } from './venture.js';
import type { Pg } from './outcomes.js';

export interface RatedCross {
  cross: string;
  baseMint: string;
  startsTs: number;
  score: number;
  /** The organic-volume component of the rating, as a share of volume in basis points, or null when the rating had none. */
  organicLowerBps: number | null;
  /** Base atoms matched, the raw volume a reader would use. */
  matchedBase: bigint | null;
  ratedAt: number;
}

export interface SurvivalRecord {
  cross: string;
  at: number;
  horizonDays: number;
  status: 'alive' | 'dead' | 'unresolved' | 'missed';
  liquidityUsd?: number;
  why?: string;
}

export class SurvivalLog {
  private readonly m = new Map<string, SurvivalRecord>();
  readonly skippedLines: number;
  constructor(readonly path: string | null) {
    let skipped = 0;
    if (path && existsSync(path)) {
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const r = JSON.parse(line) as SurvivalRecord;
          if (typeof r.cross !== 'string') throw new Error('no cross');
          this.m.set(`${r.cross}|${r.horizonDays}`, r);
        } catch {
          skipped += 1;
        }
      }
    } else if (path) mkdirSync(dirname(path), { recursive: true });
    this.skippedLines = skipped;
  }
  get(cross: string, h: number) {
    return this.m.get(`${cross}|${h}`) ?? null;
  }
  all() {
    return [...this.m.values()];
  }
  add(r: SurvivalRecord) {
    const k = `${r.cross}|${r.horizonDays}`;
    if (this.m.has(k)) return;
    this.m.set(k, r);
    if (this.path) appendFileSync(this.path, `${JSON.stringify(r)}\n`);
  }
}

/** Rated, finalized crosses whose horizon has passed. */
export async function ratedCrosses(db: Pg, version: string, dueBy: number, limit: number): Promise<RatedCross[]> {
  const { rows } = await db.query<{ cross_address: string; base_mint: string; reveal_end_ts: string; score: number; body: { components?: { name: string; score: number | null }[] }; matched: string | null; rated_at: Date }>(
    `SELECT s.cross_address, c.base_mint, c.reveal_end_ts::text AS reveal_end_ts, s.score, s.body, c.matched::text AS matched, s.rated_at
       FROM rating_snapshots s JOIN crosses c ON c.address = s.cross_address
      WHERE s.version = $1 AND s.status = 'rated' AND c.state = 'Finalized' AND c.reveal_end_ts <= $2
      ORDER BY c.reveal_end_ts ASC LIMIT $3`,
    [version, dueBy, limit],
  );
  return rows.map((r) => {
    const organic = r.body.components?.find((c) => c.name === 'organic-volume')?.score;
    return { cross: r.cross_address, baseMint: r.base_mint, startsTs: Number(r.reveal_end_ts), score: r.score, organicLowerBps: typeof organic === 'number' ? organic * 100 : null, matchedBase: r.matched === null ? null : BigInt(r.matched.split('.')[0]!), ratedAt: Math.floor(new Date(r.rated_at).getTime() / 1000) };
  });
}

export async function resolveSurvival(crosses: readonly RatedCross[], log: SurvivalLog, horizonDays: number, d: FeedDeps = {}): Promise<{ alive: number; dead: number; unresolved: number; missed: number }> {
  const now = d.now ? d.now() : Math.floor(Date.now() / 1000);
  const tally = { alive: 0, dead: 0, unresolved: 0, missed: 0 };
  for (const c of crosses) {
    const due = c.startsTs + horizonDays * 86_400;
    if (due > now || log.get(c.cross, horizonDays)) continue;
    if (now - due > RESOLVE_GRACE_SECS) {
      log.add({ cross: c.cross, at: now, horizonDays, status: 'missed', why: `looked ${Math.round((now - due) / 3600)} hours after the horizon` });
      tally.missed += 1;
      continue;
    }
    let found: { id?: unknown; usdPrice?: unknown; liquidity?: unknown } | undefined;
    try {
      const res = await (d.fetch ?? fetch)(`${d.base ?? 'https://lite-api.jup.ag/tokens/v2'}/search?query=${encodeURIComponent(c.baseMint)}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
      if (!res.ok) continue;
      const list = (await res.json()) as { id?: unknown }[];
      found = Array.isArray(list) ? list.find((t) => t.id === c.baseMint) : undefined;
    } catch {
      continue;
    }
    const price = typeof found?.usdPrice === 'number' ? found.usdPrice : null;
    const liq = typeof found?.liquidity === 'number' ? found.liquidity : null;
    if (!found || price === null || liq === null) {
      log.add({ cross: c.cross, at: now, horizonDays, status: 'unresolved', why: 'the feed no longer lists the token' });
      tally.unresolved += 1;
    } else if (price > 0 && liq >= ALIVE_LIQUIDITY_USD) {
      log.add({ cross: c.cross, at: now, horizonDays, status: 'alive', liquidityUsd: liq });
      tally.alive += 1;
    } else {
      log.add({ cross: c.cross, at: now, horizonDays, status: 'dead', liquidityUsd: liq });
      tally.dead += 1;
    }
  }
  return tally;
}
