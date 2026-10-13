// The indexer's side of the rules extension, the treasury extension and cross_settle, over PGlite: every new event decodes from a real-shaped
// log and projects onto its table, the migrations apply twice, and the reconciler still passes against the cross accounts the program
// deployed before the extension wrote (no rules tail) while catching a drift in the ones it writes now.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import { type Address, getAddressDecoder, getBase58Decoder, none, some } from '@solana/kit';
import {
  CROSS_BODY_LEN,
  CROSS_CORE_PROGRAM_ADDRESS,
  CROSS_EXT_LEN,
  CrossKind,
  CrossState,
  Disclosure,
  SupplyMode,
  completeRules,
  getCommitOrderExtInstructionDataEncoder,
  getCrossEncoder,
  getCrossExtEncoder,
  getChallengeExpiredEventEncoder,
  getChallengeResolvedEventEncoder,
  getCrossClearedEventEncoder,
  getCrossCreatedEventEncoder,
  getDrawFinishedEventEncoder,
  getDrawStartedEventEncoder,
  getExtensionPendingEventEncoder,
  getHaltChangedEventEncoder,
  getInsiderChallengedEventEncoder,
  getLockCreatedEventEncoder,
  getLockReleasedEventEncoder,
  getOrderClaimedEventEncoder,
  getOrderCommittedEventEncoder,
  getOrderPlacementEventEncoder,
  getPrintFedEventEncoder,
  getRulesSetEventEncoder,
  getSeriesCreatedEventEncoder,
  getSeriesSpawnedEventEncoder,
} from '@opening-cross/sdk';
import { TREASURY_PROGRAM_ADDRESS, getTreasuryExtendedEventEncoder, getProposalCreatedEventEncoder, getVotedEventEncoder, getVoteReclaimedEventEncoder, getProposalExecutedEventEncoder, getStakedEventEncoder, getUnstakedEventEncoder, getDistributionDepositedEventEncoder, getDistributionClaimedEventEncoder, getRoundPaidEventEncoder, getRoundMissedEventEncoder, getTrancheReleasedEventEncoder, getGrantCreatedEventEncoder, getMilestoneReleasedEventEncoder, getGrantExpiredEventEncoder, getDisclosurePostedEventEncoder, getDisclosureRequestedEventEncoder, getAssignmentRecordedEventEncoder, getUnclaimedSweptEventEncoder, getNavRedeemedEventEncoder, getTreasuryCreatedEventEncoder } from '@opening-cross/treasury-client';
import {
  CROSS_SETTLE_PROGRAM_ADDRESS,
  getGreenshoeBidPlacedEventEncoder,
  getGreenshoeCreatedEventEncoder,
  getGreenshoeFinishedEventEncoder,
  getGreenshoeLevelSettledEventEncoder,
  getPartnerFeeClaimedEventEncoder,
  getPartnerSurplusWithdrawnEventEncoder,
  getPolFeesClaimedEventEncoder,
  getDlmmPairOpenedEventEncoder,
} from '@opening-cross/cross-settle-client';
import { type ChainTx, type TxBody, commitFacts, commitTerms, decodeLogs, decodeSettleLogs, decodeTreasuryLogs, ingestSettleTransaction, ingestTransaction, ingestTreasuryTransaction, reconcile } from '@opening-cross/indexer';

type Row = Record<string, unknown>;
const dir = fileURLToPath(new URL('../../indexer/migrations/', import.meta.url));
const key = (n: number) => getAddressDecoder().decode(new Uint8Array(32).fill(n + 40)) as Address;
const A = Object.fromEntries(['cross', 'creator', 'base', 'quote', 'alice', 'bob', 'orderA', 'orderB', 'orderC', 'integrator', 'fees', 'arbiter', 'subject', 'series', 'seriesCross', 'treasury', 'coin', 'proposal', 'grant', 'greenshoe', 'pool', 'recipient', 'legacy', 'limit'].map((n, i) => [n, key(i + 1)])) as Record<string, Address>;
const ZERO = '11111111111111111111111111111111' as Address;
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const log = (program: Address, ...events: Uint8Array[]) => [`Program ${program} invoke [1]`, ...events.map((e) => `Program data: ${b64(e)}`), `Program ${program} success`];

