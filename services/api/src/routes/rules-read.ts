// Reads of what the rules extension and the settlement adapters produce, from the indexer's tables, checked against the chain where an account is the
// exact record (ADR-0450 to ADR-0462, ADR-0480 to ADR-0487). Every route answers for a cross, a wallet or a mint that has none of it: an empty list or null with a
// note, never an error, so a page can ask about any cross.
//
//   GET /v1/crosses/:address/challenges     insider challenges filed against a cross, with their outcome
//   GET /v1/crosses/:address/ending         the ending period: its buckets, how many orders fell in each, the drawn last bucket and the extension
//   GET /v1/owners/:owner/lockups?cross=    a wallet's locked fills: amount, schedule, what has been released (read from the lockup account) and what can be released now
//   GET /v1/halts/:baseMint                 a base mint's halt state (chain) and how often it changed (index)
//   GET /v1/feeds/:baseMint                 a base mint's lender print feed (chain) and the prints it recorded (index)
//   GET /v1/series/:address                 a recurring series (chain) and the crosses it spawned (index)
//   GET /v1/series?authority=               series of an authority (index)
//   GET /v1/crosses/:address/proof/draws    the fairness proof with the draws the index recorded, so that an ending drawn before a later draw replaced the stored seed can still be checked
//   GET /v1/crosses/:address/settlement     how a cross was settled: the venue it opened, the partner payouts, the greenshoe, the futarchy DAOs and presale tranches it opened
import type { FastifyInstance, FastifyReply } from 'fastify';
import type pg from 'pg';
import { type Address, getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';
import {
  CROSS_CORE_PROGRAM_ADDRESS,
  HALT_STATE_DISCRIMINATOR,
  LOCKUP_DISCRIMINATOR,
  PRINT_FEED_DISCRIMINATOR,
  SERIES_DISCRIMINATOR,
  getHaltStateDecoder,
  getLockupDecoder,
  getPrintFeedDecoder,
  getSeriesDecoder,
  haltStateAddress,
  lockupAddress,
  printFeedAddress,
  readCrossExt,
  CROSS_DISCRIMINATOR,
  getCrossDecoder,
  lastBucket,
  HaltReason,
} from '@opening-cross/sdk';
import { CROSS_SETTLE_PROGRAM_ADDRESS, GREENSHOE_DISCRIMINATOR, getGreenshoeDecoder } from '@opening-cross/cross-settle-client';
import { type DrawRecord, verifyCross } from '@opening-cross/verifier';
import { RequestError } from '../tx.js';
import { addr, json } from './_inputs.js';
import { settlementMarkets } from '@opening-cross/indexer';
import { releasableOf } from './rules-tx.js';

type ChainAccount = { data: Uint8Array; owner: Address };
export type RulesReadDeps = {
  db: pg.Pool;
  account: (a: Address) => Promise<ChainAccount | null>;
  clock?: () => number;
};

const send = (reply: FastifyReply, v: unknown, status = 200) => reply.code(status).type('application/json').send(json(v));
const starts = (data: Uint8Array, prefix: ArrayLike<number>) => data.length >= prefix.length && Array.from(prefix).every((b, i) => data[i] === b);
/** The greenshoe account of a cross: seeds `greenshoe` and the cross (programs/cross_settle). */
const greenshoeOf = async (cross: Address) => (await getProgramDerivedAddress({ programAddress: CROSS_SETTLE_PROGRAM_ADDRESS, seeds: [new TextEncoder().encode('greenshoe'), getAddressEncoder().encode(cross)] }))[0];
const HALT_REASONS = ['none', 'issuer-pause', 'venue-halt', 'circuit-breaker', 'corporate-action'];

export function registerRulesRead(app: FastifyInstance, d: RulesReadDeps): void {
  const now = () => BigInt(d.clock?.() ?? Math.floor(Date.now() / 1000));

  app.get('/v1/crosses/:address/challenges', async (req, reply) => {
    const a = addr((req.params as { address: string }).address, 'address');
    const { rows } = await d.db.query('SELECT id, challenger, subject, evidence, status, slash::text AS slash, filed_slot::text AS filed_slot, resolved_slot::text AS resolved_slot FROM cross_challenges WHERE cross_address = $1 ORDER BY id', [a]);
    return send(reply, { cross: a, challenges: rows, open: rows.filter((r) => r.status === 'Open').length });
  });

  app.get('/v1/crosses/:address/ending', async (req, reply) => {
    const a = addr((req.params as { address: string }).address, 'address');
    const acct = await d.account(a);
    if (!acct || acct.owner !== CROSS_CORE_PROGRAM_ADDRESS || !starts(acct.data, CROSS_DISCRIMINATOR)) throw new RequestError(404, `cross ${a} not found on chain`);
    const x = readCrossExt(acct.data);
    if (!x || (x.ending.endingSecs === 0 && x.ending.extensionMaxSecs === 0)) return send(reply, { cross: a, ending: null, note: 'This cross has no ending period and no extension.' });
    const c = getCrossDecoder().decode(acct.data);
    const { rows } = await d.db.query(
      `SELECT p.epoch, p.bucket, count(*)::int AS orders FROM order_placements p WHERE p.cross_address = $1 GROUP BY p.epoch, p.bucket ORDER BY p.epoch, p.bucket`,
      [a],
    );
    const buckets = Array.from({ length: x.ending.buckets }, (_, b) => ({ bucket: b, orders: rows.find((r) => r.epoch === 0 && r.bucket === b)?.orders ?? 0 }));
    const drawn = x.draw.endBucket !== 255;
    return send(reply, {
      cross: a,
      ending: {
        startsAt: x.ending.endingSecs > 0 ? c.closeTs - BigInt(x.ending.endingSecs) : null,
        endsAt: c.closeTs,
        cancelCutoffSecs: x.ending.cancelCutoffSecs,
        randomEnd: x.ending.randomEnd,
        buckets,
        before: rows.find((r) => r.epoch === 0 && r.bucket === 255)?.orders ?? 0,
        lastCountedBucket: x.ending.endingSecs > 0 ? (drawn ? lastBucket(x) : x.ending.randomEnd ? null : x.ending.buckets - 1) : null,
        drawn,
        extension: { possible: x.ending.extensionMaxSecs > 0, minSecs: x.ending.extensionMinSecs, maxSecs: x.ending.extensionMaxSecs, pending: x.draw.extPending, used: x.draw.extensionUsed, epoch: x.draw.epoch, ordersAfter: rows.filter((r) => r.epoch > 0).reduce((n, r) => n + r.orders, 0) },
      },
    });
  });

  app.get('/v1/owners/:owner/lockups', async (req, reply) => {
    const owner = addr((req.params as { owner: string }).owner, 'owner');
    const crossFilter = (req.query as { cross?: string }).cross;
    if (crossFilter !== undefined) addr(crossFilter, 'cross');
    const { rows } = await d.db.query(
      `SELECT cross_address, order_address, nonce::text AS nonce, amount::text AS amount, start_ts::text AS start_ts, cliff_secs::int AS cliff_secs, vest_secs::int AS vest_secs, released::text AS released
         FROM cross_locks WHERE owner = $1 AND ($2::text IS NULL OR cross_address = $2) ORDER BY created_slot DESC LIMIT 100`,
      [owner, crossFilter ?? null],
    );
    const at = now();
    const out = [];
    for (const r of rows) {
      let state: 'locked' | 'closed' | 'unknown' = 'unknown';
      let released = BigInt(r.released as string);
      let releasable: bigint | null = null;
      let lockup: Address | null = null;
      if (r.nonce !== null) {
        lockup = await lockupAddress(r.cross_address as Address, owner, BigInt(r.nonce as string));
        const acct = await d.account(lockup);
        if (acct && acct.owner === CROSS_CORE_PROGRAM_ADDRESS && starts(acct.data, LOCKUP_DISCRIMINATOR)) {
          const l = getLockupDecoder().decode(acct.data);
          released = l.released;
          releasable = releasableOf(l, at);
          state = 'locked';
        } else if (acct === null) {
          // The record closes when the last part is released.
          state = 'closed';
          released = BigInt(r.amount as string);
          releasable = 0n;
        }
      }
      out.push({
        cross: r.cross_address,
        order: r.order_address,
        nonce: r.nonce,
        lockup,
        amount: r.amount,
        startTs: r.start_ts,
        cliffSecs: r.cliff_secs,
        vestSecs: r.vest_secs,
        unlocksAt: BigInt(r.start_ts as string) + BigInt(r.cliff_secs as number),
        endsAt: BigInt(r.start_ts as string) + BigInt(r.cliff_secs as number) + BigInt(r.vest_secs as number),
        released,
        releasable,
        state,
      });
    }
    return send(reply, { owner, lockups: out, note: rows.length === 0 ? 'No locked fills are indexed for this wallet.' : undefined });
  });

  app.get('/v1/halts/:baseMint', async (req, reply) => {
    const baseMint = addr((req.params as { baseMint: string }).baseMint, 'baseMint');
    const halt = await haltStateAddress(baseMint);
    const acct = await d.account(halt);
    const { rows } = await d.db.query('SELECT halted, reason, changed_slot::text AS changed_slot, changes FROM halt_states WHERE base_mint = $1', [baseMint]);
    if (!acct || acct.owner !== CROSS_CORE_PROGRAM_ADDRESS || !starts(acct.data, HALT_STATE_DISCRIMINATOR)) return send(reply, { baseMint, halt: null, note: 'No halt state exists for this mint: nothing can halt a cross of it, and no resume cross is needed.', indexed: rows[0] ?? null });
    const h = getHaltStateDecoder().decode(acct.data);
    return send(reply, {
      baseMint,
      halt,
      state: {
        halted: h.halted,
        reason: HALT_REASONS[h.reason] ?? `unknown(${h.reason})`,
        reasonCode: h.reason as HaltReason,
        corporateAction: h.corporateAction,
        since: h.halted ? h.sinceTs : null,
        issuerUnpaused: h.issuerUnpaused,
        authority: h.authority,
        venueSigner: h.venueSigner.__option === 'Some' ? h.venueSigner.value : null,
        breaker: h.breaker.__option === 'Some' ? { windowSlots: h.breaker.value.windowSlots, moveBps: h.breaker.value.moveBps, feedId: Buffer.from(h.breaker.value.feedId).toString('hex') } : null,
        lastResume: h.lastResumeCross.__option === 'Some' ? { cross: h.lastResumeCross.value, price: h.lastResumePrice, at: h.lastResumeTs } : null,
      },
      indexed: rows[0] ?? null,
    });
  });

  app.get('/v1/feeds/:baseMint', async (req, reply) => {
    const baseMint = addr((req.params as { baseMint: string }).baseMint, 'baseMint');
    const feed = await printFeedAddress(baseMint);
    const acct = await d.account(feed);
    const { rows } = await d.db.query('SELECT cross_address, price::text AS price, matched::text AS matched, slot::text AS slot FROM print_feed_prints WHERE base_mint = $1 ORDER BY slot DESC LIMIT 50', [baseMint]);
    if (!acct || acct.owner !== CROSS_CORE_PROGRAM_ADDRESS || !starts(acct.data, PRINT_FEED_DISCRIMINATOR)) return send(reply, { baseMint, feed: null, prints: rows, note: 'No lender print feed exists for this mint.' });
    const f = getPrintFeedDecoder().decode(acct.data);
    return send(reply, {
      baseMint,
      feed,
      quoteMint: f.quoteMint,
      authority: f.authority,
      publishers: f.publishers.slice(0, f.publisherCount),
      minMatched: f.minMatched,
      latest: f.prints > 0n ? { price: f.price, priceScale: f.priceScale, matched: f.matched, cross: f.cross, ts: f.ts, slot: f.slot } : null,
      prints: rows,
      printCount: f.prints,
    });
  });

  app.get('/v1/series/:address', async (req, reply) => {
    const a = addr((req.params as { address: string }).address, 'address');
    const acct = await d.account(a);
    if (!acct || acct.owner !== CROSS_CORE_PROGRAM_ADDRESS || !starts(acct.data, SERIES_DISCRIMINATOR)) throw new RequestError(404, `no series at ${a}`);
    const s = getSeriesDecoder().decode(acct.data);
    const { rows } = await d.db.query('SELECT idx::text AS idx, cross_address, close_ts::text AS close_ts FROM series_crosses WHERE series = $1 ORDER BY idx DESC LIMIT 100', [a]);
    return send(reply, {
      series: a,
      authority: s.authority,
      seriesId: s.seriesId,
      baseMint: s.baseMint,
      quoteMint: s.quoteMint,
      active: s.active,
      next: s.nextIndex,
      maxCrosses: s.config.maxCrosses > 0n ? s.config.maxCrosses : null,
      lastCross: s.lastCross.__option === 'Some' ? s.lastCross.value : null,
      lastPrice: s.lastPrice > 0n ? s.lastPrice : null,
      schedule: s.config.calendar.__option === 'Some' ? { calendar: s.config.calendar.value } : { startTs: s.config.startTs, intervalSecs: s.config.intervalSecs },
      callSecs: s.config.callSecs,
      revealSecs: s.config.revealSecs,
      crosses: rows,
    });
  });

  app.get('/v1/series', async (req, reply) => {
    const authority = (req.query as { authority?: string }).authority;
    if (authority !== undefined) addr(authority, 'authority');
    const { rows } = await d.db.query(
      `SELECT s.address, s.authority, s.created_slot::text AS created_slot, (SELECT count(*)::int FROM series_crosses c WHERE c.series = s.address) AS crosses
         FROM series s WHERE ($1::text IS NULL OR s.authority = $1) ORDER BY s.created_slot DESC LIMIT 100`,
      [authority ?? null],
    );
    return send(reply, { series: rows });
  });

  // The proof of GET /v1/crosses/:address/proof (server.ts) reads the chain alone. A cross that had a drawn extension has overwritten the seed of its ending draw
  // on chain; the DrawFinished events the indexer stored still carry it, and with them the proof can check the ending too.
  app.get('/v1/crosses/:address/proof/draws', async (req, reply) => {
    const a = addr((req.params as { address: string }).address, 'address');
    const acct = await d.account(a);
    if (!acct || acct.owner !== CROSS_CORE_PROGRAM_ADDRESS || !starts(acct.data, CROSS_DISCRIMINATOR)) throw new RequestError(404, `cross ${a} not found on chain`);
    const { rows } = await d.db.query("SELECT payload FROM events WHERE cross_address = $1 AND name = 'DrawFinished' ORDER BY slot, seq", [a]);
    const draws: DrawRecord[] = rows.map((r) => {
      const p = r.payload as { purpose: number; epoch: number; seed: Record<string, number>; endBucket: number; closeTs: string };
      return { purpose: p.purpose, epoch: p.epoch, seed: Buffer.from(Array.from({ length: 32 }, (_, i) => p.seed[String(i)] ?? 0)).toString('hex'), endBucket: p.endBucket, closeTs: p.closeTs };
    });
    const fetchOwned = async (x: Address) => {
      const got = await d.account(x);
      return got && got.owner === CROSS_CORE_PROGRAM_ADDRESS ? got.data : null;
    };
    return send(reply, { proof: await verifyCross(fetchOwned, a, { draws }), draws });
  });

  app.get('/v1/crosses/:address/settlement', async (req, reply) => {
    const a = addr((req.params as { address: string }).address, 'address');
    const [venue, partner, gs, events, markets] = await Promise.all([
      d.db.query('SELECT venue, pool, clearing_price::text AS clearing_price, detail, slot::text AS slot FROM settle_venues WHERE cross_address = $1', [a]),
      d.db.query('SELECT fee_base::text AS fee_base, fee_quote::text AS fee_quote, fee_claims, surplus_withdrawn::text AS surplus_withdrawn, migration_fee::text AS migration_fee, pool_creation_lamports::text AS pool_creation_lamports, pol_token_a::text AS pol_token_a, pol_token_b::text AS pol_token_b, pol_claims FROM settle_partner WHERE cross_address = $1', [a]),
      d.db.query('SELECT greenshoe, budget::text AS budget, start_ts::text AS start_ts, expires_ts::text AS expires_ts, bids, settled_levels, finished, burned::text AS burned, returned::text AS returned FROM settle_greenshoes WHERE cross_address = $1', [a]),
      d.db.query('SELECT name, slot::text AS slot, extract(epoch FROM block_time)::bigint AS time, signature, payload FROM settle_events WHERE cross_address = $1 ORDER BY slot, seq LIMIT 200', [a]),
      settlementMarkets(d.db, a),
    ]);
    let greenshoe: Record<string, unknown> | null = null;
    if (gs.rows[0]) {
      const chain = await d.account(await greenshoeOf(a));
      const g = chain && chain.owner === CROSS_SETTLE_PROGRAM_ADDRESS && starts(chain.data, GREENSHOE_DISCRIMINATOR) ? getGreenshoeDecoder().decode(chain.data) : null;
      greenshoe = {
        ...gs.rows[0],
        onChain: g && { deployed: g.deployed, finished: g.finished, levelSettled: g.levelSettled, bins: g.bins, amounts: g.amounts, orders: g.orders, expiresTs: g.expiresTs, periodSecs: g.periodSecs, periodCap: g.periodCap },
        expired: now() >= BigInt(gs.rows[0].expires_ts as string),
      };
    }
    return send(reply, {
      cross: a,
      venue: venue.rows[0] ?? null,
      partner: partner.rows[0] ?? null,
      greenshoe,
      // The futarchy DAOs and fixed-price presale tranches a cross opened without a pool (ADR-0930).
      futarchyDaos: markets.futarchyDaos,
      presales: markets.presales,
      events: events.rows,
      note: !venue.rows[0] && !events.rows[0] && markets.futarchyDaos.length === 0 && markets.presales.length === 0 ? 'No settlement adapter has opened a venue for this cross (or the indexer has not seen it yet).' : undefined,
    });
  });
}
