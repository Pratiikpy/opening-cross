// X3, B4 and F5 in the indexer, over PGlite (a real Postgres running the indexer's own migrations): FutarchyDaoSeeded and FixedPricePresaleOpened decode from real-shaped logs and
// project onto their tables; every treasury event that moves value becomes one movement row; the read functions an API route calls filter, page and refuse bad input; and a
// replay of the stored events rebuilds exactly the rows the live path wrote.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { type Address, type ReadonlyUint8Array, getAddressDecoder } from '@solana/kit';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  CROSS_SETTLE_PROGRAM_ADDRESS,
  FIXED_PRICE_PRESALE_OPENED_EVENT_DISCRIMINATOR,
  FUTARCHY_DAO_SEEDED_EVENT_DISCRIMINATOR,
  getDlmmPairOpenedEventEncoder,
  getFixedPricePresaleOpenedEventEncoder,
  getFutarchyDaoSeededEventEncoder,
} from '@opening-cross/cross-settle-client';
import {
  TREASURY_PROGRAM_ADDRESS,
  getDistributionDepositedEventEncoder,
  getGrantCreatedEventEncoder,
  getMilestoneReleasedEventEncoder,
  getNavRedeemedEventEncoder,
  getProposalCreatedEventEncoder,
  getProposalExecutedEventEncoder,
  getRedeemedEventEncoder,
  getRoundPaidEventEncoder,
  getSpentEventEncoder,
  getTrancheReleasedEventEncoder,
  getTreasuryCreatedEventEncoder,
  getUnclaimedSweptEventEncoder,
  getVotedEventEncoder,
} from '@opening-cross/treasury-client';
import {
  MOVEMENT_KINDS,
  backfillTreasuryMovements,
  decodeSettleLogs,
  ingestSettleTransaction,
  ingestTreasuryTransaction,
  latestMovementId,
  listMovementsAfter,
  listTreasuryMovements,
  movementOf,
  settlementMarkets,
  treasuryMovementTotals,
  type ChainTx,
} from '../src/index.js';

type Row = Record<string, unknown>;
const migrations = fileURLToPath(new URL('../migrations/', import.meta.url));
const key = (n: number) => getAddressDecoder().decode(new Uint8Array(32).fill(n)) as Address;
const A = { cross: key(11), cross2: key(12), dao: key(13), dao2: key(14), presale: key(15), presale2: key(16), pool: key(17), other: key(18), treasury: key(21), treasury2: key(22), coin: key(23), creator: key(24), dest: key(25), alice: key(26), bob: key(27), payer: key(28), proposalSpend: key(29), proposalNav: key(30), grant: key(31), sweepTo: key(32), ghost: key(33), spendTo: key(34) };
const FUTARCHY = 'FUTARELBfJfQ8RDGhg1wdhddq1odMAJUePHFuBYfUxKq';
const b64 = (bytes: ReadonlyUint8Array) => Buffer.from(bytes).toString('base64');
const log = (program: string, ...events: ReadonlyUint8Array[]) => [`Program ${program} invoke [1]`, ...events.map((e) => `Program data: ${b64(e)}`), `Program ${program} success`];

