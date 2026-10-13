// Treasury read side and disclosure feed: the update format (sign, verify, tamper, anchor), the reporting clock, the indexer's log
// decoding, the attestation parser, and the routes over HTTP against a real Postgres schema. The database half needs
// DATABASE_URL (any Postgres 14+; each run uses and drops its own schema) and says so when it is skipped.
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { type Address, generateKeyPairSigner, none, some } from '@solana/kit';
import { TOKEN_2022_PROGRAM_ADDRESS, getTokenEncoder } from '@solana-program/token-2022';
import {
  ATTESTATION_LAPSED_EVENT_DISCRIMINATOR,
  TREASURY_PROGRAM_ADDRESS,
  TreasuryState,
  findTreasuryPda,
  findVaultPda,
  getAttestationLapsedEventEncoder,
  getLiquidationStartedEventEncoder,
  getRedeemedEventEncoder,
  getSpentEventEncoder,
  getTreasuryCreatedEventEncoder,
  getTreasuryEncoder,
} from '@opening-cross/treasury-client';
import { migrate } from '@opening-cross/indexer';
import { decodeTreasuryLogs, ingestTreasuryTransaction } from '../../indexer/src/treasury.js';
import { buildServer } from '../src/server.js';
import { parseAttestation, registerTreasury } from '../src/routes/treasury.js';
import {
  type MemoTx,
  type UpdateBody,
  MEMO_PROGRAM,
  UPDATE_SCHEMA,
  UpdateError,
  checkAnchor,
  disclosureState,
  memoTextOf,
  parseMemo,
  signUpdate,
  updateId,
  validateBody,
  verifyUpdate,
} from '../src/routes/treasury-updates.js';
import { mintAccount } from './helpers/mint.js';

const T = 'HoRbUkEXdJSFJFp3yZNgEmNJeniWPEheVUejPGZbVGAd';
const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
const dataLine = (b: Uint8Array) => `Program data: ${b64(b)}`;
const inProgram = (program: string, ...lines: string[]) => [`Program ${program} invoke [1]`, ...lines, `Program ${program} success`];

const bodyOf = (authority: string, over: Partial<UpdateBody> = {}): UpdateBody => ({
  schema: UPDATE_SCHEMA, cluster: 'devnet', treasury: 'TreasuryTreasuryTreasuryTreasuryTreasury1', authority, sequence: 1, previousId: null,
  issuedAt: 1_800_000_100, coveredFrom: 1_799_000_000, coveredTo: 1_800_000_000, title: 'Q3 report', summary: 'Spent on audits and hosting.', declaredSpentAtoms: '250000000', ...over,
});

