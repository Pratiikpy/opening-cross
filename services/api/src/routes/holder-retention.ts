// Retention of investors, measured (ROADMAP R6; ADR-0407): GET /v1/metrics/retention.
//
// A wallet belongs to the cohort of the week in which the first cross it ordered in opened. It is retained in week k if it ordered in
// a cross that opened k weeks after that. Wallets that created a cross and wallets listed in OWN_WALLETS are left out, because their
// returning proves nothing about outside users. A cell with fewer than MIN_COHORT wallets reports its counts and no rate.
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Db } from './holder-alerts-store.js';

export const WEEK = 604_800;
export const MIN_COHORT = 5;
export const HORIZON_WEEKS = 8;

export type Participation = { wallet: string; openTs: number };

export type RetentionCell = { week: number; retained: number; rate: number | null };
export type Cohort = { weekStart: number; wallets: number; cells: RetentionCell[] };
export type Retention = {
  wallets: number;
  cohorts: Cohort[];
  /** Wallets with orders in two or more crosses, over all wallets. Null with no wallets. */
  returningShare: number | null;
  minCohort: number;
};

/** The retention table from one row per (wallet, cross it ordered in). `now` bounds the weeks that have fully elapsed. */
export function retention(rows: readonly Participation[], now: number): Retention {
  const byWallet = new Map<string, number[]>();
  for (const r of rows) byWallet.set(r.wallet, [...(byWallet.get(r.wallet) ?? []), r.openTs]);
  const cohorts = new Map<number, { wallets: number; weeks: Map<number, Set<string>> }>();
  let returning = 0;
  for (const [wallet, times] of byWallet) {
    const sorted = [...times].sort((a, b) => a - b);
    const first = Math.floor(sorted[0]! / WEEK);
    let c = cohorts.get(first);
    if (!c) {
      c = { wallets: 0, weeks: new Map() };
      cohorts.set(first, c);
    }
    c.wallets += 1;
    if (new Set(sorted).size > 1) returning += 1;
    for (const t of sorted) {
      const k = Math.floor(t / WEEK) - first;
      if (k >= 1 && k <= HORIZON_WEEKS) {
        let s = c.weeks.get(k);
        if (!s) {
          s = new Set();
          c.weeks.set(k, s);
        }
        s.add(wallet);
      }
    }
  }
  const out: Cohort[] = [...cohorts.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([week, c]) => {
      // Week k of a cohort is reported once that week has fully ended; a week still running has not finished earning its retention.
      const finished = Math.max(0, Math.min(HORIZON_WEEKS, Math.floor(now / WEEK) - week - 1));
      const cells: RetentionCell[] = [];
      for (let k = 1; k <= finished; k++) {
        const retained = c.weeks.get(k)?.size ?? 0;
        cells.push({ week: k, retained, rate: c.wallets >= MIN_COHORT ? retained / c.wallets : null });
      }
      return { weekStart: week * WEEK, wallets: c.wallets, cells };
    });
  return { wallets: byWallet.size, cohorts: out, returningShare: byWallet.size ? returning / byWallet.size : null, minCohort: MIN_COHORT };
}

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
const send = (reply: FastifyReply, v: unknown, status = 200) => reply.code(status).type('application/json').send(json(v));

export type HolderRetentionDeps = { db: Db; clock?: () => number; ownWallets?: ReadonlySet<string> };

export function registerHolderRetention(app: FastifyInstance, deps: HolderRetentionDeps) {
  const clock = deps.clock ?? (() => Math.floor(Date.now() / 1000));
  app.get('/v1/metrics/retention', async (_req, reply) => {
    const rows = (
      await deps.db.query(
        `SELECT o.owner, c.open_ts
           FROM orders o JOIN crosses c ON c.address = o.cross_address
          WHERE o.status <> 'cancelled'
            AND o.owner NOT IN (SELECT creator FROM crosses)
          GROUP BY o.owner, c.open_ts`,
      )
    ).rows;
    const own = deps.ownWallets ?? new Set<string>();
    const result = retention(
      rows.filter((r) => !own.has(String(r.owner))).map((r) => ({ wallet: String(r.owner), openTs: Number(r.open_ts) })),
      clock(),
    );
    return send(reply, {
      generatedAt: clock(),
      ...result,
      method:
        'A wallet is counted in the week its first cross opened and is retained in week k if it ordered in a cross that opened k weeks later. Wallets that created a cross and wallets on the OWN_WALLETS list are excluded. A cohort under ' +
        `${MIN_COHORT} wallets shows counts and no rate. These are devnet figures from test traffic and measure no outside demand.`,
    });
  });
}
