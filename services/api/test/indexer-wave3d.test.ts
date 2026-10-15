// The indexer's side of the seven Wave 3D programs, over PGlite: every event decodes from a real-shaped log (encoded with the generated clients, as Anchor writes them) and
// projects onto its table, a re-read of a transaction changes nothing, a failed or foreign one changes nothing, and the table of decoders covers every event in every IDL.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import { type Address, getAddressDecoder, some } from '@solana/kit';
import { CROSS_CORE_PROGRAM_ADDRESS } from '@opening-cross/sdk';
import * as mandate from '@opening-cross/cross-mandate-client';
import * as conviction from '@opening-cross/cross-conviction-client';
import * as basket from '@opening-cross/cross-basket-client';
import * as listing from '@opening-cross/cross-listing-client';
import * as bounty from '@opening-cross/cross-bounty-client';
import * as backing from '@opening-cross/cross-backing-client';
import * as graduate from '@opening-cross/cross-graduate-client';
import { type ChainTx, EVENT_CODECS, PROGRAM_IDS, UnattributableLogs, decodeProgramLogs, ingestProgramTransaction, payloadJson, pollProgramOnce, subjectOf } from '@opening-cross/indexer';
import { database } from './helpers/wave3d.js';

const key = (n: number) => getAddressDecoder().decode(new Uint8Array(32).fill(n + 90)) as Address;
const [CROSS, OWNER, AGENT, QUOTE, MINT, HOLDER, MANDATE, ORDER, LOCK, BADGE, BASKET, SHARE, VENUE, LISTER, BOND, LISTING, SLASH_TO, BOUNTY, SPONSOR, ARBITER, HUNTER, POLICY, ATTESTER, CHARTER, ROUND, VOTER, OUTCOME, VOTER2, CLAIMANT, REWARD_MINT] = Array.from({ length: 30 }, (_, i) => key(i + 1));
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const log = (program: string, ...events: Uint8Array[]) => [`Program ${program} invoke [1]`, ...events.map((e) => `Program data: ${b64(e)}`), `Program ${program} success`];
let n = 0;
const tx = (logs: string[], over: Partial<ChainTx> = {}): ChainTx => ({ signature: `sig${++n}`, slot: BigInt(100 + n), blockTime: 1_800_000_000n, logs, err: null, ...over });
const limits = (o: Partial<{ maxPerOrder: bigint; totalCap: bigint; maxShareBps: number; expiresAt: bigint }> = {}) => ({ maxPerOrder: o.maxPerOrder ?? 1_000n, totalCap: o.totalCap ?? 5_000n, maxShareBps: o.maxShareBps ?? 2_500, expiresAt: o.expiresAt ?? 1_900_000_000n, allow: [{ kind: mandate.AllowKind.Creator, key: OWNER }, { kind: mandate.AllowKind.Cross, key: CROSS }] });