describe('update format', () => {
  it('signs and verifies, and the id binds every field', async () => {
    const owner = await generateKeyPairSigner();
    const s = await signUpdate(bodyOf(owner.address), owner);
    expect(s.id).toMatch(/^[0-9a-f]{64}$/);
    expect(await verifyUpdate(s)).toEqual({ ok: true });
    for (const edit of [{ title: 'Q3 report!' }, { summary: 'x' }, { declaredSpentAtoms: '1' }, { coveredTo: 1_800_000_001 }, { sequence: 2, previousId: 'a'.repeat(64) }])
      expect(await verifyUpdate({ ...s, body: { ...s.body, ...edit } })).toEqual({ ok: false, reason: 'ID_MISMATCH' });
  });

  it('refuses a signature by another key, a forged signature and a signer that is not the named authority', async () => {
    const owner = await generateKeyPairSigner();
    const other = await generateKeyPairSigner();
    await expect(signUpdate(bodyOf(owner.address), other)).rejects.toThrow(UpdateError);
    const s = await signUpdate(bodyOf(owner.address), owner);
    const forged = (await signUpdate(bodyOf(other.address), other)).signature;
    expect(await verifyUpdate({ ...s, signature: forged })).toEqual({ ok: false, reason: 'BAD_SIGNATURE' });
    expect(await verifyUpdate({ ...s, signer: other.address })).toEqual({ ok: false, reason: 'WRONG_SIGNER' });
    expect(await verifyUpdate({ ...s, signature: 'zz' })).toEqual({ ok: false, reason: 'MALFORMED' });
  });

  it('rejects malformed bodies', async () => {
    const owner = await generateKeyPairSigner();
    const bad: Partial<UpdateBody>[] = [
      { schema: 'x' as never }, { sequence: 0 }, { sequence: 1.5 }, { previousId: 'a'.repeat(64) }, { sequence: 2, previousId: null }, { sequence: 2, previousId: 'ABC' },
      { coveredFrom: 5, coveredTo: 4 }, { coveredTo: 1_800_000_101 }, { title: '' }, { title: 'x'.repeat(121) }, { summary: ' ' }, { summary: 'x'.repeat(4001) },
      { declaredSpentAtoms: '-1' }, { declaredSpentAtoms: '1.5' }, { cluster: ' ' },
    ];
    for (const b of bad) expect(() => validateBody(bodyOf(owner.address, b)), JSON.stringify(b)).toThrow(UpdateError);
    expect(() => updateId(bodyOf(owner.address, { declaredSpentAtoms: null }))).not.toThrow();
  });

  it('round-trips the memo text and refuses look-alikes', () => {
    const id = 'ab'.repeat(32);
    const text = memoTextOf('9hCe4ejbMQuCiqSw5ocdAJF4KhzfpAYpQJDvVexyoYfV', 3, id);
    expect(parseMemo(text)).toEqual({ treasury: '9hCe4ejbMQuCiqSw5ocdAJF4KhzfpAYpQJDvVexyoYfV', sequence: 3, id });
    expect(parseMemo(`${text} `)).toBeNull();
    expect(parseMemo(text.replace('v1', 'v2'))).toBeNull();
    expect(parseMemo('opening-cross/promises/v1 root=' + id + ' n=1')).toBeNull();
  });
});

describe('anchor check', () => {
  const memo = 'opening-cross/treasury-update/v1 treasury=X seq=1 id=' + 'a'.repeat(64);
  const tx = (over: Partial<MemoTx> = {}, ix = [{ programId: MEMO_PROGRAM, parsed: memo }], keys = [{ pubkey: 'Auth', signer: true }]): MemoTx => ({
    slot: 10, blockTime: 1_800_000_050, meta: { err: null }, transaction: { message: { accountKeys: keys, instructions: ix } }, ...over,
  });

  it('accepts the exact memo signed by the authority and returns slot and time', () => {
    expect(checkAnchor(tx(), memo, 'Auth')).toEqual({ slot: 10, blockTime: 1_800_000_050 });
  });

  it('refuses a missing, failed, wrong-text, wrong-program or unsigned-by-authority transaction', () => {
    expect(() => checkAnchor(null, memo, 'Auth')).toThrow(/not found/);
    expect(() => checkAnchor(tx({ meta: { err: { InstructionError: [0, 'x'] } } }), memo, 'Auth')).toThrow(/failed/);
    expect(() => checkAnchor(tx({ blockTime: null }), memo, 'Auth')).toThrow(/block time/);
    expect(() => checkAnchor(tx({}, [{ programId: MEMO_PROGRAM, parsed: memo + 'x' }]), memo, 'Auth')).toThrow(/no Memo/);
    expect(() => checkAnchor(tx({}, [{ programId: 'Other', parsed: memo }]), memo, 'Auth')).toThrow(/no Memo/);
    expect(() => checkAnchor(tx({}, undefined, [{ pubkey: 'Auth', signer: false }, { pubkey: 'Mallory', signer: true }]), memo, 'Auth')).toThrow(/not signed by the treasury authority/);
  });
});