describe('X3, B4 and F5 in the indexer', () => {
  let pg: PGlite;
  let db: never;
  let slot = 1_000n;
  const q = async (text: string, params: unknown[] = []): Promise<Row[]> => (await pg.query(text, params as never[])).rows as Row[];
  const exec = async (text: string, params?: unknown[]) => {
    const r = await pg.query(text, params as never[]);
    return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
  };
  const tx = (logs: string[], extra: Partial<ChainTx> = {}): ChainTx => ({ signature: `sig${slot}x${Math.random().toString(36).slice(2, 8)}`, slot: slot++, blockTime: 1_800_000_000n + slot, logs, err: null, ...extra });
  const settle = (...events: ReadonlyUint8Array[]) => tx(log(CROSS_SETTLE_PROGRAM_ADDRESS, ...events));
  const treasuryTx = (...events: ReadonlyUint8Array[]) => tx(log(TREASURY_PROGRAM_ADDRESS, ...events));

  beforeAll(async () => {
    pg = new PGlite();
    db = { query: exec, connect: async () => ({ query: exec, release() {} }) } as never;
    // twice: the indexer applies every migration on each start
    for (let pass = 0; pass < 2; pass++) for (const f of readdirSync(migrations).filter((n) => n.endsWith('.sql')).sort()) await pg.exec(readFileSync(`${migrations}${f}`, 'utf8'));
  });

  describe('X3 and B4: the two market openings of cross_settle', () => {
    const dao = getFutarchyDaoSeededEventEncoder().encode({ cross: A.cross, dao: A.dao, clearingPrice: 1_300_000n, baseAmount: 5_000_000_000n, quoteAmount: 6_500_000n });
    // the price in Q64.64: floor(1_300_000 * 2^64 / 1_000_000), above 2^64 so a 64-bit column would lose it
    const qPrice = (1_300_000n << 64n) / 1_000_000n;
    const presale = getFixedPricePresaleOpenedEventEncoder().encode({ cross: A.cross, presale: A.presale, clearingPrice: 1_300_000n, qPrice });

    it('decodes both events from a cross_settle log with every field', () => {
      expect(Array.from(dao.slice(0, 8))).toEqual(Array.from(FUTARCHY_DAO_SEEDED_EVENT_DISCRIMINATOR));
      expect(Array.from(presale.slice(0, 8))).toEqual(Array.from(FIXED_PRICE_PRESALE_OPENED_EVENT_DISCRIMINATOR));
      expect(decodeSettleLogs(log(CROSS_SETTLE_PROGRAM_ADDRESS, dao, presale))).toEqual([
        { name: 'FutarchyDaoSeeded', data: { cross: A.cross, dao: A.dao, clearingPrice: 1_300_000n, baseAmount: 5_000_000_000n, quoteAmount: 6_500_000n } },
        { name: 'FixedPricePresaleOpened', data: { cross: A.cross, presale: A.presale, clearingPrice: 1_300_000n, qPrice } },
      ]);
    });

    it('ignores the same bytes written by another program, or by a venue while cross_settle is waiting on it', () => {
      expect(decodeSettleLogs(log(FUTARCHY, dao, presale))).toEqual([]);
      const nested = [`Program ${CROSS_SETTLE_PROGRAM_ADDRESS} invoke [1]`, `Program ${FUTARCHY} invoke [2]`, `Program data: ${b64(dao)}`, `Program ${FUTARCHY} success`, `Program ${CROSS_SETTLE_PROGRAM_ADDRESS} success`];
      expect(decodeSettleLogs(nested)).toEqual([]);
    });

    it('projects a DAO and a tranche, keeps the u128 price whole, and attributes both events to the cross', async () => {
      expect(await ingestSettleTransaction(db, settle(dao, presale))).toBe(2);
      expect(await q('SELECT dao, cross_address, clearing_price::text AS price, base_amount::text AS base, quote_amount::text AS quote, slot::text AS slot FROM settle_futarchy_daos')).toEqual([
        { dao: A.dao, cross_address: A.cross, price: '1300000', base: '5000000000', quote: '6500000', slot: '1000' },
      ]);
      expect(await q('SELECT presale, cross_address, clearing_price::text AS price, q_price::text AS q, slot::text AS slot FROM settle_presales')).toEqual([
        { presale: A.presale, cross_address: A.cross, price: '1300000', q: qPrice.toString(), slot: '1000' },
      ]);
      expect(qPrice > (1n << 64n)).toBe(true);
      expect((await q("SELECT name, cross_address FROM settle_events WHERE name IN ('FutarchyDaoSeeded', 'FixedPricePresaleOpened') ORDER BY seq")).map((r) => `${r.name}:${r.cross_address === A.cross}`)).toEqual(['FutarchyDaoSeeded:true', 'FixedPricePresaleOpened:true']);
    });

    it('is idempotent per signature, and a failed transaction changes nothing', async () => {
      const again = settle(getFutarchyDaoSeededEventEncoder().encode({ cross: A.cross, dao: A.dao2, clearingPrice: 1_300_000n, baseAmount: 1n, quoteAmount: 1n }));
      expect(await ingestSettleTransaction(db, { ...again, err: { InstructionError: [0, 'Custom'] } })).toBe(0);
      expect((await q('SELECT count(*)::int AS n FROM settle_futarchy_daos'))[0]).toEqual({ n: 1 });
      expect(await ingestSettleTransaction(db, again)).toBe(1);
      expect(await ingestSettleTransaction(db, again)).toBe(0);
      expect((await q('SELECT count(*)::int AS n FROM settle_futarchy_daos'))[0]).toEqual({ n: 2 });
    });

    it('a cross can hold a pool venue, several DAOs and several tranches, and settlementMarkets lists the last two', async () => {
      await ingestSettleTransaction(db, settle(getDlmmPairOpenedEventEncoder().encode({ cross: A.cross, lbPair: A.pool, clearingPrice: 1_300_000n, activeId: 100, binStep: 10 })));
      await ingestSettleTransaction(db, settle(getFixedPricePresaleOpenedEventEncoder().encode({ cross: A.cross, presale: A.presale2, clearingPrice: 1_300_000n, qPrice })));
      const m = await settlementMarkets(db, A.cross);
      expect(m.futarchyDaos.map((d) => d.dao)).toEqual([A.dao, A.dao2]);
      expect(m.presales.map((p) => p.presale)).toEqual([A.presale, A.presale2]);
      expect(m.futarchyDaos[0]).toEqual({ dao: A.dao, clearingPrice: '1300000', baseAmount: '5000000000', quoteAmount: '6500000', signature: expect.any(String), slot: '1000' });
      expect(m.presales[0]!.qPrice).toBe(qPrice.toString());
      // the pool venue is still in its own table and is not displaced by either
      expect((await q('SELECT venue, pool FROM settle_venues WHERE cross_address = $1', [A.cross]))[0]).toEqual({ venue: 'dlmm', pool: A.pool });
    });

    it('answers empty lists for a cross that opened neither, and keeps other crosses apart', async () => {
      expect(await settlementMarkets(db, A.cross2)).toEqual({ futarchyDaos: [], presales: [] });
      await ingestSettleTransaction(db, settle(getFutarchyDaoSeededEventEncoder().encode({ cross: A.cross2, dao: A.other, clearingPrice: 7n, baseAmount: 2n, quoteAmount: 3n })));
      expect((await settlementMarkets(db, A.cross2)).futarchyDaos.map((d) => d.dao)).toEqual([A.other]);
      expect((await settlementMarkets(db, A.cross)).futarchyDaos.map((d) => d.dao)).toEqual([A.dao, A.dao2]);
    });

    it('treats a hostile cross string as data', async () => {
      expect(await settlementMarkets(db, "x'; DROP TABLE settle_presales; --")).toEqual({ futarchyDaos: [], presales: [] });
      expect((await q('SELECT count(*)::int AS n FROM settle_presales'))[0]!.n).toBeGreaterThan(0);
    });
  });

  describe('F5: the treasury movement read model', () => {
    const T = A.treasury;
    let signatures: string[] = [];
    const ingest = async (...events: ReadonlyUint8Array[]) => {
      const t = treasuryTx(...events);
      signatures.push(t.signature);
      return ingestTreasuryTransaction(db, t);
    };

    beforeAll(async () => {
      await ingest(getTreasuryCreatedEventEncoder().encode({ treasury: T, coinMint: A.coin, authority: A.creator, allowance: 1_000n, periodSecs: 100n }));
      await ingest(
        getProposalCreatedEventEncoder().encode({ treasury: T, proposal: A.proposalSpend, id: 0n, proposer: A.alice, kind: 0, amount: 750n, destination: A.dest, voteEndTs: 9_000n }),
        getProposalCreatedEventEncoder().encode({ treasury: T, proposal: A.proposalNav, id: 1n, proposer: A.alice, kind: 1, amount: 0n, destination: A.dest, voteEndTs: 9_000n }),
      );
      await ingest(getGrantCreatedEventEncoder().encode({ treasury: T, grant: A.grant, id: 0n, beneficiary: A.bob, total: 100n, lockupEnd: 5_000n, expiryTs: 9_000n }));
      // one transaction with several movements, so (signature, seq) is exercised
      await ingest(
        getSpentEventEncoder().encode({ treasury: T, amount: 300n, to: A.spendTo, spentInPeriod: 300n }),
        getVotedEventEncoder().encode({ proposal: A.proposalSpend, voter: A.alice, support: true, amount: 5n, yes: 5n, no: 0n }),
        getTrancheReleasedEventEncoder().encode({ treasury: T, round: 3n, amount: 200n }),
      );
      await ingest(getProposalExecutedEventEncoder().encode({ proposal: A.proposalSpend, kind: 0, amount: 750n }));
      await ingest(getProposalExecutedEventEncoder().encode({ proposal: A.proposalNav, kind: 1, amount: 0n }));
      await ingest(getMilestoneReleasedEventEncoder().encode({ grant: A.grant, index: 0, amount: 25n }), getMilestoneReleasedEventEncoder().encode({ grant: A.grant, index: 1, amount: 0n }));
      await ingest(getUnclaimedSweptEventEncoder().encode({ treasury: T, amount: 40n, to: A.sweepTo }));
      await ingest(getRedeemedEventEncoder().encode({ treasury: T, holder: A.alice, burned: 10n, paid: 120n }), getNavRedeemedEventEncoder().encode({ treasury: T, holder: A.bob, burned: 4n, paid: 55n, periodBurned: 14n }));
      await ingest(getDistributionDepositedEventEncoder().encode({ treasury: T, from: A.payer, amount: 1_000n, totalStaked: 350n }), getRoundPaidEventEncoder().encode({ treasury: T, round: 3n, revenue: 5_000n, due: 500n, payer: A.payer }));
      // an event the index cannot attribute to a treasury (it names a proposal the index never saw)
      await ingest(getProposalExecutedEventEncoder().encode({ proposal: A.ghost, kind: 0, amount: 9n }));
      // a second treasury
      await ingest(getTreasuryCreatedEventEncoder().encode({ treasury: A.treasury2, coinMint: key(40), authority: A.creator, allowance: 1n, periodSecs: 1n }), getSpentEventEncoder().encode({ treasury: A.treasury2, amount: 7n, to: A.spendTo, spentInPeriod: 7n }));
    });

    const summary = (rows: { kind: string; direction: string; asset: string; amount: string; counterparty: string | null; reference: string | null; teamOutflow: boolean }[]) => rows.map((r) => `${r.kind}|${r.direction}|${r.asset}|${r.amount}|${r.counterparty ?? '-'}|${r.reference ?? '-'}|${r.teamOutflow}`);

    it('writes one row per event that moves value, with what the event means', async () => {
      const { movements } = await listTreasuryMovements(db, { treasury: T, limit: 100 });
      expect(summary(movements.slice().reverse())).toEqual([
        `spend|out|quote|300|${A.spendTo}|-|true`,
        `tranche_release|out|quote|200|-|3|true`,
        `proposal_spend|out|quote|750|${A.dest}|${A.proposalSpend}|true`,
        `grant_release|out|coin|25|${A.bob}|${A.grant}|false`,
        `sweep|out|quote|40|${A.sweepTo}|-|false`,
        `redemption|out|quote|120|${A.alice}|-|false`,
        `nav_redemption|out|quote|55|${A.bob}|-|false`,
        `distribution_deposit|in|quote|1000|${A.payer}|-|false`,
        `revenue_share|in|quote|500|${A.payer}|3|false`,
      ]);
      // every kind the module declares is exercised
      expect(new Set(movements.map((m) => m.kind))).toEqual(new Set(MOVEMENT_KINDS));
    });

    it('records no movement for a vote, a NAV-window proposal, a zero-amount milestone or an event with no treasury', async () => {
      const kinds = (await q('SELECT count(*)::int AS n FROM treasury_movements'))[0]!.n;
      expect(kinds).toBe(10); // nine for the first treasury, one for the second
      expect((await q("SELECT count(*)::int AS n FROM treasury_movements WHERE reference = $1", [A.proposalNav]))[0]).toEqual({ n: 0 });
      expect((await q("SELECT count(*)::int AS n FROM treasury_movements WHERE treasury = ''"))[0]).toEqual({ n: 0 });
      // the events themselves are all there
      expect((await q("SELECT count(*)::int AS n FROM treasury_events WHERE name = 'ProposalExecuted'"))[0]).toEqual({ n: 3 });
    });

    it('carries the detail an alert needs, and the transaction position of each event', async () => {
      const { movements } = await listTreasuryMovements(db, { kinds: ['redemption', 'nav_redemption', 'revenue_share', 'grant_release'] });
      const byKind = Object.fromEntries(movements.map((m) => [m.kind, m]));
      expect(byKind.redemption!.detail).toEqual({ coinBurned: '10' });
      expect(byKind.nav_redemption!.detail).toEqual({ coinBurned: '4', periodBurned: '14' });
      expect(byKind.revenue_share!.detail).toEqual({ revenue: '5000' });
      expect(byKind.grant_release!.detail).toEqual({ milestone: 0 });
      const same = (await listTreasuryMovements(db, { treasury: T, limit: 100 })).movements.filter((m) => m.signature === movements[0]!.signature);
      expect(same.length).toBeGreaterThan(0);
      const spendTx = (await listTreasuryMovements(db, { kinds: ['spend'], treasury: T })).movements[0]!;
      const trancheTx = (await listTreasuryMovements(db, { kinds: ['tranche_release'] })).movements[0]!;
      expect([spendTx.seq, trancheTx.seq, spendTx.signature === trancheTx.signature]).toEqual([0, 2, true]);
      expect(spendTx.time).toMatch(/^\d{10}$/);
    });

    it('is idempotent: the same transaction again and a failed transaction add nothing', async () => {
      const before = (await q('SELECT count(*)::int AS n FROM treasury_movements'))[0]!.n;
      const t = treasuryTx(getSpentEventEncoder().encode({ treasury: T, amount: 1n, to: A.spendTo, spentInPeriod: 1n }));
      expect(await ingestTreasuryTransaction(db, { ...t, err: { InstructionError: [0, 'Custom'] } })).toBe(0);
      expect((await q('SELECT count(*)::int AS n FROM treasury_movements'))[0]!.n).toBe(before);
      expect(await ingestTreasuryTransaction(db, t)).toBe(1);
      expect(await ingestTreasuryTransaction(db, t)).toBe(0);
      expect((await q('SELECT count(*)::int AS n FROM treasury_movements'))[0]!.n).toBe((before as number) + 1);
      await pg.query("DELETE FROM treasury_movements WHERE amount = 1 AND kind = 'spend'");
      await pg.query("DELETE FROM treasury_events WHERE signature = $1", [t.signature]);
    });

    it('filters by treasury, kind, direction, asset, team outflow, counterparty, amount and slot', async () => {
      const kinds = async (f: Parameters<typeof listTreasuryMovements>[1]) => (await listTreasuryMovements(db, { limit: 100, ...f })).movements.map((m) => m.kind).sort();
      expect(await kinds({ treasury: A.treasury2 })).toEqual(['spend']);
      expect(await kinds({ treasury: T, teamOutflowOnly: true })).toEqual(['proposal_spend', 'spend', 'tranche_release']);
      expect(await kinds({ treasury: T, direction: 'in' })).toEqual(['distribution_deposit', 'revenue_share']);
      expect(await kinds({ treasury: T, asset: 'coin' })).toEqual(['grant_release']);
      expect(await kinds({ counterparty: A.alice })).toEqual(['redemption']);
      expect(await kinds({ treasury: T, minAmount: '300' })).toEqual(['distribution_deposit', 'proposal_spend', 'revenue_share', 'spend']);
      expect(await kinds({ treasury: T, kinds: ['sweep', 'spend'] })).toEqual(['spend', 'sweep']);
      const all = (await listTreasuryMovements(db, { limit: 100 })).movements;
      const midSlot = all[4]!.slot;
      const later = await listTreasuryMovements(db, { sinceSlot: midSlot, limit: 100 });
      expect(later.movements.every((m) => BigInt(m.slot) >= BigInt(midSlot))).toBe(true);
      expect(later.movements.length).toBeLessThan(all.length);
    });

    it('pages newest first without gaps or repeats', async () => {
      const seen: string[] = [];
      let before: string | undefined;
      for (let pages = 0; pages < 10; pages++) {
        const page = await listTreasuryMovements(db, { limit: 3, ...(before && { before }) });
        expect(page.movements.length).toBeLessThanOrEqual(3);
        seen.push(...page.movements.map((m) => m.id));
        if (!page.next) break;
        before = page.next;
      }
      expect(seen).toHaveLength(10);
      expect(new Set(seen).size).toBe(10);
      expect(seen.map(Number)).toEqual(seen.map(Number).sort((a, b) => b - a));
    });

    it('lists what is new after an id, oldest first, which is how an alert builder polls', async () => {
      const all = await listMovementsAfter(db, '0');
      expect(all).toHaveLength(10);
      expect(all.map((m) => Number(m.id))).toEqual(all.map((m) => Number(m.id)).sort((a, b) => a - b));
      const rest = await listMovementsAfter(db, all[6]!.id);
      expect(rest.map((m) => m.id)).toEqual(all.slice(7).map((m) => m.id));
      expect(await listMovementsAfter(db, all.at(-1)!.id)).toEqual([]);
      expect(await latestMovementId(db)).toBe(all.at(-1)!.id);
      expect((await listMovementsAfter(db, '0', { teamOutflowOnly: true, treasury: T })).map((m) => m.kind)).toEqual(['spend', 'tranche_release', 'proposal_spend']);
      // a new movement appears after the remembered id and only then
      await ingest(getSpentEventEncoder().encode({ treasury: T, amount: 2n, to: A.spendTo, spentInPeriod: 302n }));
      const fresh = await listMovementsAfter(db, all.at(-1)!.id);
      expect(fresh.map((m) => [m.kind, m.amount])).toEqual([['spend', '2']]);
    });

    it('sums by kind, direction and asset, and never adds the two assets together', async () => {
      const totals = await treasuryMovementTotals(db, T);
      const get = (kind: string) => totals.find((t) => t.kind === kind)!;
      expect(get('spend')).toEqual({ kind: 'spend', direction: 'out', asset: 'quote', count: 2, amount: '302' });
      expect(get('grant_release')).toMatchObject({ asset: 'coin', amount: '25', count: 1 });
      expect(totals.filter((t) => t.asset === 'coin')).toHaveLength(1);
      expect(await treasuryMovementTotals(db, key(99))).toEqual([]);
    });

    it('refuses bad input instead of building SQL from it', async () => {
      await expect(listTreasuryMovements(db, { limit: 0 })).rejects.toThrow(RangeError);
      await expect(listTreasuryMovements(db, { limit: 201 })).rejects.toThrow(RangeError);
      await expect(listTreasuryMovements(db, { limit: 1.5 })).rejects.toThrow(RangeError);
      await expect(listTreasuryMovements(db, { before: '1; DROP TABLE treasury_movements' })).rejects.toThrow(RangeError);
      await expect(listTreasuryMovements(db, { minAmount: '-1' })).rejects.toThrow(RangeError);
      await expect(listTreasuryMovements(db, { sinceSlot: 'x' })).rejects.toThrow(RangeError);
      await expect(listTreasuryMovements(db, { kinds: ['rug'] as never })).rejects.toThrow(/unknown movement kind/);
      await expect(listMovementsAfter(db, 'abc')).rejects.toThrow(RangeError);
      await expect(listMovementsAfter(db, '0', { limit: 1001 })).rejects.toThrow(RangeError);
      // hostile text as a filter value is only a value
      expect((await listTreasuryMovements(db, { treasury: "x' OR '1'='1", counterparty: "'; --" })).movements).toEqual([]);
      expect((await q('SELECT count(*)::int AS n FROM treasury_movements'))[0]!.n).toBeGreaterThan(0);
    });

    it('rebuilds the same rows from the stored events (the backfill), and a second run writes nothing', async () => {
      const key2 = (r: Row) => `${r.signature}|${r.seq}|${r.slot}|${r.treasury}|${r.kind}|${r.direction}|${r.asset}|${r.amount}|${r.counterparty}|${r.reference}|${r.team_outflow}|${JSON.stringify(r.detail)}|${r.block_time}`;
      const read = async () => (await q('SELECT signature, seq, slot::text AS slot, treasury, kind, direction, asset, amount::text AS amount, counterparty, reference, team_outflow, detail, extract(epoch FROM block_time)::text AS block_time FROM treasury_movements ORDER BY slot, signature, seq')).map(key2);
      const live = await read();
      expect(live).toHaveLength(11);
      await pg.query('DELETE FROM treasury_movements');
      expect(await backfillTreasuryMovements(db)).toBe(11);
      expect(await read()).toEqual(live);
      expect(await backfillTreasuryMovements(db)).toBe(0);
    });

    it('backfills across many pages even when most stored events move nothing', async () => {
      await pg.query('DELETE FROM treasury_movements');
      // 1,200 stored events that are read as movements and mean nothing (a NAV-window proposal) sit before 600 that do, so a backfill that stopped at the first empty page would write none of them
      await pg.query(
        `INSERT INTO treasury_events (signature, seq, slot, block_time, name, treasury, payload)
         SELECT 'bulk-quiet-' || g, 0, 10 + g, to_timestamp(1800000000), 'ProposalExecuted', $1::text, jsonb_build_object('proposal', $2::text, 'kind', 1, 'amount', '0') FROM generate_series(1, 1200) g`,
        [T, A.proposalNav],
      );
      await pg.query(
        `INSERT INTO treasury_events (signature, seq, slot, block_time, name, treasury, payload)
         SELECT 'bulk-spend-' || g, 0, 100000 + g, to_timestamp(1800000000), 'Spent', $1::text, jsonb_build_object('treasury', $1::text, 'amount', '5', 'to', $2::text, 'spentInPeriod', '5') FROM generate_series(1, 600) g`,
        [T, A.spendTo],
      );
      expect(await backfillTreasuryMovements(db)).toBe(11 + 600);
      expect((await q("SELECT count(*)::int AS n FROM treasury_movements WHERE signature LIKE 'bulk-spend-%'"))[0]).toEqual({ n: 600 });
      expect(await backfillTreasuryMovements(db)).toBe(0);
    });

    it('movementOf is a pure reading of the payload: unknown events and NAV-window proposals are null', async () => {
      const none = { proposalDestination: async () => null, grantBeneficiary: async () => null };
      expect(await movementOf('Staked', { treasury: T, amount: '1' }, none)).toBeNull();
      expect(await movementOf('ProposalExecuted', { proposal: A.proposalNav, kind: 2, amount: '0' }, none)).toBeNull();
      expect(await movementOf('ProposalExecuted', { proposal: A.proposalSpend, kind: 0, amount: '5' }, none)).toMatchObject({ kind: 'proposal_spend', counterparty: null });
    });
  });

  it('applying the migrations again leaves the new tables and their rows untouched', async () => {
    const before = (await q('SELECT (SELECT count(*) FROM settle_presales)::int AS p, (SELECT count(*) FROM treasury_movements)::int AS m'))[0];
    for (const f of readdirSync(migrations).filter((n) => n.endsWith('.sql')).sort()) await pg.exec(readFileSync(`${migrations}${f}`, 'utf8'));
    expect((await q('SELECT (SELECT count(*) FROM settle_presales)::int AS p, (SELECT count(*) FROM treasury_movements)::int AS m'))[0]).toEqual(before);
  });
});
