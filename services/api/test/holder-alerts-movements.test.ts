// Alerts on insider, team and treasury movements (row F5, ADR-0940): the rules, the store reads, the balance scan and the routes and delivery loop,
// against a real Postgres (PGlite) carrying the indexer's own migrations. Solana is replaced by a recorder that answers the few RPC methods the scan uses;
// the scan against a real devnet token is in docs/evidence/W5-1E.md.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import type { PGlite } from '@electric-sql/pglite';
import { generateKeyPair, getAddressFromPublicKey } from '@solana/kit';
import { signDocument } from '@opening-cross/attest';
import { TEAM_SCHEMA } from '@opening-cross/integrity';
import type { AlertConfig } from '../src/routes/holder-alerts-channels.js';
import { type AlertItem, type Facts, type MovementFact, type TreasuryOutflow, type WalletMovement, describeMovement, itemsFor, parseTopics, ppmOf, ppmText } from '../src/routes/holder-alerts-core.js';
import { registerHolderAlerts } from '../src/routes/holder-alerts.js';
import { alertStore } from '../src/routes/holder-alerts-store.js';
import { BASELINE_MAX_AGE_SECONDS, type Rpc, insidersOf, scanMint, scanner } from '../src/routes/holder-alerts-watch.js';
import { RequestError } from '../src/tx.js';
import { addCross, holderDb } from './helpers/holder-pg.js';

const migration = (name: string) => readFileSync(fileURLToPath(new URL(`../../indexer/migrations/${name}`, import.meta.url)), 'utf8');

const NOW = 1_800_000_000;
const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const MINT2 = 'So11111111111111111111111111111111111111112';
const CROSS = 'ELVKGevyF2qarSYiZHAkRdAkfKruKSgKL7aS9XTrVBK8';
const CAL = 'CxtZKYwS4AoqzLhRfjvBTf6NQgDzb2GQhS3u5iB9XLCN';
const TREASURY = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ISSUER = '7MjUeRtbGsXYXQWj8CeW1iKQSMki5xQvNZR8TnJixU1A'; // creator of the cross
const AUTH = 'Ao9ZJvc133Ui22aKTfSvoP5WdEVJxF25ns25uL1ipaFc'; // mint authority
const TEAMW = 'Vote111111111111111111111111111111111111111';
const STRANGER = 'ComputeBudget111111111111111111111111111111';
const SIG = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const SUPPLY = 1_000_000_000n;

// ------------------------------------------------------------------------------------------------ the rules

const wm = (over: Partial<WalletMovement> = {}): WalletMovement => ({ topic: 'insider', id: 'w1', subject: MINT, at: NOW - 60, wallet: ISSUER, basis: 'created cross ELVK…BK8, which sells the token', beforePpm: 200_000, afterPpm: 150_000, movedPpm: 50_000, latestTx: SIG, href: `/crosses/${CROSS}`, ...over });
const tm = (over: Partial<TreasuryOutflow> = {}): TreasuryOutflow => ({ topic: 'treasury', id: 't:sig:0', subject: TREASURY, at: NOW - 30, kind: 'spend', asset: 'quote', amount: '5000000', counterparty: STRANGER, counterpartyBasis: null, teamOutflow: true, signature: SIG, href: `/treasury/${TREASURY}`, ...over });
const facts = (movements: MovementFact[], scope: Facts['scope'] = new Map()): Facts => ({ crosses: new Map(), orders: [], calendars: [], movements, scope });
const keys = (i: AlertItem[]) => i.map((x) => x.key);