describe('reporting clock', () => {
  const base = { periodSecs: 1000, graceSecs: 200, liquidating: false, createdAt: 10_000, lastAnchoredAt: null, updateCount: 0 };
  const at = (now: number, over: Partial<Parameters<typeof disclosureState>[0]> = {}) => disclosureState({ ...base, now, ...over });

  it('is current until a period has run, requested for the grace, then overdue', () => {
    expect(at(10_999).state).toBe('current');
    expect(at(11_000)).toMatchObject({ state: 'requested', basis: 'creation', requestedAt: 11_000, overdueAt: 11_200 });
    expect(at(11_199).state).toBe('requested');
    expect(at(11_200).state).toBe('overdue');
  });

  it('restarts from the latest anchored update', () => {
    const d = at(11_500, { lastAnchoredAt: 11_400, updateCount: 2 });
    expect(d).toMatchObject({ state: 'current', basis: 'last-update', basisAt: 11_400, requestedAt: 12_400, updateCount: 2 });
  });

  it('is closed in liquidation and unknown without a creation time', () => {
    expect(at(99_999, { liquidating: true }).state).toBe('closed');
    expect(at(99_999, { createdAt: null }).state).toBe('unknown');
    expect(at(99_999, { createdAt: null, lastAnchoredAt: 50_000 }).state).toBe('overdue');
  });
});

describe('attestation parser', () => {
  const layout = (nonce: Uint8Array, cred: Uint8Array, schema: Uint8Array, data: Uint8Array, expiry: bigint) => {
    const out = new Uint8Array(1 + 96 + 4 + data.length + 32 + 8 + 32);
    out[0] = 2;
    out.set(nonce, 1);
    out.set(cred, 33);
    out.set(schema, 65);
    new DataView(out.buffer).setUint32(97, data.length, true);
    out.set(data, 101);
    new DataView(out.buffer).setBigInt64(101 + data.length + 32, expiry, true);
    return out;
  };
  const key = (n: number) => new Uint8Array(32).fill(n);

  it('reads expiry after variable-length data, as crates/sas-attestation does', () => {
    for (const data of [new Uint8Array(0), new Uint8Array([7, 7, 7]), new Uint8Array(200).fill(1)]) {
      const a = parseAttestation(layout(key(1), key(2), key(3), data, 1234n));
      expect(a?.expiry).toBe(1234n);
    }
  });

  it('refuses other accounts and truncation', () => {
    const ok = layout(key(1), key(2), key(3), new Uint8Array(2), 0n);
    expect(parseAttestation(ok.subarray(0, ok.length - 80))).toBeNull();
    const credential = ok.slice();
    credential[0] = 1;
    expect(parseAttestation(credential)).toBeNull();
    expect(parseAttestation(new Uint8Array(0))).toBeNull();
  });
});