describe('indexing the extensions', () => {
  let pg: PGlite;
  let db: never;
  let slot = 100n;
  const q = async (text: string, params: unknown[] = []): Promise<Row[]> => (await pg.query(text, params as never[])).rows as Row[];
  const wrap = (): never =>
    ({
      query: async (text: string, params?: unknown[]) => {
        const r = await pg.query(text, params as never[]);
        return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
      },
      connect: async () => ({
        query: async (text: string, params?: unknown[]) => {
          const r = await pg.query(text, params as never[]);
          return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
        },
        release() {},
      }),
    }) as never;
  const tx = (logs: string[], extra: Partial<ChainTx> = {}): ChainTx => ({ signature: `sig${slot}x${Math.random().toString(36).slice(2, 8)}`, slot: slot++, blockTime: 1_800_000_000n + slot, logs, err: null, ...extra });
  const core = (...events: Uint8Array[]) => log(CROSS_CORE_PROGRAM_ADDRESS, ...events);
  const rules = completeRules({});

  beforeAll(async () => {
    pg = new PGlite();
    db = wrap();
    // twice: the indexer applies every migration on each start
    for (let pass = 0; pass < 2; pass++) for (const f of readdirSync(dir).filter((n) => n.endsWith('.sql')).sort()) await pg.exec(readFileSync(`${dir}${f}`, 'utf8'));
  });

  describe('cross_core', () => {
    it('creates a cross and its rules; the rules are projected whole', async () => {
      const created = getCrossCreatedEventEncoder().encode({ cross: A.cross, creator: A.creator, kind: CrossKind.Launch, supplyMode: SupplyMode.Mint, disclosure: Disclosure.Open, baseMint: A.base, quoteMint: A.quote, openTs: 1_000n, closeTs: 2_000n, revealEndTs: 2_100n, protocolFeeBps: 30, integratorFeeBps: 20 });
      const setRules = getRulesSetEventEncoder().encode({
        cross: A.cross,
        flags: 4,
        guards: { ...rules.guards, minRaiseQuote: 5_000_000n },
        ending: { endingSecs: 300, buckets: 3, cancelCutoffSecs: 30, randomEnd: true, extensionMinSecs: 60, extensionMaxSecs: 600 },
        identity: { capQuote: 50_000_000n, maxOrders: 1 },
        alloc: { ...rules.alloc, reserveBps: [3_000, 0, 0], smallCapQuote: 5_000_000n, lotteryUnit: 5_000_000n },
        insiders: 2,
        bondQuote: 1_000_000n,
      });
      expect(await ingestTransaction(db, tx(core(created, setRules)))).toBe(2);
      const [r] = await q('SELECT flags, insiders, bond_quote::text AS bond_quote, set_slot::text AS set_slot, guards, ending, alloc, draw_epoch FROM cross_rules WHERE cross_address = $1', [A.cross]);
      expect(r).toMatchObject({ flags: 4, insiders: 2, bond_quote: '1000000', set_slot: '100' });
      expect(r!.ending).toMatchObject({ endingSecs: 300, buckets: 3, randomEnd: true });
      expect(r!.alloc).toMatchObject({ reserveBps: [3_000, 0, 0], lotteryUnit: '5000000' });
      expect(r!.guards).toMatchObject({ minRaiseQuote: '5000000' });
      expect(r!.draw_epoch).toBe(0);
    });

    it('records an order\'s nonce, class and lockup from commit_order_ext, and its placement from OrderPlacement', async () => {
      const committed = getOrderCommittedEventEncoder().encode({ cross: A.cross, order: A.orderA, owner: A.alice, side: 0, escrow: 1_300n, index: 0, sealed: false });
      const placement = getOrderPlacementEventEncoder().encode({ cross: A.cross, order: A.orderA, ext: { version: 1, epoch: 0, bucket: 1, class: 2, flags: 0, lockCliff: 3_600, lockVest: 7_200, placedTs: 1_900n, ticket: 0 } });
      // the instruction data of a commit_order_ext, as the indexer reads it from the transaction
      const data = getBase58Decoder().decode(getCommitOrderExtInstructionDataEncoder().encode({ nonce: 7n, side: 0, escrow: 1_300n, commitment: new Uint8Array(32), price: 1_300_000n, quantity: 1_000n, orderBump: 255, class: 2, lockSecs: 3_600 }));
      const body: TxBody = { transaction: { message: { accountKeys: [A.alice, A.integrator, A.cross, A.orderA, CROSS_CORE_PROGRAM_ADDRESS], instructions: [{ programIdIndex: 4, accounts: [0, 1, 2, 3], data }] } } };
      expect(commitTerms(body).get(A.orderA)).toEqual({ price: 1_300_000n, quantity: 1_000n });
      expect(commitFacts(body).get(A.orderA)).toEqual({ nonce: 7n, class: 2, lockSecs: 3_600 });
      await ingestTransaction(db, tx(core(committed, placement), { terms: commitTerms(body), facts: commitFacts(body) }));
      const [o] = await q('SELECT nonce::text AS nonce, class, lock_secs::int AS lock_secs, price::text AS price FROM orders WHERE address = $1', [A.orderA]);
      expect(o).toEqual({ nonce: '7', class: 2, lock_secs: 3600, price: '1300000' });
      const [p] = await q('SELECT bucket, class, lock_cliff::text AS lock_cliff, lock_vest::text AS lock_vest, placed_ts::text AS placed_ts FROM order_placements WHERE order_address = $1', [A.orderA]);
      expect(p).toMatchObject({ bucket: 1, class: 2, lock_cliff: '3600', lock_vest: '7200', placed_ts: '1900' });
    });

    it('follows the draw: begun, finished with the last counted bucket, and a drawn extension that moves the close', async () => {
      await ingestTransaction(db, tx(core(getDrawStartedEventEncoder().encode({ cross: A.cross, slot: 5_000n, purpose: 1 }))));
      expect((await q('SELECT draw_pending_slot::text AS s, draw_pending_purpose AS p FROM cross_rules WHERE cross_address = $1', [A.cross]))[0]).toEqual({ s: '5000', p: 1 });
      const seed = new Uint8Array(32).fill(9);
      await ingestTransaction(db, tx(core(getDrawFinishedEventEncoder().encode({ cross: A.cross, purpose: 1, epoch: 0, begunSlot: 5_000n, sampledSlots: [5_004n, 5_008n, 5_012n, 5_016n], seed, endBucket: 1, closeTs: 2_000n }))));
      expect((await q('SELECT end_bucket, draw_epoch, draw_pending_slot, draw_seed FROM cross_rules WHERE cross_address = $1', [A.cross]))[0]).toEqual({ end_bucket: 1, draw_epoch: 0, draw_pending_slot: null, draw_seed: '09'.repeat(32) });
      await ingestTransaction(db, tx(core(getExtensionPendingEventEncoder().encode({ cross: A.cross, reason: 1 }))));
      expect((await q('SELECT extension_pending FROM cross_rules WHERE cross_address = $1', [A.cross]))[0]).toEqual({ extension_pending: true });
      await ingestTransaction(db, tx(core(getDrawFinishedEventEncoder().encode({ cross: A.cross, purpose: 2, epoch: 0, begunSlot: 6_000n, sampledSlots: [6_004n, 6_008n, 6_012n, 6_016n], seed, endBucket: 255, closeTs: 2_600n }))));
      expect((await q('SELECT draw_epoch, extension_pending, end_bucket FROM cross_rules WHERE cross_address = $1', [A.cross]))[0]).toEqual({ draw_epoch: 1, extension_pending: false, end_bucket: 1 });
      // the close moved from 2,000 to 2,600 and the reveal window kept its 100 seconds
      expect((await q('SELECT close_ts::text AS c, reveal_end_ts::text AS r FROM crosses WHERE address = $1', [A.cross]))[0]).toEqual({ c: '2600', r: '2700' });
    });

    it('records challenges and their outcomes', async () => {
      await ingestTransaction(db, tx(core(getInsiderChallengedEventEncoder().encode({ cross: A.cross, id: 0, challenger: A.bob, subject: A.subject, evidence: new Uint8Array(32).fill(1) }), getInsiderChallengedEventEncoder().encode({ cross: A.cross, id: 1, challenger: A.bob, subject: A.alice, evidence: new Uint8Array(32).fill(2) }))));
      await ingestTransaction(db, tx(core(getChallengeResolvedEventEncoder().encode({ cross: A.cross, id: 0, upheld: true, slash: 400_000n }))));
      await ingestTransaction(db, tx(core(getChallengeExpiredEventEncoder().encode({ cross: A.cross, id: 1 }))));
      const rows = await q('SELECT id, status, slash::text AS slash FROM cross_challenges WHERE cross_address = $1 ORDER BY id', [A.cross]);
      expect(rows).toEqual([{ id: 0, status: 'Upheld', slash: '400000' }, { id: 1, status: 'Expired', slash: null }]);
    });

    it('ties a lock to the order whose claim created it, and credits releases', async () => {
      await ingestTransaction(db, tx(core(getCrossClearedEventEncoder().encode({ cross: A.cross, printed: true, clearing: some({ price: 1_300_000n, matched: 1_000n, demand: 1_000n, supply: 1_000n, rationed: 0, marginalQuantity: 0n, marginalRemaining: 0n, marginalOrders: 0 }), noPrintReason: none() }))));
      const claimed = getOrderClaimedEventEncoder().encode({ cross: A.cross, order: A.orderA, owner: A.alice, side: 0, fill: 1_000n, quoteOut: 0n, baseOut: 0n, fee: 0n });
      const lock = getLockCreatedEventEncoder().encode({ cross: A.cross, owner: A.alice, amount: 1_000n, startTs: 2_700n, cliffSecs: 3_600, vestSecs: 7_200 });
      await ingestTransaction(db, tx(core(claimed, lock)));
      expect((await q('SELECT order_address, nonce::text AS nonce, amount::text AS amount, cliff_secs::int AS cliff FROM cross_locks WHERE owner = $1', [A.alice]))[0]).toEqual({ order_address: A.orderA, nonce: '7', amount: '1000', cliff: 3_600 });
      await ingestTransaction(db, tx(core(getLockReleasedEventEncoder().encode({ cross: A.cross, owner: A.alice, amount: 300n, remaining: 700n }))));
      await ingestTransaction(db, tx(core(getLockReleasedEventEncoder().encode({ cross: A.cross, owner: A.alice, amount: 200n, remaining: 500n }))));
      expect((await q('SELECT released::text AS released FROM cross_locks WHERE owner = $1', [A.alice]))[0]).toEqual({ released: '500' });
    });

    it('records halt states, lender prints and series', async () => {
      await ingestTransaction(db, tx(core(getHaltChangedEventEncoder().encode({ baseMint: A.base, halted: true, reason: 2 }))));
      await ingestTransaction(db, tx(core(getHaltChangedEventEncoder().encode({ baseMint: A.base, halted: false, reason: 0 }))));
      expect((await q('SELECT halted, reason, changes FROM halt_states WHERE base_mint = $1', [A.base]))[0]).toEqual({ halted: false, reason: 0, changes: 2 });
      await ingestTransaction(db, tx(core(getPrintFedEventEncoder().encode({ baseMint: A.base, cross: A.cross, price: 1_300_000n, matched: 1_000n }))));
      expect((await q('SELECT price::text AS price FROM print_feed_prints WHERE base_mint = $1', [A.base]))[0]).toEqual({ price: '1300000' });
      await ingestTransaction(db, tx(core(getSeriesCreatedEventEncoder().encode({ series: A.series, authority: A.creator }), getSeriesSpawnedEventEncoder().encode({ series: A.series, cross: A.seriesCross, index: 0n, closeTs: 3_000n }))));
      expect((await q('SELECT authority FROM series WHERE address = $1', [A.series]))[0]).toEqual({ authority: A.creator });
      expect((await q('SELECT idx::text AS idx, cross_address FROM series_crosses WHERE series = $1', [A.series]))[0]).toEqual({ idx: '0', cross_address: A.seriesCross });
    });

    it('ingests a transaction twice as once', async () => {
      const t = tx(core(getHaltChangedEventEncoder().encode({ baseMint: A.coin, halted: true, reason: 1 })));
      expect(await ingestTransaction(db, t)).toBe(1);
      expect(await ingestTransaction(db, t)).toBe(0);
      expect((await q('SELECT changes FROM halt_states WHERE base_mint = $1', [A.coin]))[0]).toEqual({ changes: 1 });
    });

    it('ignores a rules event written by another program', async () => {
      const t = tx(log(ZERO as Address, getHaltChangedEventEncoder().encode({ baseMint: A.legacy, halted: true, reason: 1 })));
      expect(decodeLogs(t.logs)).toEqual([]);
      expect(await ingestTransaction(db, t)).toBe(0);
    });
  });

  describe('reconciliation', () => {
    const crossBytes = (over: { closeTs?: bigint; revealEndTs?: bigint; ext?: Parameters<typeof getCrossExtEncoder>[0] extends never ? never : unknown } & { withExt?: boolean; epoch?: number; openChallenges?: number }) => {
      const body = getCrossEncoder().encode({
        creator: A.creator, crossId: 1n, kind: CrossKind.Launch, supplyMode: SupplyMode.Mint, disclosure: Disclosure.Open, state: CrossState.Cleared,
        baseMint: A.base, quoteMint: A.quote, baseTokenProgram: ZERO, quoteTokenProgram: ZERO, baseDecimals: 6, quoteDecimals: 6, proceedsTo: A.creator,
        minPrice: 1n, tick: 1n, ticks: 2, priceScale: 1n, openTs: 1_000n, closeTs: over.closeTs ?? 2_600n, revealEndTs: over.revealEndTs ?? 2_700n, referencePrice: none(), minMatched: 0n, maxImbalanceBps: none(),
        protocolFeeBps: 30, integratorFeeBps: 20, integrator: A.integrator, feeRecipient: A.fees, gateMint: none(), shards: 2, maxOrders: 64, dustBond: 0n,
        ordersTotal: 1, ordersOpen: 0, mergedMask: 3, clearing: some({ price: 1_300_000n, matched: 1_000n, demand: 1_000n, supply: 1_000n, rationed: 0, marginalQuantity: 0n, marginalRemaining: 0n, marginalOrders: 0 }), noPrintReason: none(),
        buyerPaid: 0n, baseBought: 0n, baseSold: 0n, sellerPaid: 0n, feesAccrued: 0n, oracle: none(), calendar: none(), settler: none(), settleDeadlineTs: 0n, baseBound: true, bump: 1, quoteVaultBump: 1, baseVaultBump: 1, bookBump: 1,
      } as never);
      const data = new Uint8Array(CROSS_BODY_LEN + (over.withExt ? CROSS_EXT_LEN : 0));
      data.set(body);
      if (over.withExt) {
        const base = completeRules({});
        data.set(
          getCrossExtEncoder().encode({
            version: 1, rulesSet: true, createdSlot: 1n, flags: 4, guards: { ...base.guards, minRaiseQuote: 5_000_000n, haltSource: null }, ending: { endingSecs: 300, buckets: 3, cancelCutoffSecs: 30, randomEnd: true, extensionMinSecs: 60, extensionMaxSecs: 600 },
            draw: { epoch: over.epoch ?? 1, pendingSlot: 0n, pendingPurpose: 0, seed: new Uint8Array(32), seedEpoch: 0, seedReady: true, endBucket: 1, extPending: false, extensionUsed: true, auxMerged: 0n },
            identity: { capQuote: 50_000_000n, maxOrders: 1 }, alloc: { ...base.alloc, priorityGate: null, reserveBps: [3_000, 0, 0], smallCapQuote: 5_000_000n, lotteryUnit: 5_000_000n },
            neutrality: { insiders: Array.from({ length: 8 }, () => ZERO), insiderCount: 2, insiderCliffSecs: 0, insiderVestSecs: 0, bondQuote: 1_000_000n, challengeSecs: 3_600 },
            neutralState: { bondHeld: 1_000_000n, slashed: 0n, openChallenges: over.openChallenges ?? 0, challenges: 2 }, clearing: { classQty: [0n, 0n, 0n], tickets: 0, rho: 0, clearedTs: 0n, insiderUb: 0n }, referral: base.referral,
            oracleSet: { extraFeeds: [new Uint8Array(32), new Uint8Array(32)] as never, extraCount: 0, quorum: 0, maxSpreadBps: 0, offHoursWidenBps: 0 },
          } as never),
          CROSS_BODY_LEN,
        );
      }
      return data;
    };
    const fetcher = (accounts: Map<string, Uint8Array>) => async (a: Address) => accounts.get(a) ?? null;

    it('passes for the cross the extended program wrote, and names each field that drifts', async () => {
      const accounts = new Map<string, Uint8Array>([[A.cross, crossBytes({ withExt: true })]]);
      // the order account is closed on chain (claimed), as the index says
      expect(await reconcile(db, fetcher(accounts))).toEqual([]);
      const wrong = new Map([[A.cross, crossBytes({ withExt: true, epoch: 0 })]]);
      expect((await reconcile(db, fetcher(wrong))).map((d) => d.field)).toEqual(['rules.draw_epoch']);
      const moved = new Map([[A.cross, crossBytes({ withExt: true, closeTs: 2_000n, revealEndTs: 2_100n })]]);
      expect((await reconcile(db, fetcher(moved))).map((d) => d.field).sort()).toEqual(['close_ts', 'reveal_end_ts']);
      const challenges = new Map([[A.cross, crossBytes({ withExt: true, openChallenges: 1 })]]);
      expect((await reconcile(db, fetcher(challenges))).map((d) => d.field)).toEqual(['rules.open_challenges']);
    });

    it('passes against a cross account of the program deployed before the extension (no tail, no rules row)', async () => {
      const created = getCrossCreatedEventEncoder().encode({ cross: A.legacy, creator: A.creator, kind: CrossKind.Launch, supplyMode: SupplyMode.Mint, disclosure: Disclosure.Open, baseMint: A.base, quoteMint: A.quote, openTs: 1_000n, closeTs: 2_000n, revealEndTs: 2_100n, protocolFeeBps: 30, integratorFeeBps: 20 });
      await ingestTransaction(db, tx(core(created)));
      await q('DELETE FROM cross_rules WHERE cross_address = $1', [A.cross]);
      await q('DELETE FROM orders WHERE cross_address = $1', [A.cross]);
      await q('DELETE FROM crosses WHERE address = $1', [A.cross]);
      const legacy = crossBytes({ closeTs: 2_000n, revealEndTs: 2_100n });
      const body = getCrossEncoder().encode({ ...(await decodeLegacy(legacy)), state: CrossState.Live, clearing: none(), ordersTotal: 0, ordersOpen: 0, mergedMask: 0 } as never);
      const data = new Uint8Array(CROSS_BODY_LEN);
      data.set(body);
      expect(await reconcile(db, fetcher(new Map([[A.legacy, data]])))).toEqual([]);
    });
  });

  describe('treasury', () => {
    const t = (...events: Uint8Array[]) => tx(log(TREASURY_PROGRAM_ADDRESS, ...events));
    it('projects the extension: governance, staking, distributions, revenue rounds, grants, disclosure', async () => {
      const [T, P, G] = [A.treasury, A.proposal, A.grant];
      await ingestTreasuryTransaction(db, t(getTreasuryCreatedEventEncoder().encode({ treasury: T, coinMint: A.coin, authority: A.creator, allowance: 1_000n, periodSecs: 100n })));
      await ingestTreasuryTransaction(db, t(getTreasuryExtendedEventEncoder().encode({ treasury: T, governance: true, nav: true, revenue: true, disclosure: true, assignmentRequired: true, windDown: true })));
      await ingestTreasuryTransaction(db, t(getProposalCreatedEventEncoder().encode({ treasury: T, proposal: P, id: 0n, proposer: A.alice, kind: 1, amount: 0n, destination: ZERO, voteEndTs: 9_000n })));
      await ingestTreasuryTransaction(db, t(getVotedEventEncoder().encode({ proposal: P, voter: A.alice, support: true, amount: 400n, yes: 400n, no: 0n })));
      await ingestTreasuryTransaction(db, t(getVotedEventEncoder().encode({ proposal: P, voter: A.bob, support: false, amount: 100n, yes: 400n, no: 100n })));
      await ingestTreasuryTransaction(db, t(getVoteReclaimedEventEncoder().encode({ proposal: P, voter: A.bob, amount: 100n })));
      await ingestTreasuryTransaction(db, t(getProposalExecutedEventEncoder().encode({ proposal: P, kind: 1, amount: 0n })));
      expect((await q('SELECT proposals_count, nav_open, extended, governance, assignment_required FROM treasuries WHERE address = $1', [T]))[0]).toEqual({ proposals_count: 1, nav_open: true, extended: true, governance: true, assignment_required: true });
      expect((await q('SELECT yes::text AS yes, no::text AS no, executed FROM treasury_proposals WHERE proposal = $1', [P]))[0]).toEqual({ yes: '400', no: '100', executed: true });
      expect(await q('SELECT voter, yes::text AS yes, no::text AS no, reclaimed FROM treasury_votes WHERE proposal = $1 ORDER BY voter', [P])).toEqual([{ voter: A.alice, yes: '400', no: '0', reclaimed: false }, { voter: A.bob, yes: '0', no: '100', reclaimed: true }].sort((x, y) => x.voter.localeCompare(y.voter)));
      // events that name only a proposal are attributed to its treasury
      expect((await q("SELECT count(*)::int AS n FROM treasury_events WHERE treasury = $1 AND name IN ('Voted', 'VoteReclaimed', 'ProposalExecuted')", [T]))[0]).toEqual({ n: 4 });

      await ingestTreasuryTransaction(db, t(getNavRedeemedEventEncoder().encode({ treasury: T, holder: A.alice, burned: 10n, paid: 100n, periodBurned: 10n })));
      await ingestTreasuryTransaction(db, t(getStakedEventEncoder().encode({ treasury: T, owner: A.alice, amount: 300n, totalStaked: 300n }), getStakedEventEncoder().encode({ treasury: T, owner: A.bob, amount: 100n, totalStaked: 400n })));
      await ingestTreasuryTransaction(db, t(getUnstakedEventEncoder().encode({ treasury: T, owner: A.alice, amount: 50n, totalStaked: 350n })));
      await ingestTreasuryTransaction(db, t(getDistributionDepositedEventEncoder().encode({ treasury: T, from: A.recipient, amount: 1_000n, totalStaked: 350n }), getDistributionClaimedEventEncoder().encode({ treasury: T, owner: A.alice, amount: 250n })));
      expect((await q('SELECT staked_total::text AS s, distributed_total::text AS d, distribution_claimed::text AS c, nav_burned::text AS nb, nav_paid::text AS np FROM treasuries WHERE address = $1', [T]))[0]).toEqual({ s: '350', d: '1000', c: '250', nb: '10', np: '100' });
      expect(await q('SELECT owner, staked::text AS staked, claimed::text AS claimed FROM treasury_stakers WHERE treasury = $1 ORDER BY owner', [T])).toEqual([{ owner: A.alice, staked: '250', claimed: '250' }, { owner: A.bob, staked: '100', claimed: '0' }].sort((x, y) => x.owner.localeCompare(y.owner)));

      await ingestTreasuryTransaction(db, t(getRoundPaidEventEncoder().encode({ treasury: T, round: 0n, revenue: 5_000n, due: 500n, payer: A.recipient }), getTrancheReleasedEventEncoder().encode({ treasury: T, round: 0n, amount: 200n }), getRoundMissedEventEncoder().encode({ treasury: T, round: 1n, navOpen: true })));
      expect(await q('SELECT round::text AS round, status, revenue::text AS revenue, tranche::text AS tranche FROM treasury_rounds WHERE treasury = $1 ORDER BY round', [T])).toEqual([{ round: '0', status: 'paid', revenue: '5000', tranche: '200' }, { round: '1', status: 'missed', revenue: null, tranche: null }]);
      expect((await q('SELECT rounds_paid, rounds_missed, tranche_released::text AS tr FROM treasuries WHERE address = $1', [T]))[0]).toEqual({ rounds_paid: 1, rounds_missed: 1, tr: '200' });

      await ingestTreasuryTransaction(db, t(getGrantCreatedEventEncoder().encode({ treasury: T, grant: G, id: 0n, beneficiary: A.bob, total: 100n, lockupEnd: 5_000n, expiryTs: 9_000n })));
      await ingestTreasuryTransaction(db, t(getMilestoneReleasedEventEncoder().encode({ grant: G, index: 0, amount: 25n }), getGrantExpiredEventEncoder().encode({ grant: G, burned: 75n })));
      expect((await q('SELECT released::text AS released, burned::text AS burned FROM treasury_grants WHERE grant_address = $1', [G]))[0]).toEqual({ released: '25', burned: '75' });

      await ingestTreasuryTransaction(db, t(getDisclosureRequestedEventEncoder().encode({ treasury: T, holder: A.alice, openSince: 7_000n })));
      expect((await q('SELECT disclosure_request_since::text AS s FROM treasuries WHERE address = $1', [T]))[0]).toEqual({ s: '7000' });
      await ingestTreasuryTransaction(db, t(getDisclosurePostedEventEncoder().encode({ treasury: T, hash: new Uint8Array(32), at: 8_000n, count: 1 }), getAssignmentRecordedEventEncoder().encode({ treasury: T }), getUnclaimedSweptEventEncoder().encode({ treasury: T, amount: 42n, to: A.recipient })));
      expect((await q('SELECT disclosures, last_disclosure_at::text AS at, disclosure_request_since, assigned, swept::text AS swept FROM treasuries WHERE address = $1', [T]))[0]).toEqual({ disclosures: 1, at: '8000', disclosure_request_since: null, assigned: true, swept: '42' });
    });

    it('decodes only what the treasury program wrote', () => {
      expect(decodeTreasuryLogs(log(ZERO, getUnclaimedSweptEventEncoder().encode({ treasury: A.treasury, amount: 1n, to: A.alice })))).toEqual([]);
    });
  });

  describe('cross_settle', () => {
    const s = (...events: Uint8Array[]) => tx(log(CROSS_SETTLE_PROGRAM_ADDRESS, ...events));
    it('projects venues, partner payouts and the greenshoe, and attributes greenshoe events to their cross', async () => {
      await ingestSettleTransaction(db, s(getDlmmPairOpenedEventEncoder().encode({ cross: A.cross, lbPair: A.pool, clearingPrice: 1_300_000n, activeId: 100, binStep: 10 })));
      expect((await q('SELECT venue, pool, clearing_price::text AS price FROM settle_venues WHERE cross_address = $1', [A.cross]))[0]).toEqual({ venue: 'dlmm', pool: A.pool, price: '1300000' });
      await ingestSettleTransaction(db, s(getPartnerFeeClaimedEventEncoder().encode({ cross: A.cross, pool: A.pool, base: 5n, quote: 7n, recipient: A.recipient }), getPartnerFeeClaimedEventEncoder().encode({ cross: A.cross, pool: A.pool, base: 1n, quote: 2n, recipient: A.recipient }), getPartnerSurplusWithdrawnEventEncoder().encode({ cross: A.cross, pool: A.pool, amount: 99n, recipient: A.recipient }), getPolFeesClaimedEventEncoder().encode({ cross: A.cross, pool: A.pool, position: A.limit, tokenA: 3n, tokenB: 4n, recipient: A.recipient })));
      expect((await q('SELECT fee_base::text AS b, fee_quote::text AS q, fee_claims, surplus_withdrawn::text AS s, pol_token_a::text AS a, pol_claims FROM settle_partner WHERE cross_address = $1', [A.cross]))[0]).toEqual({ b: '6', q: '9', fee_claims: 2, s: '99', a: '3', pol_claims: 1 });
      await ingestSettleTransaction(db, s(getGreenshoeCreatedEventEncoder().encode({ cross: A.cross, greenshoe: A.greenshoe, budget: 3_000n, startTs: 10n, expiresTs: 700_000n })));
      await ingestSettleTransaction(db, s(getGreenshoeBidPlacedEventEncoder().encode({ greenshoe: A.greenshoe, level: 0, binId: 90, amount: 1_000n, limitOrder: A.limit }), getGreenshoeLevelSettledEventEncoder().encode({ greenshoe: A.greenshoe, level: 0 }), getGreenshoeFinishedEventEncoder().encode({ greenshoe: A.greenshoe, burned: 2_500n, returned: 400n })));
      expect((await q('SELECT budget::text AS budget, bids, settled_levels, finished, burned::text AS burned, returned::text AS returned FROM settle_greenshoes WHERE greenshoe = $1', [A.greenshoe]))[0]).toEqual({ budget: '3000', bids: [{ level: 0, binId: 90, amount: '1000', limitOrder: A.limit }], settled_levels: [0], finished: true, burned: '2500', returned: '400' });
      expect((await q("SELECT count(*)::int AS n FROM settle_events WHERE cross_address = $1 AND name LIKE 'Greenshoe%'", [A.cross]))[0]).toEqual({ n: 4 });
      expect(decodeSettleLogs(log(ZERO, getGreenshoeFinishedEventEncoder().encode({ greenshoe: A.greenshoe, burned: 1n, returned: 1n })))).toEqual([]);
    });
  });
});

/** A decoded cross as the encoder takes it, for building a variant of an account the test already holds. */
async function decodeLegacy(data: Uint8Array) {
  const { getCrossDecoder } = await import('@opening-cross/sdk');
  return getCrossDecoder().decode(data);
}