describe('movement alerts: the rules', () => {
  it('delivers an insider movement to a subscriber who follows the token, and only for the topic they chose', () => {
    const f = facts([wm()]);
    expect(keys(itemsFor({ wallet: null, topics: ['insider'], watch: [MINT] }, f, NOW))).toEqual(['movement:w1']);
    expect(itemsFor({ wallet: null, topics: ['closing', 'treasury', 'team'], watch: [MINT] }, f, NOW)).toEqual([]);
    expect(itemsFor({ wallet: null, topics: ['insider'], watch: [MINT2] }, f, NOW)).toEqual([]);
    expect(itemsFor({ wallet: null, topics: ['insider'], watch: [] }, f, NOW)).toEqual([]);
  });

  it('counts a declared team wallet as an insider too, once, and never the other way round', () => {
    const f = facts([wm({ topic: 'team', id: 'w2' }), wm({ topic: 'insider', id: 'w3' })]);
    expect(keys(itemsFor({ wallet: null, topics: ['team'], watch: [MINT] }, f, NOW))).toEqual(['movement:w2']);
    expect(keys(itemsFor({ wallet: null, topics: ['insider'], watch: [MINT] }, f, NOW)).sort()).toEqual(['movement:w2', 'movement:w3']);
    expect(keys(itemsFor({ wallet: null, topics: ['insider', 'team'], watch: [MINT] }, f, NOW)).sort()).toEqual(['movement:w2', 'movement:w3']);
  });

  it('reaches a token through a followed cross, and a treasury through a followed cross, a token or the treasury itself', () => {
    const scope: Facts['scope'] = new Map([
      [CROSS, { mints: [MINT], treasuries: [TREASURY] }],
      [MINT, { mints: [MINT], treasuries: [TREASURY] }],
      [TREASURY, { mints: [MINT], treasuries: [TREASURY] }],
    ]);
    const f = facts([wm(), tm()], scope);
    for (const w of [CROSS, MINT, TREASURY]) expect(keys(itemsFor({ wallet: null, topics: ['insider', 'treasury'], watch: [w] }, f, NOW)).sort(), w).toEqual(['movement:t:sig:0', 'movement:w1']);
    // Following a treasury covers the insiders of its coin as well; following nothing covers nothing.
    expect(itemsFor({ wallet: null, topics: ['insider', 'treasury'], watch: [CAL] }, f, NOW)).toEqual([]);
  });

  it('does not send what happened before the subscription began, or before the look-back, or in the future', () => {
    const f = facts([wm({ id: 'old', at: NOW - 7 * 3600 }), wm({ id: 'before', at: NOW - 600 }), wm({ id: 'after', at: NOW - 60 }), wm({ id: 'future', at: NOW + 3600 })]);
    const i = { wallet: null, topics: ['insider' as const], watch: [MINT] };
    expect(keys(itemsFor({ ...i, since: NOW - 300 }, f, NOW))).toEqual(['movement:after']);
    expect(keys(itemsFor(i, f, NOW))).toEqual(['movement:after', 'movement:before']);
    // The in-app feed looks a day back and has no subscription start.
    expect(keys(itemsFor(i, f, NOW, 86_400, 86_400))).toEqual(['movement:after', 'movement:before', 'movement:old']);
  });

  it('orders payouts first, then movements newest first, then reminders, and caps a flood', () => {
    const f = facts(Array.from({ length: 30 }, (_, i) => wm({ id: `m${i}`, at: NOW - 100 - i })));
    f.crosses = new Map([[CROSS, { address: CROSS, state: 'Live', openTs: NOW - 3000, closeTs: NOW + 300 }]]);
    const out = itemsFor({ wallet: null, topics: ['insider', 'closing'], watch: [MINT, CROSS] }, f, NOW);
    expect(out).toHaveLength(21);
    expect(out[0]!.key).toBe('movement:m0');
    expect(out[19]!.key).toBe('movement:m19');
    expect(out[20]!.key).toBe(`closing:${CROSS}`);
  });

  it('words a movement as a fact it observed, never as a sale or an accusation', () => {
    const w = describeMovement(wm({ topic: 'team', basis: 'was listed as team by X in declaration 1234…' }));
    expect(w.title).toBe(`Team wallet ${ISSUER.slice(0, 4)}…${ISSUER.slice(-4)} moved 5.00% of token EPjF…Dt1v out`);
    expect(w.body).toContain('from 20.00% to 15.00% of the supply');
    expect(w.body).toContain('not proof of a sale');
    expect(w.body).toContain('Newest transaction on the wallet when this was seen');
    expect(`${w.title} ${w.body}`).not.toMatch(/dump|rug|scam|sold/i);
    const t = describeMovement(tm({ counterpartyBasis: 'a wallet the issuer declared as team' }));
    expect(t.title).toContain('spent from its allowance');
    expect(t.body).toContain('5000000 quote-token atoms went to');
    expect(t.body).toContain('a wallet the issuer declared as team');
    expect(t.body).toContain('team outflows the treasury program gates');
    expect(describeMovement(tm({ counterparty: null, teamOutflow: false, kind: 'tranche_release' })).body).toContain('a destination the event does not name');
  });

  it('formats shares of supply without rounding a real move to nothing', () => {
    expect(ppmText(1000)).toBe('0.10%');
    expect(ppmText(99)).toBe('under 0.01%');
    expect(ppmText(0)).toBe('0%');
    expect(ppmOf(1n, 1_000_000_000n)).toBe(0);
    expect(ppmOf(1_000_000n, 1_000_000_000n)).toBe(1000);
    expect(ppmOf(5n, 0n)).toBe(0);
    expect(parseTopics(['insider', 'team', 'treasury'])).toEqual(['insider', 'team', 'treasury']);
    expect(() => parseTopics(['insiders'])).toThrow(/unknown topic/);
  });
});