describe('indexer log decoding', () => {
  const treasury = '9hCe4ejbMQuCiqSw5ocdAJF4KhzfpAYpQJDvVexyoYfV' as Address;
  const coin = 'So11111111111111111111111111111111111111112' as Address;
  const created = getTreasuryCreatedEventEncoder().encode({ treasury, coinMint: coin, authority: coin, allowance: 5n, periodSecs: 60n });
  const spent = getSpentEventEncoder().encode({ treasury, amount: 3n, to: coin, spentInPeriod: 3n });
  const lapsed = getAttestationLapsedEventEncoder().encode({ treasury, at: 99n });
  const liq = getLiquidationStartedEventEncoder().encode({ treasury, vault: 8n, supply: 9n });
  const redeemed = getRedeemedEventEncoder().encode({ treasury, holder: coin, burned: 2n, paid: 1n });

  it('decodes all five events in order from the treasury program', () => {
    const ev = decodeTreasuryLogs(inProgram(T, dataLine(created), dataLine(spent), dataLine(lapsed), dataLine(liq), dataLine(redeemed)));
    expect(ev.map((e) => e.name)).toEqual(['TreasuryCreated', 'Spent', 'AttestationLapsed', 'LiquidationStarted', 'Redeemed']);
    expect(ev[1]!.data).toMatchObject({ treasury, amount: 3n });
  });

  it('ignores the same bytes written by any other program, and events nested below another program', () => {
    expect(decodeTreasuryLogs(inProgram('11111111111111111111111111111111', dataLine(spent)))).toEqual([]);
    const nested = ['Program Other invoke [1]', `Program ${T} invoke [2]`, dataLine(spent), `Program ${T} success`, dataLine(lapsed), 'Program Other success'];
    expect(decodeTreasuryLogs(nested).map((e) => e.name)).toEqual(['Spent']);
  });

  it('refuses logs it cannot attribute and skips events it does not know', () => {
    expect(() => decodeTreasuryLogs([...inProgram(T, dataLine(spent)), 'Log truncated'])).toThrow(/truncated/);
    expect(() => decodeTreasuryLogs([`Program ${T} invoke [1]`, 'Program Other success'])).toThrow(/unbalanced/);
    expect(decodeTreasuryLogs(inProgram(T, dataLine(new Uint8Array(40).fill(9))))).toEqual([]);
    expect(Buffer.from(ATTESTATION_LAPSED_EVENT_DISCRIMINATOR).length).toBe(8);
  });
});

const url = process.env.DATABASE_URL;
if (!url) console.warn('treasury.test.ts (database half) SKIPPED: set DATABASE_URL to a Postgres to run the ingest and route tests against a real database');

