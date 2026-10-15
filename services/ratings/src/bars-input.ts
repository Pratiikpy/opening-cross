// The observations the release bars are scored on (V-A), read from the indexer's database and the survival log, as plain JSON a script can load without a database driver:
//   ratings.json   one row per rated cross that has an outcome: { cross, ratedAt, score, outcomeBps }
//   ovs.json       one row per rated cross whose 30-day survival is known: { cross, lowerBps, rawVolume, survived30d }
//   agents.json    one row per auction with at least one mandate order: { cross, agentQuote, totalQuote } (decimal strings)
// Crosses with no outcome, or whose survival is unresolved or missed, are not rows; their count is in `excluded` so a reader sees what was left out.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Pg } from './outcomes.js';
import { type SurvivalLog, ratedCrosses } from './survival.js';

export interface BarsInput {
  ratings: { cross: string; ratedAt: number; score: number; outcomeBps: number }[];
  ovs: { cross: string; lowerBps: number; rawVolume: number; survived30d: boolean }[];
  agents: { cross: string; agentQuote: string; totalQuote: string }[];
  excluded: { ratedWithoutOutcome: number; ratedWithoutOrganic: number; survivalUnknown: number };
}

export async function readBarsInput(db: Pg, version: string, survival: SurvivalLog): Promise<BarsInput> {
  const rated = await db.query<{ cross_address: string; score: number; rated_at: Date; outcome_bps: number | null }>(
    `SELECT s.cross_address, s.score, s.rated_at, o.outcome_bps FROM rating_snapshots s LEFT JOIN rating_outcomes o ON o.cross_address = s.cross_address WHERE s.version = $1 AND s.status = 'rated'`,
    [version],
  );
  const ratings = rated.rows.filter((r) => r.outcome_bps !== null).map((r) => ({ cross: r.cross_address, ratedAt: Math.floor(new Date(r.rated_at).getTime() / 1000), score: r.score, outcomeBps: r.outcome_bps! }));
  const crosses = await ratedCrosses(db, version, Math.floor(Date.now() / 1000), 5_000);
  const ovs: BarsInput['ovs'] = [];
  let noOrganic = 0;
  let unknown = 0;
  for (const c of crosses) {
    const s = survival.get(c.cross, 30);
    if (c.organicLowerBps === null || c.matchedBase === null) {
      noOrganic += 1;
      continue;
    }
    if (!s || (s.status !== 'alive' && s.status !== 'dead')) {
      unknown += 1;
      continue;
    }
    ovs.push({ cross: c.cross, lowerBps: c.organicLowerBps, rawVolume: Number(c.matchedBase), survived30d: s.status === 'alive' });
  }
  const agents = await db.query<{ cross_address: string; agent: string; total: string }>(
    `SELECT o.cross_address,
            COALESCE(SUM(CASE WHEN m.order_address IS NOT NULL THEN o.escrow END), 0)::text AS agent,
            SUM(o.escrow)::text AS total
       FROM orders o LEFT JOIN mandate_orders m ON m.order_address = o.address
      WHERE o.status <> 'cancelled'
      GROUP BY o.cross_address
     HAVING COUNT(m.order_address) > 0`,
  );
  return {
    ratings,
    ovs,
    agents: agents.rows.map((r) => ({ cross: r.cross_address, agentQuote: r.agent.split('.')[0]!, totalQuote: r.total.split('.')[0]! })),
    excluded: { ratedWithoutOutcome: rated.rows.length - ratings.length, ratedWithoutOrganic: noOrganic, survivalUnknown: unknown },
  };
}

export function writeBarsInput(dir: string, i: BarsInput): void {
  writeFileSync(join(dir, 'ratings.json'), JSON.stringify(i.ratings));
  writeFileSync(join(dir, 'ovs.json'), JSON.stringify(i.ovs));
  writeFileSync(join(dir, 'agents.json'), JSON.stringify(i.agents));
  writeFileSync(join(dir, 'excluded.json'), JSON.stringify(i.excluded));
}