// ------------------------------------------------------------------------------------------------ a database and a chain

type Chain = { supply: bigint; authority: string | null; balances: Map<string, bigint>; failing: Set<string>; notAMint: Set<string>; calls: string[] };
function chain(): { c: Chain; rpc: Rpc } {
  const c: Chain = { supply: SUPPLY, authority: AUTH, balances: new Map(), failing: new Set(), notAMint: new Set(), calls: [] };
  const rpc: Rpc = {
    async call<T>(method: string, params: unknown[] = []): Promise<T> {
      c.calls.push(method);
      const p = params as [string, Record<string, unknown>?, Record<string, unknown>?];
      if (method === 'getAccountInfo') {
        const enc = p[1]?.encoding;
        if (enc === 'jsonParsed') {
          if (c.notAMint.has(p[0])) return { value: null } as T;
          return { value: { data: { parsed: { type: 'mint', info: { supply: c.supply.toString(), decimals: 6, mintAuthority: c.authority } } } } } as T;
        }
        return { value: null } as T;
      }
      if (method === 'getTokenAccountsByOwner') {
        if (c.failing.has(p[0])) throw new Error('RPC unavailable');
        const amount = c.balances.get(p[0]) ?? 0n;
        return { value: amount === 0n ? [] : [{ pubkey: 'TokenAcct', account: { data: { parsed: { info: { tokenAmount: { amount: amount.toString() } } } } } }] } as T;
      }
      if (method === 'getSignaturesForAddress') return [{ signature: SIG, err: null }] as T;
      throw new Error(`unexpected RPC method ${method}`);
    },
  };
  return { c, rpc };
}

async function indexerDb(): Promise<PGlite> {
  const db = await holderDb();
  await db.exec(migration('006_treasury.sql'));
  await db.exec(migration('012_integrity.sql'));
  await db.exec(migration('020_settle_markets_and_movements.sql'));
  return db;
}
async function addCrossSelling(db: PGlite, address: string, mint: string, creator: string, slot = 1) {
  await db.query(
    `INSERT INTO crosses (address, creator, kind, supply_mode, disclosure, base_mint, quote_mint, open_ts, close_ts, reveal_end_ts, protocol_fee_bps, integrator_fee_bps, state, created_slot, updated_slot)
     VALUES ($1, $2, 0, 0, 0, $3, 'Quote11111111111111111111111111111111111111', $4, $5, $5, 30, 0, 'Live', $6, $6)`,
    [address, creator, mint, NOW - 3000, NOW + 3000, slot],
  );
}
async function addTreasury(db: PGlite, address: string, coinMint: string, authority: string) {
  await db.query(`INSERT INTO treasuries (address, coin_mint, authority, allowance, period_secs, created_signature, created_slot, state, updated_slot) VALUES ($1, $2, $3, 1000, 86400, 'sig', 1, 'Active', 1)`, [address, coinMint, authority]);
}
async function addMovement(db: PGlite, o: { signature: string; seq?: number; treasury: string; kind?: string; direction?: string; asset?: string; amount?: string; counterparty?: string | null; teamOutflow?: boolean; time?: number | null }) {
  const time = o.time === null ? null : (o.time ?? NOW - 30);
  await db.query(
    'INSERT INTO treasury_movements (signature, seq, slot, block_time, treasury, kind, direction, asset, amount, counterparty, team_outflow) VALUES ($1, $2, 1, to_timestamp($3), $4, $5, $6, $7, $8, $9, $10)',
    [o.signature, o.seq ?? 0, time, o.treasury, o.kind ?? 'spend', o.direction ?? 'out', o.asset ?? 'quote', o.amount ?? '5000000', o.counterparty ?? null, o.teamOutflow ?? true],
  );
}