describe.skipIf(!url)('treasury ingest and routes', () => {
  const schema = `t_${randomBytes(6).toString('hex')}`;
  const NOW = 1_800_000_000;
  let admin: pg.Client;
  let db: pg.Pool;
  let app: Awaited<ReturnType<typeof buildServer>>;
  const accounts = new Map<string, { data: Uint8Array; owner: Address }>();
  const memoTxs = new Map<string, MemoTx>();
  let owner: Awaited<ReturnType<typeof generateKeyPairSigner>>;
  let stranger: Awaited<ReturnType<typeof generateKeyPairSigner>>;
  let coin: Address;
  let treasury: Address;
  let lapsedCoin: Address;
  let lapsedTreasury: Address;
  let clock = NOW;
  const quoteMint = 'So11111111111111111111111111111111111111112' as Address;

  async function seed(coinMint: Address, o: { lapsedSince?: bigint; state?: TreasuryState; periodStart?: bigint } = {}) {
    const [t] = await findTreasuryPda({ coinMint });
    const [vault] = await findVaultPda({ treasury: t });
    accounts.set(t, {
      owner: TREASURY_PROGRAM_ADDRESS,
      data: new Uint8Array(
        getTreasuryEncoder().encode({
          authority: owner.address, coinMint, quoteMint, quoteDecimals: 6, allowance: 1_000_000_000n, periodSecs: 2_592_000n, periodStart: o.periodStart ?? BigInt(NOW - 100), spentInPeriod: 250_000_000n,
          credential: quoteMint, schema: quoteMint, graceSecs: 604_800n, lapsedSince: o.lapsedSince === undefined ? none() : some(o.lapsedSince), state: o.state ?? TreasuryState.Active, snapshotVault: 0n, snapshotSupply: 0n, bump: 255, vaultBump: 255,
        }),
      ),
    });
    accounts.set(coinMint, mintAccount(null, { decimals: 6 }));
    accounts.set(vault, {
      owner: TOKEN_2022_PROGRAM_ADDRESS,
      data: new Uint8Array(getTokenEncoder().encode({ mint: quoteMint, owner: t, amount: 5_000_000_000n, delegate: none(), state: 1, isNative: none(), delegatedAmount: 0n, closeAuthority: none(), extensions: none() } as never)).slice(0, 165),
    });
    return t;
  }
  const ingest = (signature: string, logs: string[], blockTime: number, slot: number) => ingestTreasuryTransaction(db, { signature, slot: BigInt(slot), blockTime: BigInt(blockTime), logs, err: null });

  async function post(address: string, update: unknown, memoSignature: string) {
    return app.inject({ method: 'POST', url: `/v1/treasuries/${address}/updates`, payload: { update, memoSignature } as never });
  }
  const sig = (n: number) => `Sig${'A'.repeat(70)}${String.fromCharCode(96 + n)}`;
  const memoFor = (treasuryAddr: string, update: { id: string; body: UpdateBody }, blockTime: number, signer = owner.address): MemoTx => ({
    slot: 777, blockTime, meta: { err: null },
    transaction: { message: { accountKeys: [{ pubkey: signer, signer: true }], instructions: [{ programId: MEMO_PROGRAM, parsed: memoTextOf(treasuryAddr, update.body.sequence, update.id) }] } },
  });

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    db = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
    await migrate(db);
    owner = await generateKeyPairSigner();
    stranger = await generateKeyPairSigner();
    coin = (await generateKeyPairSigner()).address;
    lapsedCoin = (await generateKeyPairSigner()).address;
    treasury = await seed(coin);
    lapsedTreasury = await seed(lapsedCoin, { lapsedSince: BigInt(NOW - 50) });
    app = await buildServer({ db, account: async (a) => accounts.get(a) ?? null, lifetime: async () => ({ blockhash: '1'.repeat(32), lastValidBlockHeight: 1n }) as never, clock: () => clock });
    registerTreasury(app, {
      db, account: async (a) => accounts.get(a) ?? null, clock: () => clock, network: 'devnet',
      memoTx: async (s) => memoTxs.get(s) ?? null, memoAttempts: 1, upgradeAuthority: async () => 'Upg11111111111111111111111111111111111111111',
    });
    // History for the first treasury: created 10 days before NOW, two spends.
    const coinKey = coin;
    const mk = (t: Address, c: Address) => getTreasuryCreatedEventEncoder().encode({ treasury: t, coinMint: c, authority: owner.address, allowance: 1_000_000_000n, periodSecs: 2_592_000n });
    await ingest('c1', inProgram(T, dataLine(mk(treasury, coinKey))), NOW - 864_000, 100);
    await ingest('s1', inProgram(T, dataLine(getSpentEventEncoder().encode({ treasury, amount: 100_000_000n, to: quoteMint, spentInPeriod: 100_000_000n }))), NOW - 700_000, 110);
    await ingest('s2', inProgram(T, dataLine(getSpentEventEncoder().encode({ treasury, amount: 150_000_000n, to: quoteMint, spentInPeriod: 250_000_000n }))), NOW - 600_000, 120);
    await ingest('c2', inProgram(T, dataLine(mk(lapsedTreasury, lapsedCoin))), NOW - 5_000_000, 90);
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  it('ingests once: replaying a signature changes nothing, a failed transaction changes nothing', async () => {
    expect(await ingest('s2', inProgram(T, dataLine(getSpentEventEncoder().encode({ treasury, amount: 150_000_000n, to: quoteMint, spentInPeriod: 250_000_000n }))), NOW - 600_000, 120)).toBe(0);
    expect(await ingestTreasuryTransaction(db, { signature: 'bad', slot: 1n, blockTime: 1n, logs: inProgram(T, dataLine(getAttestationLapsedEventEncoder().encode({ treasury, at: 1n }))), err: { InstructionError: [0, 'x'] } })).toBe(0);
    const { rows } = await db.query('SELECT spent_total, spend_count, lapse_count FROM treasuries WHERE address = $1', [treasury]);
    expect(rows[0]).toMatchObject({ spent_total: '250000000', spend_count: 2, lapse_count: 0 });
  });

  it('projects lapse, liquidation and redemption events', async () => {
    await ingest('l1', inProgram(T, dataLine(getAttestationLapsedEventEncoder().encode({ treasury: lapsedTreasury, at: BigInt(NOW - 50) }))), NOW - 50, 130);
    await ingest('l2', inProgram(T, dataLine(getLiquidationStartedEventEncoder().encode({ treasury: lapsedTreasury, vault: 8n, supply: 10n })), dataLine(getRedeemedEventEncoder().encode({ treasury: lapsedTreasury, holder: quoteMint, burned: 4n, paid: 3n }))), NOW - 10, 140);
    const { rows } = await db.query('SELECT * FROM treasuries WHERE address = $1', [lapsedTreasury]);
    expect(rows[0]).toMatchObject({ state: 'Liquidating', lapse_count: 1, last_lapse_at: String(NOW - 50), liquidation_vault: '8', liquidation_supply: '10', redeemed_burned: '4', redeemed_paid: '3', redemption_count: 1 });
  });

  it('GET /v1/treasuries lists indexed treasuries with live chain state', async () => {
    const res = await app.inject({ url: '/v1/treasuries' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.network).toBe('devnet');
    const t = body.treasuries.find((x: { address: string }) => x.address === treasury);
    expect(t).toMatchObject({ chain: 'read', state: 'Active', allowance: '1000000000', vaultBalance: '5000000000', spentTotal: '250000000', spendCount: 2, disclosure: { state: 'current', updateCount: 0 } });
    expect(t.spend).toMatchObject({ spentInPeriod: '250000000', allowanceRemaining: '750000000' });
    const lapsed = body.treasuries.find((x: { address: string }) => x.address === lapsedTreasury);
    expect(lapsed).toMatchObject({ indexedState: 'Liquidating', lapsedSince: String(NOW - 50) });
    expect((await app.inject({ url: '/v1/treasuries?state=Liquidating' })).json().treasuries.map((x: { address: string }) => x.address)).toEqual([lapsedTreasury]);
    expect((await app.inject({ url: '/v1/treasuries?state=Bogus' })).statusCode).toBe(400);
  });

  it('GET /v1/treasuries/:address reads terms, balances, events, rights and the clock', async () => {
    const res = await app.inject({ url: `/v1/treasuries/${treasury}` });
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b).toMatchObject({
      indexed: true, state: 'Active', address: treasury,
      terms: { authority: owner.address, allowance: '1000000000', periodSecs: '2592000', graceSecs: '604800' },
      balances: { vault: '5000000000', coinSupply: '1000', coinMintAuthority: null },
      spend: { allowanceRemaining: '750000000' },
      attestation: { exists: false, live: false },
      programUpgradeAuthority: 'Upg11111111111111111111111111111111111111111',
      history: { spendCount: 2, createdAt: NOW - 864_000 },
      disclosure: { state: 'current', basis: 'creation' },
    });
    expect(b.events.map((e: { name: string }) => e.name)).toEqual(['Spent', 'Spent', 'TreasuryCreated']);
    const ids = b.rights.map((c: { id: string }) => c.id);
    expect(ids).toContain('redeem-pro-rata');
    expect(b.rights.find((c: { id: string }) => c.id === 'spend-gate').now).toContain('no live attestation');
    expect(b.rights.find((c: { id: string }) => c.id === 'program-upgradeable').now).toContain('Upg1111');
  });

  it('answers 404 for an address that is not a treasury, an unfunded wallet and a look-alike account under another program; 400 for junk', async () => {
    const stray = (await generateKeyPairSigner()).address;
    accounts.set(stray, { owner: '11111111111111111111111111111111' as Address, data: accounts.get(treasury)!.data });
    for (const a of [stray, (await generateKeyPairSigner()).address]) expect((await app.inject({ url: `/v1/treasuries/${a}` })).statusCode).toBe(404);
    expect((await app.inject({ url: '/v1/treasuries/not-an-address' })).statusCode).toBe(400);
    expect((await app.inject({ url: '/v1/treasuries/not-an-address/updates' })).statusCode).toBe(400);
  });

  it('serves a treasury the indexer has not seen yet, from chain, and says so', async () => {
    const c = (await generateKeyPairSigner()).address;
    const t = await seed(c);
    const b = (await app.inject({ url: `/v1/treasuries/${t}` })).json();
    expect(b).toMatchObject({ indexed: false, history: null, disclosure: { state: 'unknown' }, events: [] });
  });

  it('shows a lapsed treasury\'s grace clock from the chain account', async () => {
    const b = (await app.inject({ url: `/v1/treasuries/${lapsedTreasury}` })).json();
    expect(b.lapse).toEqual({ lapsedSince: String(NOW - 50), graceEndsAt: String(NOW - 50 + 604_800) });
    expect(b.rights.find((c: { id: string }) => c.id === 'anyone-triggers-liquidation').now).toContain('grace period ends');
  });

  describe('updates', () => {
    it('stores the first update, chains the second, and compares the declared spend with the program\'s Spent events', async () => {
      const first = await signUpdate({ ...bodyOf(owner.address, { treasury, coveredFrom: NOW - 864_000, coveredTo: NOW - 100, issuedAt: NOW - 90, declaredSpentAtoms: '250000000' }) }, owner);
      memoTxs.set(sig(1), memoFor(treasury, first, NOW - 80));
      const r1 = await post(treasury, first, sig(1));
      expect(r1.statusCode).toBe(201);
      expect(r1.json().update).toMatchObject({ sequence: 1, id: first.id, anchor: { signature: sig(1), blockTime: NOW - 80 }, spendCheck: { declaredSpentAtoms: '250000000', spentOnChainAtoms: '250000000', matches: true } });

      const second = await signUpdate({ ...bodyOf(owner.address, { treasury, sequence: 2, previousId: first.id, coveredFrom: NOW - 99, coveredTo: NOW - 60, issuedAt: NOW - 50, declaredSpentAtoms: '999' }) }, owner);
      memoTxs.set(sig(2), memoFor(treasury, second, NOW - 40));
      const r2 = await post(treasury, second, sig(2));
      expect(r2.statusCode).toBe(201);
      expect(r2.json().update.spendCheck).toMatchObject({ declaredSpentAtoms: '999', spentOnChainAtoms: '0', matches: false });

      const list = (await app.inject({ url: `/v1/treasuries/${treasury}/updates` })).json();
      expect(list.updates.map((u: { sequence: number }) => u.sequence)).toEqual([2, 1]);
      const detail = (await app.inject({ url: `/v1/treasuries/${treasury}` })).json();
      expect(detail.disclosure).toMatchObject({ state: 'current', basis: 'last-update', basisAt: NOW - 40, updateCount: 2 });
    });

    it('treats a repost of a stored update as a no-op', async () => {
      const list = (await app.inject({ url: `/v1/treasuries/${treasury}/updates` })).json();
      const stored = list.updates.find((u: { sequence: number }) => u.sequence === 1);
      const r = await post(treasury, { id: stored.id, body: stored.body, signer: stored.signer, signature: stored.signature }, stored.anchor.signature);
      expect(r.statusCode).toBe(200);
      expect(r.json().duplicate).toBe(true);
    });

    it('refuses the wrong sequence, a forked chain, a stranger, a tampered body, a wrong treasury and a wrong cluster', async () => {
      const mk = async (over: Partial<UpdateBody>, signer = owner) => signUpdate(bodyOf(signer.address, { treasury, issuedAt: NOW - 5, coveredTo: NOW - 6, coveredFrom: NOW - 7, ...over }), signer);
      const list = (await app.inject({ url: `/v1/treasuries/${treasury}/updates` })).json();
      const head = list.updates[0];

      const skipped = await mk({ sequence: 4, previousId: head.id });
      memoTxs.set(sig(3), memoFor(treasury, skipped, NOW - 4));
      expect((await post(treasury, skipped, sig(3))).statusCode).toBe(409);

      const forked = await mk({ sequence: 3, previousId: 'f'.repeat(64) });
      memoTxs.set(sig(4), memoFor(treasury, forked, NOW - 4));
      expect((await post(treasury, forked, sig(4))).statusCode).toBe(409);

      const byStranger = await mk({ sequence: 3, previousId: head.id, authority: stranger.address }, stranger);
      memoTxs.set(sig(5), memoFor(treasury, byStranger, NOW - 4, stranger.address));
      const rs = await post(treasury, byStranger, sig(5));
      expect(rs.statusCode).toBe(422);
      expect(rs.json().error).toContain('not this treasury');

      const good = await mk({ sequence: 3, previousId: head.id });
      memoTxs.set(sig(6), memoFor(treasury, good, NOW - 4));
      const tampered = { ...good, body: { ...good.body, summary: 'Spent nothing at all.' } };
      expect((await post(treasury, tampered, sig(6))).statusCode).toBe(400);

      expect((await post(lapsedTreasury, good, sig(6))).statusCode).toBe(400);
      const otherCluster = await mk({ sequence: 3, previousId: head.id, cluster: 'mainnet-beta' });
      memoTxs.set(sig(7), memoFor(treasury, otherCluster, NOW - 4));
      expect((await post(treasury, otherCluster, sig(7))).statusCode).toBe(400);
    });

    it('refuses an anchor that is missing, signed by someone else, carries other text, or predates the update', async () => {
      const head = (await app.inject({ url: `/v1/treasuries/${treasury}/updates` })).json().updates[0];
      const u = await signUpdate(bodyOf(owner.address, { treasury, sequence: 3, previousId: head.id, issuedAt: NOW - 5, coveredTo: NOW - 6, coveredFrom: NOW - 7 }), owner);

      expect((await post(treasury, u, sig(8))).statusCode).toBe(422); // no such transaction (after the retries)

      memoTxs.set(sig(9), memoFor(treasury, u, NOW - 4, stranger.address));
      expect((await post(treasury, u, sig(9))).statusCode).toBe(422);

      const wrongText = memoFor(treasury, u, NOW - 4);
      wrongText.transaction.message.instructions[0]!.parsed = memoTextOf(treasury, 3, 'e'.repeat(64));
      memoTxs.set(sig(10), wrongText);
      expect((await post(treasury, u, sig(10))).statusCode).toBe(422);

      memoTxs.set(sig(11), memoFor(treasury, u, NOW - 5 - 121 - 100)); // anchored long before it claims to have been signed
      const early = await post(treasury, u, sig(11));
      expect(early.statusCode).toBe(422);
      expect(early.json().error).toContain('claims to be signed after');
      expect((await app.inject({ url: `/v1/treasuries/${treasury}/updates` })).json().updates).toHaveLength(2);
    });

    it('rejects junk bodies', async () => {
      for (const payload of [{}, { update: 'x', memoSignature: sig(1) }, { update: {}, memoSignature: 'short' }])
        expect((await app.inject({ method: 'POST', url: `/v1/treasuries/${treasury}/updates`, payload: payload as never })).statusCode).toBe(400);
      expect((await app.inject({ method: 'POST', url: `/v1/treasuries/${treasury}/updates` })).statusCode).toBe(400);
    });

    it('moves a treasury from current to requested to overdue as time passes with no new update', async () => {
      const at = async () => (await app.inject({ url: `/v1/treasuries/${treasury}` })).json().disclosure;
      try {
        clock = NOW - 40 + 2_592_000;
        expect((await at()).state).toBe('requested');
        clock = NOW - 40 + 2_592_000 + 604_800;
        expect((await at()).state).toBe('overdue');
        expect((await app.inject({ url: '/v1/treasuries' })).json().treasuries.find((x: { address: string }) => x.address === treasury).disclosure.state).toBe('overdue');
      } finally {
        clock = NOW;
      }
    });
  });
});