describe('the Wave 3D indexer', () => {
  let pg: PGlite;
  let db: never;
  const q = async (text: string, params: unknown[] = []) => (await pg.query(text, params as never[])).rows as Record<string, any>[];
  const ingest = (program: keyof typeof PROGRAM_IDS, ...events: Uint8Array[]) => ingestProgramTransaction(db, tx(log(PROGRAM_IDS[program], ...events)));

  beforeAll(async () => {
    const d = await database();
    pg = d.pg;
    // the pg.Pool surface ingest uses: query and connect().query/release
    const run = async (text: string, params?: unknown[]) => {
      const r = await pg.query(text, params as never[]);
      return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
    };
    db = { query: run, connect: async () => ({ query: run, release() {} }) } as never;
  }, 60_000);

  it('projects a mandate: created, funded, limits changed, orders placed, withdrawn, revoked', async () => {
    expect(await ingest('cross_mandate', mandate.getMandateCreatedEventEncoder().encode({ mandate: MANDATE, owner: OWNER, agent: AGENT, quoteMint: QUOTE, limits: limits() }) as Uint8Array)).toBe(1);
    await ingest('cross_mandate', mandate.getMandateFundedEventEncoder().encode({ mandate: MANDATE, amount: 4_000n, lamports: 9_000_000n }) as Uint8Array, mandate.getMandateFundedEventEncoder().encode({ mandate: MANDATE, amount: 1_000n, lamports: 0n }) as Uint8Array);
    await ingest('cross_mandate', mandate.getMandateOrderPlacedEventEncoder().encode({ mandate: MANDATE, cross: CROSS, order: ORDER, escrow: 1_300n, committed: 1_300n }) as Uint8Array);
    let [m] = await q('SELECT * FROM mandates WHERE address = $1', [MANDATE]);
    expect(m).toMatchObject({ owner: OWNER, agent: AGENT, quote_mint: QUOTE, max_per_order: '1000', total_cap: '5000', max_share_bps: 2500, expires_at: 1900000000, committed: '1300', funded: '5000', funded_lamports: '9000000', orders: 1, revoked: false, withdrawn: '0' });
    expect(m!.allow).toEqual([{ kind: 1, key: OWNER }, { kind: 2, key: CROSS }]);
    await ingest('cross_mandate', mandate.getLimitsChangedEventEncoder().encode({ mandate: MANDATE, limits: limits({ maxPerOrder: 2_000n, totalCap: 9_000n }) }) as Uint8Array);
    await ingest('cross_mandate', mandate.getMandateWithdrawnEventEncoder().encode({ mandate: MANDATE, amount: 700n }) as Uint8Array, mandate.getMandateRevokedEventEncoder().encode({ mandate: MANDATE }) as Uint8Array);
    [m] = await q('SELECT * FROM mandates WHERE address = $1', [MANDATE]);
    expect(m).toMatchObject({ max_per_order: '2000', total_cap: '9000', withdrawn: '700', revoked: true, committed: '1300' });
    expect(await q('SELECT order_address, cross_address, escrow FROM mandate_orders WHERE mandate = $1', [MANDATE])).toEqual([{ order_address: ORDER, cross_address: CROSS, escrow: '1300' }]);
    // the log files each event under its mandate, and the order event under its cross too
    const events = await q(`SELECT name, subject, cross_address FROM program_events WHERE program = 'cross_mandate' ORDER BY slot, seq`);
    expect(events.map((e) => e.name)).toEqual(['MandateCreated', 'MandateFunded', 'MandateFunded', 'MandateOrderPlaced', 'LimitsChanged', 'MandateWithdrawn', 'MandateRevoked']);
    expect(events.every((e) => e.subject === MANDATE)).toBe(true);
    expect(events.find((e) => e.name === 'MandateOrderPlaced')!.cross_address).toBe(CROSS);
    expect(events.find((e) => e.name === 'MandateCreated')!.cross_address).toBeNull();
  });

  it('projects conviction: lock, badge mint, unlock, badge claim', async () => {
    await ingest('cross_conviction', conviction.getLockedEventEncoder().encode({ lock: LOCK, holder: HOLDER, mint: MINT, amount: 100_000_000n, lockedAt: 1_800_000_000n, unlockTs: 1_802_592_000n }) as Uint8Array);
    expect(await q('SELECT holder, amount, unlocked, badge_claimed, token_days FROM conviction_locks WHERE lock = $1', [LOCK])).toEqual([{ holder: HOLDER, amount: '100000000', unlocked: false, badge_claimed: false, token_days: null }]);
    await ingest('cross_conviction', conviction.getBadgeCreatedEventEncoder().encode({ holder: HOLDER, mint: MINT, badgeMint: BADGE }) as Uint8Array, conviction.getUnlockedEventEncoder().encode({ lock: LOCK, holder: HOLDER, amount: 100_000_000n }) as Uint8Array, conviction.getBadgeClaimedEventEncoder().encode({ lock: LOCK, holder: HOLDER, tokenDays: 3_000n }) as Uint8Array);
    expect(await q('SELECT unlocked, badge_claimed, token_days FROM conviction_locks WHERE lock = $1', [LOCK])).toEqual([{ unlocked: true, badge_claimed: true, token_days: '3000' }]);
    expect(await q('SELECT badge_mint FROM conviction_badges WHERE holder = $1 AND mint = $2', [HOLDER, MINT])).toEqual([{ badge_mint: BADGE }]);
    // a second BadgeCreated for the same holder and token is the same badge
    await ingest('cross_conviction', conviction.getBadgeCreatedEventEncoder().encode({ holder: HOLDER, mint: MINT, badgeMint: BADGE }) as Uint8Array);
    expect(await q('SELECT count(*)::int AS n FROM conviction_badges')).toEqual([{ n: 1 }]);
  });

  it('projects a basket: its components, then shares minted and redeemed', async () => {
    await ingest('cross_basket', basket.getBasketCreatedEventEncoder().encode({ basket: BASKET, creator: OWNER, shareMint: SHARE, components: [{ mint: MINT, tokenProgram: QUOTE, unitsPerShare: 2_000_000n }, { mint: QUOTE, tokenProgram: QUOTE, unitsPerShare: 7n }] }) as Uint8Array);
    await ingest('cross_basket', basket.getSharesMintedEventEncoder().encode({ basket: BASKET, user: HOLDER, shares: 3_000_000n }) as Uint8Array, basket.getSharesMintedEventEncoder().encode({ basket: BASKET, user: AGENT, shares: 500_000n }) as Uint8Array, basket.getSharesRedeemedEventEncoder().encode({ basket: BASKET, user: HOLDER, shares: 1_000_000n }) as Uint8Array);
    const [row] = await q('SELECT * FROM baskets WHERE address = $1', [BASKET]);
    expect(row).toMatchObject({ creator: OWNER, share_mint: SHARE, minted: '3500000', redeemed: '1000000' });
    expect(row!.components).toEqual([{ mint: MINT, tokenProgram: QUOTE, unitsPerShare: '2000000' }, { mint: QUOTE, tokenProgram: QUOTE, unitsPerShare: '7' }]);
  });

  it('projects listing: a venue, a bond that learns its venue from the first listing, a release, a slash', async () => {
    await ingest('cross_listing', listing.getVenueCreatedEventEncoder().encode({ venue: VENUE, creator: OWNER, bondMint: MINT, minBond: 100n, releaseDelaySecs: 172_800n, slashTo: SLASH_TO }) as Uint8Array);
    const [bond] = (await listing.findBondPda({ venue: VENUE, lister: LISTER })) as [Address, number];
    await ingest('cross_listing', listing.getBondDepositedEventEncoder().encode({ bond, lister: LISTER, amount: 250n, total: 250n }) as Uint8Array);
    expect(await q('SELECT amount, venue FROM listing_bonds WHERE bond = $1', [bond])).toEqual([{ amount: '250', venue: null }]);
    await ingest('cross_listing', listing.getListedEventEncoder().encode({ listing: LISTING, venue: VENUE, lister: LISTER, cross: CROSS, amount: 100n }) as Uint8Array, listing.getBondWithdrawnEventEncoder().encode({ bond, lister: LISTER, amount: 50n, total: 200n }) as Uint8Array);
    expect(await q('SELECT amount, venue FROM listing_bonds WHERE bond = $1', [bond])).toEqual([{ amount: '200', venue: VENUE }]);
    expect(await q('SELECT status, amount FROM listing_listings WHERE listing = $1', [LISTING])).toEqual([{ status: 'open', amount: '100' }]);
    await ingest('cross_listing', listing.getListingReleasedEventEncoder().encode({ listing: LISTING, amount: 100n }) as Uint8Array);
    expect(await q('SELECT status FROM listing_listings WHERE listing = $1', [LISTING])).toEqual([{ status: 'released' }]);
    await ingest('cross_listing', listing.getListedEventEncoder().encode({ listing: BOND, venue: VENUE, lister: LISTER, cross: ORDER, amount: 100n }) as Uint8Array, listing.getListingSlashedEventEncoder().encode({ listing: BOND, amount: 100n, to: SLASH_TO }) as Uint8Array);
    expect(await q('SELECT status, slashed_to FROM listing_listings WHERE listing = $1', [BOND])).toEqual([{ status: 'slashed', slashed_to: SLASH_TO }]);
    expect((await q('SELECT min_bond, release_delay_secs FROM listing_venues WHERE venue = $1', [VENUE]))[0]).toEqual({ min_bond: '100', release_delay_secs: 172800 });
  });

  it('projects a bounty: the pool, the paid mask, payouts to claimants and to the arbiter\'s hunter, the withdrawal', async () => {
    const rewards = Array.from({ length: 11 }, (_, i) => BigInt(10 * (i + 1)));
    await ingest('cross_bounty', bounty.getBountyCreatedEventEncoder().encode({ bounty: BOUNTY, sponsor: SPONSOR, arbiter: ARBITER, rewardMint: REWARD_MINT, expiresAt: 1_900_000_000n, rewards }) as Uint8Array, bounty.getBountyFundedEventEncoder().encode({ bounty: BOUNTY, funder: SPONSOR, amount: 1_000n }) as Uint8Array);
    await ingest('cross_bounty', bounty.getInvariantPaidEventEncoder().encode({ bounty: BOUNTY, invariant: 0, cross: CROSS, claimant: CLAIMANT, amount: 10n }) as Uint8Array, bounty.getInvariantPaidEventEncoder().encode({ bounty: BOUNTY, invariant: 9, cross: ORDER, claimant: CLAIMANT, amount: 100n }) as Uint8Array);
    await ingest('cross_bounty', bounty.getAwardedEventEncoder().encode({ bounty: BOUNTY, to: HUNTER, amount: 300n, evidence: new Uint8Array(32).fill(0xab) }) as Uint8Array, bounty.getBountyWithdrawnEventEncoder().encode({ bounty: BOUNTY, amount: 590n }) as Uint8Array);
    const [row] = await q('SELECT * FROM bounties WHERE address = $1', [BOUNTY]);
    expect(row).toMatchObject({ sponsor: SPONSOR, arbiter: ARBITER, funded: '1000', paid: '110', awarded: '300', withdrawn: '590', paid_mask: (1 << 0) | (1 << 9) });
    expect(row!.rewards).toEqual(rewards.map(String));
    const payouts = await q('SELECT kind, invariant, cross_address, recipient, amount, evidence FROM bounty_payouts WHERE bounty = $1 ORDER BY slot, seq_key', [BOUNTY]);
    expect(payouts).toEqual([
      { kind: 'invariant', invariant: 0, cross_address: CROSS, recipient: CLAIMANT, amount: '10', evidence: null },
      { kind: 'invariant', invariant: 9, cross_address: ORDER, recipient: CLAIMANT, amount: '100', evidence: null },
      { kind: 'award', invariant: null, cross_address: null, recipient: HUNTER, amount: '300', evidence: 'ab'.repeat(32) },
    ]);
    // two payouts in one transaction are two rows, not one
    expect(new Set(payouts.map((p) => p.amount)).size).toBe(3);
  });

  it('projects backing: the policy, the latest statement, every failed check', async () => {
    await ingest('cross_backing', backing.getPolicyCreatedEventEncoder().encode({ policy: POLICY, mint: MINT, attester: ATTESTER, minCoverageBps: 10_000, maxAgeSecs: 3_600n }) as Uint8Array);
    await ingest('cross_backing', backing.getAttestedEventEncoder().encode({ mint: MINT, attester: ATTESTER, backingAtoms: 1_000n, postedTs: 1_800_000_000n }) as Uint8Array, backing.getAttestedEventEncoder().encode({ mint: MINT, attester: ATTESTER, backingAtoms: 1_500n, postedTs: 1_800_000_600n }) as Uint8Array);
    await ingest('cross_backing', backing.getBackingFailedEventEncoder().encode({ mint: MINT, reason: 2, supply: 1_400n, checkedTs: 1_800_009_999n }) as Uint8Array);
    expect(await q('SELECT attester, min_coverage_bps, max_age_secs FROM backing_policies WHERE mint = $1', [MINT])).toEqual([{ attester: ATTESTER, min_coverage_bps: 10_000, max_age_secs: 3600 }]);
    expect(await q('SELECT backing_atoms, posted_ts FROM backing_attestations WHERE mint = $1', [MINT])).toEqual([{ backing_atoms: '1500', posted_ts: 1800000600 }]);
    expect(await q('SELECT reason, supply, checked_ts FROM backing_failures WHERE mint = $1', [MINT])).toEqual([{ reason: 2, supply: '1400', checked_ts: 1800009999 }]);
    // the log files the policy event under the mint, like the others
    expect((await q(`SELECT subject FROM program_events WHERE name = 'PolicyCreated'`))[0]!.subject).toBe(POLICY);
    expect((await q(`SELECT subject FROM program_events WHERE name = 'BackingFailed'`))[0]!.subject).toBe(MINT);
  });

  it('projects a graduation: charter, round, votes that add up per venue, volume, the verdict, the outcome, the withdrawals', async () => {
    await ingest('cross_graduate', graduate.getCharterCreatedEventEncoder().encode({ charter: CHARTER, cross: CROSS, quorumBps: 4_000, windowSecs: 604_800n, minVolume: 5_000n, volumeAttester: some(ATTESTER) }) as Uint8Array);
    await ingest('cross_graduate', graduate.getRoundStartedEventEncoder().encode({ round: ROUND, cross: CROSS, index: 0, closesTs: 1_800_604_800n }) as Uint8Array);
    await ingest('cross_graduate', graduate.getVoteCastEventEncoder().encode({ round: ROUND, voter: VOTER, venue: 1, amount: 300n, lockedTotal: 300n }) as Uint8Array, graduate.getVoteCastEventEncoder().encode({ round: ROUND, voter: VOTER2, venue: 3, amount: 100n, lockedTotal: 400n }) as Uint8Array, graduate.getVoteCastEventEncoder().encode({ round: ROUND, voter: VOTER, venue: 1, amount: 50n, lockedTotal: 450n }) as Uint8Array);
    await ingest('cross_graduate', graduate.getVolumePostedEventEncoder().encode({ round: ROUND, volumeQuote: 5_000n }) as Uint8Array);
    let [round] = await q('SELECT * FROM graduation_rounds WHERE round = $1', [ROUND]);
    expect(round).toMatchObject({ cross_address: CROSS, idx: 0, closes_ts: 1800604800, locked_total: '450', volume_quote: '5000', finalized: false, passed: null });
    expect(round!.tallies).toEqual(['0', '350', '0', '100']);
    expect(await q('SELECT voter, venue, amount FROM graduation_votes WHERE round = $1 ORDER BY voter', [ROUND])).toEqual([{ voter: VOTER, venue: 1, amount: '350' }, { voter: VOTER2, venue: 3, amount: '100' }].sort((a, b) => (a.voter < b.voter ? -1 : 1)));
    await ingest('cross_graduate', graduate.getRoundFinalizedEventEncoder().encode({ round: ROUND, passed: true, winner: 1, lockedTotal: 450n, supply: 1_000n }) as Uint8Array, graduate.getOutcomePublishedEventEncoder().encode({ outcome: OUTCOME, cross: CROSS, venue: 1 }) as Uint8Array, graduate.getVoteWithdrawnEventEncoder().encode({ round: ROUND, voter: VOTER, amount: 350n }) as Uint8Array);
    [round] = await q('SELECT * FROM graduation_rounds WHERE round = $1', [ROUND]);
    expect(round).toMatchObject({ finalized: true, passed: true, winner: 1, supply: '1000' });
    expect(await q('SELECT venue FROM graduation_outcomes WHERE cross_address = $1', [CROSS])).toEqual([{ venue: 1 }]);
    expect(await q('SELECT amount, withdrawn FROM graduation_votes WHERE round = $1 AND voter = $2', [ROUND, VOTER])).toEqual([{ amount: '0', withdrawn: true }]);
    expect((await q('SELECT volume_attester, min_volume FROM graduation_charters WHERE cross_address = $1', [CROSS]))[0]).toEqual({ volume_attester: ATTESTER, min_volume: '5000' });
    // a failed round records no winner
    await ingest('cross_graduate', graduate.getRoundStartedEventEncoder().encode({ round: CHARTER, cross: ORDER, index: 0, closesTs: 1n }) as Uint8Array, graduate.getRoundFinalizedEventEncoder().encode({ round: CHARTER, passed: false, winner: 0, lockedTotal: 10n, supply: 1_000n }) as Uint8Array);
    expect((await q('SELECT passed, winner FROM graduation_rounds WHERE round = $1', [CHARTER]))[0]).toEqual({ passed: false, winner: null });
  });

  it('applies a transaction once, ignores a failed one, a truncated log is refused, and events of other programs are left to their indexers', async () => {
    const event = mandate.getMandateRevokedEventEncoder().encode({ mandate: AGENT }) as Uint8Array;
    const same = tx(log(PROGRAM_IDS.cross_mandate, event));
    expect(await ingestProgramTransaction(db, same)).toBe(1);
    expect(await ingestProgramTransaction(db, same)).toBe(0); // the same signature again
    expect(await ingestProgramTransaction(db, tx(log(PROGRAM_IDS.cross_mandate, event), { err: { InstructionError: [0, 'Custom'] } }))).toBe(0);
    expect(await q(`SELECT count(*)::int AS n FROM program_events WHERE subject = $1`, [AGENT])).toEqual([{ n: 1 }]);
    await expect(ingestProgramTransaction(db, tx(['Program x invoke [1]', 'Log truncated']))).rejects.toBeInstanceOf(UnattributableLogs);
    // cross_mandate invokes cross_core; the event cross_core writes while it is on top is not ours
    const nested = [`Program ${PROGRAM_IDS.cross_mandate} invoke [1]`, `Program ${CROSS_CORE_PROGRAM_ADDRESS} invoke [2]`, `Program data: ${b64(event)}`, `Program ${CROSS_CORE_PROGRAM_ADDRESS} success`, `Program data: ${b64(mandate.getMandateRevokedEventEncoder().encode({ mandate: VOTER }) as Uint8Array)}`, `Program ${PROGRAM_IDS.cross_mandate} success`];
    const events = decodeProgramLogs(nested);
    expect(events).toHaveLength(1);
    expect((events[0]!.data as { mandate: string }).mandate).toBe(VOTER);
    // an event of the right program with a discriminator nobody knows is skipped, not an error
    expect(decodeProgramLogs(log(PROGRAM_IDS.cross_mandate, new Uint8Array(40).fill(9)))).toEqual([]);
    // an event of one program on another program's invoke line is not decoded by name from the wrong table
    expect(decodeProgramLogs(log(PROGRAM_IDS.cross_bounty, event))).toEqual([]);
    expect(decodeProgramLogs(['Program Other1111111111111111111111111111111111 invoke [1]', `Program data: ${b64(event)}`, 'Program Other1111111111111111111111111111111111 success'])).toEqual([]);
  });

  it('writes hex for bytes and decimal strings for numbers into the log, and files each event under its account', () => {
    const awarded = { bounty: BOUNTY, to: HUNTER, amount: 5n, evidence: new Uint8Array([1, 255]) };
    expect(payloadJson(awarded)).toEqual({ bounty: BOUNTY, to: HUNTER, amount: '5', evidence: '01ff' });
    expect(subjectOf({ program: 'cross_bounty', name: 'Awarded', data: awarded })).toBe(BOUNTY);
    expect(subjectOf({ program: 'cross_conviction', name: 'BadgeCreated', data: { holder: HOLDER, mint: MINT, badgeMint: BADGE } })).toBe(MINT);
  });

  it('has a decoder for every event of every program and nothing the programs do not have', () => {
    const idls: Record<string, string> = { cross_mandate: 'mandate', cross_conviction: 'conviction', cross_basket: 'basket', cross_listing: 'listing', cross_bounty: 'bounty', cross_backing: 'backing', cross_graduate: 'graduate' };
    const camel = (s: string) => s;
    for (const [program, short] of Object.entries(idls)) {
      const idl = JSON.parse(readFileSync(fileURLToPath(new URL(`../../../packages/cross-${short}-client/idl/${program}.json`, import.meta.url)), 'utf8')) as { address: string; events: { name: string }[] };
      expect(PROGRAM_IDS[program as keyof typeof PROGRAM_IDS], program).toBe(idl.address);
      expect(EVENT_CODECS.filter((c) => c.program === program).map((c) => camel(c.name)).sort(), program).toEqual(idl.events.map((e) => e.name).sort());
    }
    // every codec's discriminator is distinct within its program
    for (const program of Object.keys(idls)) {
      const ds = EVENT_CODECS.filter((c) => c.program === program).map((c) => Buffer.from(c.discriminator).toString('hex'));
      expect(new Set(ds).size).toBe(ds.length);
    }
  });

  it('polls a program the cluster does not have: no signatures, no rows, no error, and the cursor is not invented', async () => {
    const calls: string[] = [];
    const rpc = { getSignaturesForAddress: (program: string) => ({ send: async () => (calls.push(program), []) }) } as never;
    const before = (await q('SELECT count(*)::int AS n FROM program_events'))[0]!.n;
    expect(await pollProgramOnce(db, rpc, 'cross_basket')).toBe(0);
    expect(calls).toEqual([PROGRAM_IDS.cross_basket]);
    expect((await q('SELECT count(*)::int AS n FROM program_events'))[0]!.n).toBe(before);
    expect(await q(`SELECT 1 FROM cursors WHERE source = $1`, [`rpc:${PROGRAM_IDS.cross_basket}`])).toEqual([]);
  });
});