describe('movement alerts: store reads', () => {
  let db: PGlite;
  beforeEach(async () => {
    db = await indexerDb();
  });
  afterEach(async () => {
    await db.close();
  });

  it('resolves what a followed address stands for', async () => {
    await addCrossSelling(db, CROSS, MINT, ISSUER);
    await addTreasury(db, TREASURY, MINT, AUTH);
    await db.query(`INSERT INTO calendars (address, sessions) VALUES ($1, '[]')`, [CAL]).catch(() => undefined);
    const store = alertStore(db);
    const s = await store.scopes([CROSS, MINT, TREASURY, MINT2]);
    expect(s.get(CROSS)).toEqual({ mints: [MINT], treasuries: [TREASURY] });
    expect(s.get(MINT)).toEqual({ mints: [MINT], treasuries: [TREASURY] });
    expect(s.get(TREASURY)).toEqual({ mints: [MINT], treasuries: [TREASURY] });
    expect(s.get(MINT2)).toEqual({ mints: [MINT2], treasuries: [] });
    expect(await store.kindOf(CROSS)).toBe('cross');
    expect(await store.kindOf(TREASURY)).toBe('treasury');
    expect(await store.kindOf(MINT2)).toBe('other');
  });

  it('reads treasury outflows only: not inflows, not holders redeeming, not undated rows, and names a known counterparty', async () => {
    await addTreasury(db, TREASURY, MINT, AUTH);
    const store = alertStore(db);
    await store.setBalance(MINT, TEAMW, 'team', 'was listed as team by X', 5n, NOW);
    await addMovement(db, { signature: 's1', treasury: TREASURY, counterparty: AUTH });
    await addMovement(db, { signature: 's2', treasury: TREASURY, kind: 'proposal_spend', counterparty: TEAMW });
    await addMovement(db, { signature: 's3', treasury: TREASURY, kind: 'tranche_release', counterparty: null });
    await addMovement(db, { signature: 's4', treasury: TREASURY, kind: 'redemption', counterparty: STRANGER, teamOutflow: false });
    await addMovement(db, { signature: 's5', treasury: TREASURY, kind: 'revenue_share', direction: 'in', counterparty: STRANGER, teamOutflow: false });
    await addMovement(db, { signature: 's6', treasury: TREASURY, time: null });
    await addMovement(db, { signature: 's7', treasury: TREASURY, time: NOW - 100_000 });
    await addMovement(db, { signature: 's8', treasury: 'Other111111111111111111111111111111111111111' });
    const rows = await store.treasuryOutflows([TREASURY], NOW - 3600);
    expect(rows.map((r) => r.id).sort()).toEqual(['t:s1:0', 't:s2:0', 't:s3:0']);
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(by['t:s1:0']!.counterpartyBasis).toBe('the authority of this treasury');
    expect(by['t:s2:0']!.counterpartyBasis).toBe('a wallet the issuer declared as team');
    expect(by['t:s3:0']!.counterparty).toBeNull();
    expect(by['t:s1:0']).toMatchObject({ topic: 'treasury', subject: TREASURY, kind: 'spend', asset: 'quote', amount: '5000000', teamOutflow: true, href: `/treasury/${TREASURY}`, at: NOW - 30 });
  });

  it('answers with nothing, not an error, on a database without the treasury tables', async () => {
    const bare = await holderDb();
    const store = alertStore(bare);
    expect(await store.treasuryOutflows([TREASURY], 0)).toEqual([]);
    expect(await store.treasuriesOfCoin(MINT)).toEqual([]);
    expect(await store.signedDocument(MINT, TEAM_SCHEMA)).toBeNull();
    expect(await store.hasTable('treasury_movements')).toBe(false);
    expect((await store.scopes([TREASURY])).get(TREASURY)).toEqual({ mints: [TREASURY], treasuries: [] });
    await bare.close();
  });
});

// ------------------------------------------------------------------------------------------------ who is an insider

async function teamDocument(db: PGlite, mint: string, wallets: string[], opts: { tamper?: boolean } = {}) {
  const kp = await generateKeyPair();
  const signer = await getAddressFromPublicKey(kp.publicKey);
  const doc = await signDocument({ schema: TEAM_SCHEMA, mint, wallets, asOf: NOW - 100 }, kp);
  const stored = opts.tamper ? { ...doc, body: { ...doc.body, wallets: [...wallets, STRANGER] } } : doc;
  await db.query('INSERT INTO integrity_documents (id, schema, mint, signer, as_of, doc) VALUES ($1, $2, $3, $4, $5, $6)', [doc.id, TEAM_SCHEMA, mint, signer, NOW - 100, JSON.stringify(stored)]);
  return signer;
}

describe('who is tied to a token', () => {
  let db: PGlite;
  beforeEach(async () => {
    db = await indexerDb();
  });
  afterEach(async () => {
    await db.close();
  });

  it('collects the mint authority, cross creators, the treasury authority and a signed team list, each with its reason, team first', async () => {
    const { rpc } = chain();
    await addCrossSelling(db, CROSS, MINT, ISSUER);
    await addTreasury(db, TREASURY, MINT, AUTH);
    const signer = await teamDocument(db, MINT, [TEAMW, ISSUER]);
    const got = await insidersOf(alertStore(db), rpc, MINT, AUTH);
    const by = Object.fromEntries(got.map((g) => [g.wallet, g]));
    expect(got.map((g) => g.topic)).toEqual(['team', 'team', 'insider']);
    expect(by[TEAMW]!.basis).toContain(`was listed as team by ${signer}`);
    // A wallet that is both a cross creator and in the signed list is team, with both reasons.
    expect(by[ISSUER]).toMatchObject({ topic: 'team' });
    expect(by[ISSUER]!.basis).toContain('created cross');
    expect(by[ISSUER]!.basis).toContain('was listed as team');
    expect(by[AUTH]!.basis).toContain('is the mint authority of the token');
    expect(by[AUTH]!.basis).toContain('is the authority of treasury');
  });

  it('ignores a team list whose signature does not verify, a list for another token, and a revoked mint authority', async () => {
    const { rpc } = chain();
    await teamDocument(db, MINT, [TEAMW], { tamper: true });
    await teamDocument(db, MINT2, [STRANGER]);
    expect(await insidersOf(alertStore(db), rpc, MINT, null)).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------------ the scan

describe('the balance scan', () => {
  let db: PGlite;
  let store: ReturnType<typeof alertStore>;
  let h: ReturnType<typeof chain>;
  beforeEach(async () => {
    db = await indexerDb();
    store = alertStore(db);
    h = chain();
    await addCrossSelling(db, CROSS, MINT, ISSUER);
    h.c.balances.set(ISSUER, 200_000_000n); // 20% of the supply
    h.c.balances.set(AUTH, 0n);
  });
  afterEach(async () => {
    await db.close();
  });

  const scan = (now: number, minPpm?: number) => scanMint(store, h.rpc, MINT, { now, ...(minPpm !== undefined && { minPpm }) });

  it('takes a baseline first and says nothing about a wallet it has no earlier balance for', async () => {
    const r = await scan(NOW);
    expect(r).toMatchObject({ notAMint: false, wallets: 2, baselined: 2, failed: 0, recorded: [] });
    expect(await store.balanceOf(MINT, ISSUER)).toEqual({ amount: 200_000_000n, observedAt: NOW });
  });

  it('records a fall once, with its share of supply, the cross to open and the wallet’s newest transaction', async () => {
    await scan(NOW);
    h.c.balances.set(ISSUER, 150_000_000n);
    const r = await scan(NOW + 60);
    expect(r.recorded).toHaveLength(1);
    expect(r.recorded[0]).toMatchObject({ topic: 'insider', subject: MINT, wallet: ISSUER, beforePpm: 200_000, afterPpm: 150_000, movedPpm: 50_000, latestTx: SIG, href: `/crosses/${CROSS}`, at: NOW + 60 });
    expect(r.recorded[0]!.basis).toContain('created cross');
    // The new balance is the baseline now, so the next scan with no change is silent.
    expect((await scan(NOW + 120)).recorded).toEqual([]);
    expect(await store.walletMovements([MINT], 0)).toHaveLength(1);
  });

  it('adds up small falls until they cross the threshold, and treats growth as the new baseline', async () => {
    await scan(NOW);
    h.c.balances.set(ISSUER, 199_000_000n); // 0.1% = exactly the threshold
    expect((await scan(NOW + 60, 2000)).recorded).toEqual([]);
    h.c.balances.set(ISSUER, 198_500_000n);
    expect((await scan(NOW + 120, 2000)).recorded).toEqual([]);
    h.c.balances.set(ISSUER, 197_900_000n); // 2.1M below the 200M baseline: 0.21% > 0.2%
    const r = await scan(NOW + 180, 2000);
    expect(r.recorded).toHaveLength(1);
    expect(r.recorded[0]).toMatchObject({ beforePpm: 200_000, afterPpm: 197_900, movedPpm: 2100 });
    // A deposit raises the baseline, so a later fall is measured from the higher figure.
    h.c.balances.set(ISSUER, 300_000_000n);
    await scan(NOW + 240);
    h.c.balances.set(ISSUER, 299_000_000n);
    expect((await scan(NOW + 300)).recorded[0]).toMatchObject({ beforePpm: 300_000, afterPpm: 299_000 });
  });

  it('does not alert on a gap: a baseline older than a day is replaced, not compared', async () => {
    await scan(NOW);
    h.c.balances.set(ISSUER, 0n);
    const r = await scan(NOW + BASELINE_MAX_AGE_SECONDS + 1);
    expect(r.recorded).toEqual([]);
    expect(r.baselined).toBe(2);
  });

  it('keeps going when one wallet cannot be read, and leaves its baseline alone', async () => {
    await scan(NOW);
    h.c.failing.add(ISSUER);
    h.c.balances.set(AUTH, 0n);
    const r = await scan(NOW + 60);
    expect(r.failed).toBe(1);
    expect(await store.balanceOf(MINT, ISSUER)).toEqual({ amount: 200_000_000n, observedAt: NOW });
    h.c.failing.clear();
    h.c.balances.set(ISSUER, 100_000_000n);
    expect((await scan(NOW + 120)).recorded[0]).toMatchObject({ movedPpm: 100_000 });
  });

  it('labels a declared team wallet as team, and an address that is not a token as nothing to scan', async () => {
    await teamDocument(db, MINT, [TEAMW]);
    h.c.balances.set(TEAMW, 50_000_000n);
    await scan(NOW);
    h.c.balances.set(TEAMW, 0n);
    const r = await scan(NOW + 60);
    expect(r.recorded).toHaveLength(1);
    expect(r.recorded[0]).toMatchObject({ topic: 'team', wallet: TEAMW, movedPpm: 50_000 });
    h.c.notAMint.add(MINT2);
    expect(await scanMint(store, h.rpc, MINT2, { now: NOW })).toMatchObject({ notAMint: true, wallets: 0, recorded: [] });
  });

  it('scans a token at most once a minute and remembers an address that is not a token', async () => {
    const s = scanner(store, h.rpc);
    expect(await s.scanDue([MINT], NOW)).toHaveLength(1);
    expect(await s.scanDue([MINT], NOW + 30)).toHaveLength(0);
    expect(await s.scanDue([MINT], NOW + 61)).toHaveLength(1);
    h.c.notAMint.add(MINT2);
    expect(await s.scanDue([MINT2], NOW)).toHaveLength(0);
    h.c.calls.length = 0;
    expect(await s.scanDue([MINT2], NOW + 120)).toHaveLength(0);
    expect(h.c.calls).toEqual([]);
  });

  it('does nothing for a token with no supply', async () => {
    h.c.supply = 0n;
    expect(await scan(NOW)).toMatchObject({ wallets: 0, baselined: 0, recorded: [] });
  });
});

// ------------------------------------------------------------------------------------------------ routes and delivery

describe('movement alerts: routes and delivery', () => {
  let db: PGlite;
  let now = NOW;
  let h: ReturnType<typeof chain>;
  const pushes: { to: string; item: AlertItem }[] = [];
  const cfg: AlertConfig = { push: { publicKey: 'BPublicKeyForTests', privateKey: 'k', subject: 'mailto:ops@example.com' }, email: null, telegram: null, webUrl: 'https://app.example', secret: 's' };
  const KEYS = { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' };
  const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/device-1', keys: KEYS };

  async function build(over: Partial<Parameters<typeof registerHolderAlerts>[1]> = {}) {
    const app = Fastify();
    app.setErrorHandler((err, _req, reply) => (err instanceof RequestError ? reply.code(err.status).send({ error: err.message, ...err.detail }) : reply.code(500).send({ error: String(err) })));
    const alerts = registerHolderAlerts(app, {
      db,
      clock: () => now,
      config: cfg,
      senders: { push: async (s, item) => (pushes.push({ to: s.endpoint, item }), 'ok' as const) },
      rpc: h.rpc,
      run: false,
      ...over,
    });
    await app.ready();
    return { app, alerts };
  }
  const post = (app: Awaited<ReturnType<typeof build>>['app'], url: string, payload: unknown) => app.inject({ method: 'POST', url, payload });

  beforeEach(async () => {
    db = await indexerDb();
    now = NOW;
    h = chain();
    pushes.length = 0;
    h.c.balances.set(ISSUER, 200_000_000n);
    await addCrossSelling(db, CROSS, MINT, ISSUER);
    await addTreasury(db, TREASURY, MINT, AUTH);
  });
  afterEach(async () => {
    await db.close();
  });

  it('tells a subscriber when an insider of a followed token sells down, and when its treasury pays out, each exactly once', async () => {
    const { app, alerts } = await build();
    const r = await post(app, '/v1/alerts/push/subscribe', { subscription: sub, topics: ['insider', 'treasury'], watch: [CROSS] });
    expect(r.statusCode).toBe(200);
    expect(await alerts.tick(now)).toEqual({ sent: 0, failed: 0 }); // baselines only
    // Something that happened before the subscription is not pushed to it.
    await addMovement(db, { signature: 'old', treasury: TREASURY, counterparty: AUTH, time: now - 3000 });

    now += 61;
    h.c.balances.set(ISSUER, 120_000_000n);
    await addMovement(db, { signature: 'fresh', treasury: TREASURY, counterparty: STRANGER, time: now - 5 });
    expect(await alerts.tick(now)).toEqual({ sent: 2, failed: 0 });
    const titles = pushes.map((p) => p.item.title).sort();
    expect(titles[0]).toContain('Insider wallet');
    expect(titles[0]).toContain('moved 8.00% of token');
    expect(titles[1]).toContain('Treasury');
    expect(pushes.find((p) => p.item.kind === 'insider')!.item.href).toBe(`/crosses/${CROSS}`);
    expect(pushes.find((p) => p.item.kind === 'treasury')!.item.href).toBe(`/treasury/${TREASURY}`);

    // Never again, however many passes follow.
    now += 61;
    expect(await alerts.tick(now)).toEqual({ sent: 0, failed: 0 });
    now += 61;
    expect(await alerts.tick(now)).toEqual({ sent: 0, failed: 0 });
    expect(pushes).toHaveLength(2);
  });

  it('keeps each topic to itself: a team-only subscriber hears about a declared team wallet and not about an issuer-tied one', async () => {
    const { app, alerts } = await build();
    await teamDocument(db, MINT, [TEAMW]);
    h.c.balances.set(TEAMW, 100_000_000n);
    await post(app, '/v1/alerts/push/subscribe', { subscription: sub, topics: ['team'], watch: [MINT] });
    await alerts.tick(now);
    now += 61;
    h.c.balances.set(TEAMW, 10_000_000n);
    h.c.balances.set(ISSUER, 10_000_000n);
    expect(await alerts.tick(now)).toEqual({ sent: 1, failed: 0 });
    expect(pushes[0]!.item.title).toContain('Team wallet');
    expect((await alerts.store.walletMovements([MINT], 0)).map((m) => m.topic).sort()).toEqual(['insider', 'team']);
  });

  it('refuses a topic the deployment cannot serve, and says why, instead of accepting a subscription that stays silent', async () => {
    const off = await build({ rpc: null });
    const cfgOut = (await off.app.inject('/v1/alerts/config')).json();
    expect(cfgOut.available).toMatchObject({ claimable: true, closing: true, opening: true, insider: false, team: false, treasury: true });
    const r = await post(off.app, '/v1/alerts/push/subscribe', { subscription: sub, topics: ['closing', 'insider'] });
    expect(r.statusCode).toBe(422);
    expect(r.json()).toMatchObject({ unavailable: ['insider'] });
    expect(r.json().error).toContain('no Solana RPC');
    expect((await post(off.app, '/v1/alerts/push/subscribe', { subscription: sub, topics: ['treasury'] })).statusCode).toBe(200);
    const bare = await holderDb();
    const noTreasury = await build({ db: bare });
    expect((await noTreasury.app.inject('/v1/alerts/config')).json().available.treasury).toBe(false);
    const t = await post(noTreasury.app, '/v1/alerts/push/subscribe', { subscription: sub, topics: ['treasury'] });
    expect(t.statusCode).toBe(422);
    expect(t.json().error).toContain('migration that records treasury movements');
    await bare.close();
    // Turning a topic on later is checked the same way; one already held is not re-judged.
    const ok = (await post(off.app, '/v1/alerts/push/subscribe', { subscription: sub, topics: ['treasury'] })).json();
    expect((await post(off.app, '/v1/alerts/update', { id: ok.id, token: ok.token, topics: ['treasury', 'team'] })).statusCode).toBe(422);
    expect((await post(off.app, '/v1/alerts/update', { id: ok.id, token: ok.token, topics: ['treasury', 'closing'] })).statusCode).toBe(200);
  });

  it('shows a feed reader what moved in the last day and starts watching the token for them', async () => {
    const { app, alerts } = await build();
    const moves = (r: { items: AlertItem[] }) => r.items.map((i) => i.kind).filter((k) => k === 'insider' || k === 'team' || k === 'treasury');
    await alerts.tick(now); // nothing to do yet
    const empty = (await app.inject(`/v1/alerts/feed?watch=${CROSS}`)).json();
    expect(moves(empty)).toEqual([]);
    expect(empty.lookbackSeconds).toBe(86_400);
    await addMovement(db, { signature: 'f1', treasury: TREASURY, counterparty: STRANGER, time: now - 20_000 });
    const first = (await app.inject(`/v1/alerts/feed?watch=${CROSS}`)).json();
    expect(moves(first)).toEqual(['treasury']);
    // The feed asked about this token, so the next pass takes its baseline even though nobody subscribed.
    await alerts.tick(now);
    expect(await alerts.store.balanceOf(MINT, ISSUER)).toMatchObject({ amount: 200_000_000n });
    now += 61;
    h.c.balances.set(ISSUER, 100_000_000n);
    await alerts.tick(now);
    const later = (await app.inject(`/v1/alerts/feed?watch=${CROSS}`)).json();
    expect(moves(later)).toEqual(['insider', 'treasury']);
  });

  it('says what an address is and which wallets following it would cover', async () => {
    const { app } = await build();
    await teamDocument(db, MINT, [TEAMW]);
    const t = (await app.inject(`/v1/alerts/subject?address=${MINT}`)).json();
    expect(t).toMatchObject({ address: MINT, kind: 'token', treasuries: [TREASURY], available: { insider: true, treasury: true } });
    expect(t.tokens[0].insiders.map((i: { wallet: string }) => i.wallet).sort()).toEqual([AUTH, ISSUER, TEAMW].sort());
    expect(t.tokens[0].insiders.find((i: { wallet: string }) => i.wallet === TEAMW)).toMatchObject({ topic: 'team' });
    expect((await app.inject(`/v1/alerts/subject?address=${CROSS}`)).json()).toMatchObject({ kind: 'cross', tokens: [{ mint: MINT, isToken: true }] });
    expect((await app.inject(`/v1/alerts/subject?address=${TREASURY}`)).json()).toMatchObject({ kind: 'treasury', treasuries: [TREASURY] });
    h.c.notAMint.add(MINT2);
    const none = (await app.inject(`/v1/alerts/subject?address=${MINT2}`)).json();
    expect(none).toMatchObject({ kind: 'none', tokens: [{ isToken: false }] });
    expect((await app.inject('/v1/alerts/subject?address=nope')).statusCode).toBe(400);
    expect((await app.inject('/v1/alerts/subject')).statusCode).toBe(400);
  });

  it('answers honestly on a deployment with no RPC', async () => {
    const { app } = await build({ rpc: null });
    const t = (await app.inject(`/v1/alerts/subject?address=${MINT}`)).json();
    expect(t.tokens[0]).toMatchObject({ isToken: null, insiders: null });
    expect(t.kind).toBe('unknown');
  });
});
