// The Alpha Vault, Met Lock and Dynamic Fee Sharing routes, over HTTP with accounts injected in memory. The account decoders are run on real accounts
// read from Solana devnet (test/fixtures/meteora-devnet.json); the routes' accounts are those same bytes with the fields a case needs overwritten.
// Every transaction is decoded back to instructions. The programs are not run here: Meteora's binaries run in tests/core (LiteSVM).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import Fastify from 'fastify';
import { beforeAll, describe, expect, it } from 'vitest';
import { type Address, type Instruction, decompileTransactionMessage, generateKeyPairSigner, getAddressEncoder, getCompiledTransactionMessageDecoder, getTransactionDecoder, none, some } from '@solana/kit';
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import { CROSS_BODY_LEN, CROSS_CORE_PROGRAM_ADDRESS, CrossKind, CrossState, Disclosure, SupplyMode, ata, crossAddress, getCrossEncoder } from '@opening-cross/sdk';
import {
  ALPHA_VAULT_PROGRAM_ADDRESS,
  DAMM_V2_PROGRAM_ADDRESS,
  DYNAMIC_FEE_SHARING_PROGRAM_ADDRESS,
  MET_LOCK_PROGRAM_ADDRESS,
  alphaEscrowAddress,
  alphaVaultAddresses,
  dammAddresses,
  feeShareAddresses,
  metLockAddresses,
} from '@opening-cross/adapters';
import { RequestError } from '../src/tx.js';
import { decodeAlphaVault, decodeFeeVault, decodeVestingEscrow, hasActiveTransferHook, registerMeteoraTx } from '../src/routes/meteora-tx.js';

const NOW = 1_800_000_000;
const BLOCKHASH = '4NCYB3kRT8sCNodPNuCZo8VkwveZSHhg7R7mrRBFM1Uy' as never;
const ZERO = '11111111111111111111111111111111' as Address;
const LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111' as Address;
const T22 = TOKEN_2022_PROGRAM_ADDRESS;
const SPL = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' as Address;
const key = async () => (await generateKeyPairSigner()).address;
type Account = { data: Uint8Array; owner: Address };
const enc = getAddressEncoder();
const disc = (name: string) => Uint8Array.from(createHash('sha256').update(`global:${name}`).digest().subarray(0, 8));

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/meteora-devnet.json', import.meta.url), 'utf8')).accounts as Record<string, { address: string; owner: string; data: string }>;
const real = (name: string) => Uint8Array.from(Buffer.from(fixtures[name]!.data, 'base64'));

const putKey = (d: Uint8Array, at: number, a: Address) => d.set(enc.encode(a), at);
const putU64 = (d: Uint8Array, at: number, v: bigint) => new DataView(d.buffer, d.byteOffset).setBigUint64(at, v, true);

describe('the account decoders, on real devnet accounts', () => {
  it('Dynamic Fee Sharing vault', () => {
    const v = decodeFeeVault(real('feeVault'))!;
    expect(v.tokenVault).toBe('8dTkW2VseSDHtyyxFGcbqAeaVnea7AG8aayzg8iAmo5f'); // docs/evidence/D7-fee-sharing-vault-devnet.md
    expect(v.totalShare).toBe(10_000);
    expect(v.totalFundedFee).toBe(492_631n);
    expect(v.users.map((u) => [u.share, u.feeClaimed])).toEqual([[5000, 246_315n], [5000, 246_315n]]);
    expect(feeShareAddresses(v.base, v.tokenMint).feeVault).toBe(fixtures.feeVault!.address);
  });
  it('Alpha Vault, pro-rata and first-come, whose address derives from the fields read', () => {
    const p = decodeAlphaVault(real('alphaVaultProrata'))!;
    expect(p.vaultMode).toBe(0);
    expect(p.maxBuyingCap).toBe(250_000_000n);
    expect(alphaVaultAddresses(p.base, p.pool).vault).toBe(fixtures.alphaVaultProrata!.address);
    const f = decodeAlphaVault(real('alphaVaultFcfs'))!;
    expect(f.vaultMode).toBe(1);
    expect(f.maxDepositingCap).toBe(10_000_000_000n);
    expect(alphaVaultAddresses(f.base, f.pool).vault).toBe(fixtures.alphaVaultFcfs!.address);
  });
  it('Met Lock escrow, on SPL Token and Token-2022', () => {
    const t = decodeVestingEscrow(real('escrowToken2022'))!;
    expect(t.tokenProgramFlag).toBe(1);
    expect(metLockAddresses(t.base, t.tokenMint, T22).escrow).toBe(fixtures.escrowToken2022!.address);
    const s = decodeVestingEscrow(real('escrowSpl'))!;
    expect(s.tokenProgramFlag).toBe(0);
    expect(s.amountPerPeriod).toBe(1_000_000n);
    expect(metLockAddresses(s.base, s.tokenMint, SPL).escrow).toBe(fixtures.escrowSpl!.address);
  });
  it('refuse bytes that are not their account', () => {
    expect(decodeFeeVault(real('alphaVaultProrata'))).toBeNull();
    expect(decodeAlphaVault(real('feeVault'))).toBeNull();
    expect(decodeVestingEscrow(new Uint8Array(500))).toBeNull();
    expect(decodeAlphaVault(real('alphaVaultProrata').subarray(0, 100))).toBeNull();
  });
  it('a transfer hook is found in a Token-2022 mint only when its program id is set', () => {
    const mint = (programId: Uint8Array | null) => {
      const d = new Uint8Array(166 + (programId ? 4 + 64 : 0));
      d[165] = 1;
      if (programId) {
        new DataView(d.buffer).setUint16(166, 14, true);
        new DataView(d.buffer).setUint16(168, 64, true);
        d.set(programId, 166 + 4 + 32);
      }
      return d;
    };
    expect(hasActiveTransferHook(mint(null))).toBe(false);
    expect(hasActiveTransferHook(mint(new Uint8Array(32)))).toBe(false);
    expect(hasActiveTransferHook(mint(new Uint8Array(32).fill(7)))).toBe(true);
    expect(hasActiveTransferHook(new Uint8Array(82))).toBe(false); // a plain SPL mint
  });
});

describe('Meteora routes over HTTP', () => {
  const accounts = new Map<string, Account>();
  let app: ReturnType<typeof Fastify>;
  let creator: Address, stranger: Address, base: Address, quote: Address, other: Address, fees: Address, integrator: Address, fresh: Address, recipientB: Address, hookMint: Address;
  let bound: Address, live: Address;

  const post = async (url: string, payload: unknown) => {
    const r = await app.inject({ method: 'POST', url, payload: payload as never });
    return { status: r.statusCode, body: JSON.parse(r.body) };
  };
  const get = async (url: string) => {
    const r = await app.inject({ method: 'GET', url });
    return { status: r.statusCode, body: JSON.parse(r.body) };
  };
  const decode = (tx: string): Instruction[] => {
    const decoded = getTransactionDecoder().decode(Uint8Array.from(Buffer.from(tx, 'base64')));
    return decompileTransactionMessage(getCompiledTransactionMessageDecoder().decode(decoded.messageBytes)).instructions as Instruction[];
  };
  const of = (ixs: Instruction[], program: Address) => ixs.filter((i) => i.programAddress === program);
  const starts = (ix: Instruction, d: Uint8Array) => d.every((b, i) => ix.data![i] === b);

  async function putCross(id: bigint, o: { state: CrossState; cleared?: boolean; bound?: boolean }): Promise<Address> {
    const address = await crossAddress(creator, id);
    const body = getCrossEncoder().encode({
      creator, crossId: id, kind: CrossKind.Launch, supplyMode: SupplyMode.DeferredMint, disclosure: Disclosure.Open, state: o.state,
      baseMint: base, quoteMint: quote, baseTokenProgram: T22, quoteTokenProgram: T22, baseDecimals: 6, quoteDecimals: 6, proceedsTo: creator,
      minPrice: 1_000_000n, tick: 100_000n, ticks: 20, priceScale: 1_000_000n, openTs: 1n, closeTs: 2n, revealEndTs: 3n, referencePrice: none(), minMatched: 0n, maxImbalanceBps: none(),
      protocolFeeBps: 30, integratorFeeBps: 20, integrator, feeRecipient: fees, gateMint: none(), shards: 2, maxOrders: 64, dustBond: 0n, ordersTotal: 0, ordersOpen: 0, mergedMask: 3,
      clearing: o.cleared === false ? none() : some({ price: 1_300_000n, matched: 1_000_000_000n, demand: 1_000_000_000n, supply: 1_000_000_000n, rationed: 0, marginalQuantity: 0n, marginalRemaining: 0n, marginalOrders: 0 }),
      noPrintReason: none(), buyerPaid: 2_600_000_000n, baseBought: 0n, baseSold: 0n, sellerPaid: 0n, feesAccrued: 0n, oracle: none(), calendar: none(), settler: none(),
      settleDeadlineTs: 0n, baseBound: o.bound ?? o.cleared !== false, bump: 1, quoteVaultBump: 1, baseVaultBump: 1, bookBump: 1,
    } as never);
    const data = new Uint8Array(CROSS_BODY_LEN);
    data.set(body);
    accounts.set(address, { owner: CROSS_CORE_PROGRAM_ADDRESS, data });
    return address;
  }
  const tokenAccount = (owner: Address, mint: Address, amount: bigint, program = T22): Account => {
    const data = new Uint8Array(165);
    putKey(data, 0, mint);
    putKey(data, 32, owner);
    putU64(data, 64, amount);
    return { data, owner: program };
  };
  const mintAccount = (program: Address, hook = false): Account => {
    const data = new Uint8Array(hook ? 166 + 4 + 64 : 82);
    if (hook) {
      data[165] = 1;
      new DataView(data.buffer).setUint16(166, 14, true);
      new DataView(data.buffer).setUint16(168, 64, true);
      data.fill(9, 166 + 4 + 32, 166 + 4 + 64);
    }
    return { data, owner: program };
  };
  const fund = async (who: Address, mint: Address, amount: bigint, program = T22) => accounts.set(await ata(who, mint, program), tokenAccount(who, mint, amount, program));

  /** The real vault bytes with the fields a case needs set. */
  const alphaVault = async (o: { cross: Address; deposit?: bigint; swapped?: bigint; bought?: bigint; refund?: bigint; cap?: bigint; maxDepositing?: bigint; start?: bigint; mode?: number }) => {
    const a = await dammAddresses(o.cross, base, quote);
    const { vault } = alphaVaultAddresses(creator, a.pool);
    const d = real('alphaVaultProrata').slice();
    const at = 8;
    putKey(d, at, a.pool);
    putKey(d, at + 32, await ata(vault, quote, T22));
    putKey(d, at + 64, await ata(vault, base, T22));
    putKey(d, at + 96, quote);
    putKey(d, at + 128, base);
    putKey(d, at + 160, creator);
    putU64(d, at + 224, o.cap ?? 0n);
    putU64(d, at + 232, o.deposit ?? 0n);
    putU64(d, at + 248, o.swapped ?? 0n);
    putU64(d, at + 256, o.bought ?? 0n);
    putU64(d, at + 264, o.refund ?? 0n);
    putU64(d, at + 280, o.start ?? BigInt(NOW - 100));
    d[at + 298] = o.mode ?? 0;
    putU64(d, at + 304, o.maxDepositing ?? 0n);
    d[at + 345] = 1;
    accounts.set(vault, { data: d, owner: ALPHA_VAULT_PROGRAM_ADDRESS });
    return { vault, pool: a.pool, state: decodeAlphaVault(d)! };
  };

  const feeVault = async (o: { mint?: Address; users: { address: Address; share: number }[] }) => {
    const d = real('feeVault').slice();
    const a = feeShareAddresses(fresh, o.mint ?? quote);
    putKey(d, 8 + 32, o.mint ?? quote);
    putKey(d, 8 + 64, a.tokenVault);
    putKey(d, 8 + 144, fresh);
    for (let i = 0; i < 5; i++) {
      const at = 8 + 240 + i * 80;
      d.fill(0, at, at + 80);
      const u = o.users[i];
      if (u) {
        putKey(d, at, u.address);
        new DataView(d.buffer).setUint32(at + 32, u.share, true);
      }
    }
    new DataView(d.buffer).setUint32(8 + 112, o.users.reduce((n, u) => n + u.share, 0), true);
    accounts.set(a.feeVault, { data: d, owner: DYNAMIC_FEE_SHARING_PROGRAM_ADDRESS });
    return a;
  };

  beforeAll(async () => {
    [creator, stranger, base, quote, other, fees, integrator, fresh, recipientB, hookMint] = await Promise.all(Array.from({ length: 10 }, key));
    bound = await putCross(1n, { state: CrossState.Cleared });
    live = await putCross(2n, { state: CrossState.Live, cleared: false });
    for (const p of [ALPHA_VAULT_PROGRAM_ADDRESS, DAMM_V2_PROGRAM_ADDRESS, DYNAMIC_FEE_SHARING_PROGRAM_ADDRESS, MET_LOCK_PROGRAM_ADDRESS]) accounts.set(p, { data: new Uint8Array(36), owner: LOADER });
    accounts.set(quote, mintAccount(T22));
    accounts.set(base, mintAccount(T22));
    accounts.set(other, mintAccount(SPL));
    accounts.set(hookMint, mintAccount(T22, true));
    app = Fastify({ logger: false });
    app.setErrorHandler((err, _req, reply) => {
      if (err instanceof RequestError) return reply.code(err.status).type('application/json').send(JSON.stringify({ error: err.message, ...err.detail }, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)));
      return reply.code(500).send({ error: String(err) });
    });
    registerMeteoraTx(app, { account: async (a) => accounts.get(a) ?? null, lifetime: async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 100n }), clock: () => NOW });
  }, 60_000);

  // ------------------------------------------------------------------------------------------------------------------------------ Alpha Vault
  describe('Alpha Vault', () => {
    const init = (over: Record<string, unknown> = {}) => ({ cross: bound, mode: 'prorata', maxBuyingCap: '500000000', startVestingPoint: String(NOW + 3600), endVestingPoint: String(NOW + 7200), ...over });
    const dammPool = async () => (await dammAddresses(bound, base, quote)).pool;

    it('read: a cross that did not print a price has no market, and the read says so with a 200 instead of an error', async () => {
      const noPrint = await putCross(9n, { state: CrossState.NoPrint, cleared: false, bound: true });
      const r = await get(`/v1/crosses/${noPrint}/alpha-vault`);
      expect(r.status).toBe(200);
      expect(r.body.vault).toBeNull();
      expect(r.body.note).toMatch(/no market/);
    });

    it('create: needs the DAMM v2 pool first, builds the two token accounts and the vault, and the creator signs as base', async () => {
      const r0 = await post('/v1/tx/alpha-vault-init', init());
      expect(r0.status).toBe(409);
      expect(r0.body.reason).toBe('NO_POOL');
      accounts.set(await dammPool(), { data: new Uint8Array(8), owner: DAMM_V2_PROGRAM_ADDRESS });
      const r = await post('/v1/tx/alpha-vault-init', init());
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const a = alphaVaultAddresses(creator, await dammPool());
      expect(r.body.vault).toBe(a.vault);
      const ixs = decode(r.body.transaction);
      const alpha = of(ixs, ALPHA_VAULT_PROGRAM_ADDRESS);
      expect(alpha).toHaveLength(1);
      expect(starts(alpha[0]!, disc('initialize_prorata_vault'))).toBe(true);
      expect(r.body.signers).toEqual([creator]);
      expect(r.body.bytes).toBeLessThanOrEqual(1232);
      // a separate funder pays; the creator still signs
      const sep = await post('/v1/tx/alpha-vault-init', init({ mode: 'fcfs', maxBuyingCap: undefined, maxDepositingCap: '9000000000', individualDepositingCap: '1000000000', funder: stranger }));
      expect(sep.status, JSON.stringify(sep.body)).toBe(200);
      expect(starts(of(decode(sep.body.transaction), ALPHA_VAULT_PROGRAM_ADDRESS)[0]!, disc('initialize_fcfs_vault'))).toBe(true);
      expect(sep.body.signers).toEqual(expect.arrayContaining([creator, stranger]));
    });

    it('create: refuses the vault that exists, the wrong caps for the mode, vesting that ends before it starts, and a cross without a market', async () => {
      await alphaVault({ cross: bound });
      expect((await post('/v1/tx/alpha-vault-init', init())).body.reason).toBe('VAULT_EXISTS');
      accounts.delete(alphaVaultAddresses(creator, await dammPool()).vault);
      expect((await post('/v1/tx/alpha-vault-init', init({ maxDepositingCap: '1' }))).status).toBe(400);
      expect((await post('/v1/tx/alpha-vault-init', init({ mode: 'fcfs', maxBuyingCap: '1' }))).status).toBe(400);
      expect((await post('/v1/tx/alpha-vault-init', init({ mode: 'fcfs', maxBuyingCap: undefined }))).status).toBe(400);
      expect((await post('/v1/tx/alpha-vault-init', init({ mode: 'weighted' }))).status).toBe(400);
      expect((await post('/v1/tx/alpha-vault-init', init({ startVestingPoint: String(NOW + 9000) }))).body.reason).toBe('VESTING_ORDER');
      expect((await post('/v1/tx/alpha-vault-init', init({ cross: live }))).body.reason).toBe('LIVE');
      expect((await post('/v1/tx/alpha-vault-init', init({ whitelistMode: 3 }))).status).toBe(400);
    });

    it('deposit: opens the escrow on a first deposit only, checks the cap and the balance', async () => {
      const none = await post('/v1/tx/alpha-vault-deposit', { cross: bound, owner: stranger, amount: '1000' });
      expect(none.body.reason).toBe('NO_ALPHA_VAULT');
      const { vault } = await alphaVault({ cross: bound, mode: 1, maxDepositing: 5_000n, deposit: 4_000n });
      await fund(stranger, quote, 10_000n);
      const first = await post('/v1/tx/alpha-vault-deposit', { cross: bound, owner: stranger, amount: '1000' });
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      const alpha = of(decode(first.body.transaction), ALPHA_VAULT_PROGRAM_ADDRESS);
      expect(alpha.map((i) => starts(i, disc('create_new_escrow')) ? 'escrow' : starts(i, disc('deposit')) ? 'deposit' : '?')).toEqual(['escrow', 'deposit']);
      expect(first.body.opensEscrow).toBe(true);
      accounts.set(alphaEscrowAddress(vault, stranger), { data: new Uint8Array(100), owner: ALPHA_VAULT_PROGRAM_ADDRESS });
      const again = await post('/v1/tx/alpha-vault-deposit', { cross: bound, owner: stranger, amount: '500' });
      expect(of(decode(again.body.transaction), ALPHA_VAULT_PROGRAM_ADDRESS)).toHaveLength(1);
      expect(again.body.opensEscrow).toBe(false);
      const over = await post('/v1/tx/alpha-vault-deposit', { cross: bound, owner: stranger, amount: '1001' });
      expect(over.status).toBe(422);
      expect(over.body.reason).toBe('OVER_CAP');
      expect(over.body.room).toBe('1000');
      await alphaVault({ cross: bound, cap: 1_000_000n, deposit: 0n });
      expect((await post('/v1/tx/alpha-vault-deposit', { cross: bound, owner: stranger, amount: '10001' })).body.reason).toBe('INSUFFICIENT_QUOTE');
      expect((await post('/v1/tx/alpha-vault-deposit', { cross: bound, owner: creator, amount: '1' })).body.reason).toBe('NO_QUOTE_ACCOUNT');
      expect((await post('/v1/tx/alpha-vault-deposit', { cross: bound, owner: stranger, amount: '0' })).status).toBe(400);
    });

    it('fill: spends at most what is deposited and not yet spent, capped by a pro-rata vault\'s buying cap', async () => {
      await alphaVault({ cross: bound, cap: 1_000n, deposit: 5_000n });
      const r = await post('/v1/tx/alpha-vault-fill', { cross: bound, cranker: stranger });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.maxAmount).toBe('1000'); // the buying cap, not the 5,000 deposited
      const ix = of(decode(r.body.transaction), ALPHA_VAULT_PROGRAM_ADDRESS)[0]!;
      expect(starts(ix, disc('fill_damm_v2'))).toBe(true);
      expect((await post('/v1/tx/alpha-vault-fill', { cross: bound, cranker: stranger, maxAmount: '1001' })).body.reason).toBe('OVER_FILL');
      expect((await post('/v1/tx/alpha-vault-fill', { cross: bound, cranker: stranger, maxAmount: '400' })).body.maxAmount).toBe('400');
      await alphaVault({ cross: bound, cap: 1_000n, deposit: 5_000n, swapped: 1_000n });
      expect((await post('/v1/tx/alpha-vault-fill', { cross: bound, cranker: stranger })).body.reason).toBe('NOTHING_TO_FILL');
      await alphaVault({ cross: bound, deposit: 0n });
      expect((await post('/v1/tx/alpha-vault-fill', { cross: bound, cranker: stranger })).body.reason).toBe('NOTHING_TO_FILL');
    });

    it('claim: needs an escrow, a fill, and the vesting start', async () => {
      const { vault } = await alphaVault({ cross: bound, bought: 0n });
      accounts.delete(alphaEscrowAddress(vault, stranger));
      expect((await post('/v1/tx/alpha-vault-claim', { cross: bound, owner: stranger })).body.reason).toBe('NO_ESCROW');
      accounts.set(alphaEscrowAddress(vault, stranger), { data: new Uint8Array(100), owner: ALPHA_VAULT_PROGRAM_ADDRESS });
      expect((await post('/v1/tx/alpha-vault-claim', { cross: bound, owner: stranger })).body.reason).toBe('NOTHING_BOUGHT');
      await alphaVault({ cross: bound, bought: 10n, start: BigInt(NOW + 50) });
      const early = await post('/v1/tx/alpha-vault-claim', { cross: bound, owner: stranger });
      expect(early.body.reason).toBe('NOT_VESTING_YET');
      expect(early.body.startVestingPoint).toBe(String(NOW + 50));
      await alphaVault({ cross: bound, bought: 10n });
      const ok = await post('/v1/tx/alpha-vault-claim', { cross: bound, owner: stranger });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(starts(of(decode(ok.body.transaction), ALPHA_VAULT_PROGRAM_ADDRESS)[0]!, disc('claim_token'))).toBe(true);
    });

    it('withdraw-remaining: only after a fill that left a refund', async () => {
      const { vault } = await alphaVault({ cross: bound, swapped: 0n });
      accounts.set(alphaEscrowAddress(vault, stranger), { data: new Uint8Array(100), owner: ALPHA_VAULT_PROGRAM_ADDRESS });
      expect((await post('/v1/tx/alpha-vault-withdraw-remaining', { cross: bound, owner: stranger })).body.reason).toBe('NOTHING_TO_WITHDRAW');
      await alphaVault({ cross: bound, swapped: 100n, refund: 0n });
      expect((await post('/v1/tx/alpha-vault-withdraw-remaining', { cross: bound, owner: stranger })).body.reason).toBe('NOTHING_TO_WITHDRAW');
      await alphaVault({ cross: bound, swapped: 100n, refund: 40n });
      const ok = await post('/v1/tx/alpha-vault-withdraw-remaining', { cross: bound, owner: stranger });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(starts(of(decode(ok.body.transaction), ALPHA_VAULT_PROGRAM_ADDRESS)[0]!, disc('withdraw_remaining_quote'))).toBe(true);
      expect(ok.body.totalRefund).toBe('40');
    });

    it('GET reads the vault, the mode, and an owner\'s escrow', async () => {
      const { vault } = await alphaVault({ cross: bound, mode: 1, maxDepositing: 77n });
      const r = await get(`/v1/crosses/${bound}/alpha-vault?owner=${stranger}`);
      expect(r.status).toBe(200);
      expect(r.body.vault).toBe(vault);
      expect(r.body.mode).toBe('fcfs');
      expect(r.body.state.maxDepositingCap).toBe('77');
      expect(r.body.hasEscrow).toBe(true);
      expect((await get(`/v1/crosses/${live}/alpha-vault`)).body.vault).toBeNull();
      accounts.delete(vault);
      const none = await get(`/v1/crosses/${bound}/alpha-vault`);
      expect(none.body.state).toBeNull();
      expect((await get(`/v1/crosses/${bound}/alpha-vault?owner=x`)).status).toBe(400);
    });
  });

  // ------------------------------------------------------------------------------------------------------------------------------ Met Lock
  describe('Met Lock', () => {
    const create = (over: Record<string, unknown> = {}) => ({ sender: creator, base: fresh, mint: other, recipient: stranger, schedule: { total: '1200', start: String(NOW), cliffSeconds: '100', frequency: '60', periods: '12', cliffUnlockBps: 0 }, ...over });

    it('creates the escrow, funds it with exactly the schedule, and both the sender and the fresh base sign', async () => {
      await fund(creator, other, 5_000n, SPL);
      const r = await post('/v1/tx/metlock-create', create());
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.escrow).toBe(metLockAddresses(fresh, other, SPL).escrow);
      expect(r.body.locked).toBe('1200');
      expect(r.body.schedule.numberOfPeriod).toBe('12');
      expect(r.body.endsAt).toBe(String(NOW + 100 + 60 * 12));
      expect(r.body.signers).toEqual(expect.arrayContaining([creator, fresh]));
      const ix = of(decode(r.body.transaction), MET_LOCK_PROGRAM_ADDRESS)[0]!;
      expect(starts(ix, disc('create_vesting_escrow_v2'))).toBe(true);
      expect(r.body.bytes).toBeLessThanOrEqual(1232);
    });

    it('refuses a mint with a transfer hook, a used base, too little token, a bad schedule and bad modes', async () => {
      await fund(creator, hookMint, 5_000n);
      const hook = await post('/v1/tx/metlock-create', create({ mint: hookMint }));
      expect(hook.status).toBe(422);
      expect(hook.body.reason).toBe('MINT_HAS_TRANSFER_HOOK');
      expect((await post('/v1/tx/metlock-create', create({ base: creator }))).status).toBe(400);
      expect((await post('/v1/tx/metlock-create', create({ schedule: { ...create().schedule, total: '9000' } }))).body.reason).toBe('INSUFFICIENT_TOKEN');
      expect((await post('/v1/tx/metlock-create', create({ schedule: { ...create().schedule, frequency: '0' } }))).body.reason).toBe('SCHEDULE_INVALID');
      expect((await post('/v1/tx/metlock-create', create({ schedule: { ...create().schedule, cliffUnlockBps: 10_001 } }))).status).toBe(400);
      expect((await post('/v1/tx/metlock-create', create({ cancelMode: 4 }))).status).toBe(400);
      expect((await post('/v1/tx/metlock-create', create({ mint: fresh }))).body.reason).toBe('MINT_NOT_FOUND');
      accounts.set(metLockAddresses(fresh, other, SPL).escrow, { data: new Uint8Array(8), owner: MET_LOCK_PROGRAM_ADDRESS });
      expect((await post('/v1/tx/metlock-create', create())).body.reason).toBe('ESCROW_EXISTS');
      accounts.delete(metLockAddresses(fresh, other, SPL).escrow);
    });

    it('splits a total with no remainder: the sum locked is the sum asked', async () => {
      const r = await post('/v1/tx/metlock-create', create({ schedule: { total: '1001', start: String(NOW), cliffSeconds: '0', frequency: '10', periods: '7', cliffUnlockBps: 1000 } }));
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.locked).toBe('1001');
    });

    it('claim: only the recipient, only what has vested', async () => {
      const escrowAddress = fixtures.escrowSpl!.address as Address;
      const state = decodeVestingEscrow(real('escrowSpl'))!;
      const e = real('escrowSpl').slice();
      // a schedule of 4 steps of 250 from NOW - 90, a frequency of 60 s: one step has vested at NOW
      putKey(e, 8, stranger);
      putKey(e, 8 + 32, other);
      putU64(e, 8 + 136, BigInt(NOW - 90));
      putU64(e, 8 + 144, 60n);
      putU64(e, 8 + 152, 0n);
      putU64(e, 8 + 160, 250n);
      putU64(e, 8 + 168, 4n);
      putU64(e, 8 + 176, 0n);
      putU64(e, 8 + 184, BigInt(NOW - 90));
      putU64(e, 8 + 192, 0n);
      accounts.set(escrowAddress, { data: e, owner: MET_LOCK_PROGRAM_ADDRESS });
      void state;
      const ok = await post('/v1/tx/metlock-claim', { recipient: stranger, escrow: escrowAddress });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(ok.body.claimable).toBe('250');
      expect(starts(of(decode(ok.body.transaction), MET_LOCK_PROGRAM_ADDRESS)[0]!, disc('claim_v2'))).toBe(true);
      expect(ok.body.signers).toEqual([stranger]);
      expect((await post('/v1/tx/metlock-claim', { recipient: creator, escrow: escrowAddress })).body.reason).toBe('NOT_THE_RECIPIENT');
      putU64(e, 8 + 176, 250n);
      expect((await post('/v1/tx/metlock-claim', { recipient: stranger, escrow: escrowAddress })).body.reason).toBe('NOTHING_VESTED');
      expect((await post('/v1/tx/metlock-claim', { recipient: stranger, escrow: creator })).body.reason).toBe('NO_ESCROW');
      const read = await get(`/v1/metlock/escrows/${escrowAddress}`);
      expect(read.status).toBe(200);
      expect(read.body).toMatchObject({ total: '1000', vested: '250', claimable: '0', cancelled: false, recipient: stranger });
      expect((await get(`/v1/metlock/escrows/${creator}`)).status).toBe(404);
    });
  });

  // ------------------------------------------------------------------------------------------------------------------------------ Dynamic Fee Sharing
  describe('Dynamic Fee Sharing', () => {
    const recipients = () => [{ address: creator, share: 6000 }, { address: recipientB, share: 4000 }];
    const create = (over: Record<string, unknown> = {}) => ({ payer: creator, base: fresh, cross: bound, recipients: recipients(), ...over });

    it('create: builds the vault of the cross\'s quote token and reports each recipient\'s percentage', async () => {
      const r = await post('/v1/tx/fee-share-create', create());
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.feeVault).toBe(feeShareAddresses(fresh, quote).feeVault);
      expect(r.body.recipients.map((x: { percent: number }) => x.percent)).toEqual([60, 40]);
      expect(r.body.signers).toEqual(expect.arrayContaining([creator, fresh]));
      expect(starts(of(decode(r.body.transaction), DYNAMIC_FEE_SHARING_PROGRAM_ADDRESS)[0]!, disc('initialize_fee_vault_pda'))).toBe(true);
      const byMint = await post('/v1/tx/fee-share-create', { payer: creator, base: fresh, mint: other, recipients: recipients() });
      expect(byMint.status, JSON.stringify(byMint.body)).toBe(200);
      expect(byMint.body.feeVault).toBe(feeShareAddresses(fresh, other).feeVault);
    });

    it('create: refuses six recipients, a repeated recipient, no recipients, a zero share, both cross and mint, neither, and a vault that exists', async () => {
      const many = await Promise.all(Array.from({ length: 6 }, async () => ({ address: await key(), share: 1 })));
      expect((await post('/v1/tx/fee-share-create', create({ recipients: many }))).status).toBe(400);
      expect((await post('/v1/tx/fee-share-create', create({ recipients: [recipients()[0], recipients()[0]] }))).status).toBe(400);
      expect((await post('/v1/tx/fee-share-create', create({ recipients: [] }))).status).toBe(400);
      expect((await post('/v1/tx/fee-share-create', create({ recipients: [{ address: creator, share: 0 }] }))).status).toBe(400);
      expect((await post('/v1/tx/fee-share-create', create({ mint: quote }))).status).toBe(400);
      expect((await post('/v1/tx/fee-share-create', { payer: creator, base: fresh, recipients: recipients() })).status).toBe(400);
      expect((await post('/v1/tx/fee-share-create', create({ base: creator }))).status).toBe(400);
      await feeVault({ users: [{ address: creator, share: 1 }] });
      expect((await post('/v1/tx/fee-share-create', create())).body.reason).toBe('VAULT_EXISTS');
      accounts.delete(feeShareAddresses(fresh, quote).feeVault);
    });

    it('fund and claim: the vault must exist, the funder must hold the token, and a claim names the recipient\'s own index', async () => {
      expect((await post('/v1/tx/fee-share-fund', { funder: stranger, base: fresh, cross: bound, amount: '10' })).body.reason).toBe('NO_FEE_VAULT');
      await feeVault({ users: [{ address: creator, share: 6000 }, { address: recipientB, share: 4000 }] });
      await fund(stranger, quote, 50n);
      const ok = await post('/v1/tx/fee-share-fund', { funder: stranger, base: fresh, cross: bound, amount: '40' });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(starts(of(decode(ok.body.transaction), DYNAMIC_FEE_SHARING_PROGRAM_ADDRESS)[0]!, disc('fund_fee'))).toBe(true);
      expect((await post('/v1/tx/fee-share-fund', { funder: stranger, base: fresh, cross: bound, amount: '51' })).body.reason).toBe('INSUFFICIENT_TOKEN');
      expect((await post('/v1/tx/fee-share-fund', { funder: stranger, base: fresh, cross: bound, amount: '0' })).status).toBe(400);

      const claim = await post('/v1/tx/fee-share-claim', { user: recipientB, base: fresh, cross: bound, index: 1 });
      expect(claim.status, JSON.stringify(claim.body)).toBe(200);
      const ixs = decode(claim.body.transaction);
      expect(starts(of(ixs, DYNAMIC_FEE_SHARING_PROGRAM_ADDRESS)[0]!, disc('claim_fee'))).toBe(true);
      expect(ixs.some((i) => i.programAddress === 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')).toBe(true); // the claimer's token account is created when missing
      const wrong = await post('/v1/tx/fee-share-claim', { user: recipientB, base: fresh, cross: bound, index: 0 });
      expect(wrong.status).toBe(422);
      expect(wrong.body.reason).toBe('NOT_THE_RECIPIENT');
      expect((await post('/v1/tx/fee-share-claim', { user: stranger, base: fresh, cross: bound, index: 3 })).body.reason).toBe('NOT_THE_RECIPIENT');
      expect((await post('/v1/tx/fee-share-claim', { user: recipientB, base: fresh, cross: bound, index: 5 })).status).toBe(400);
    });

    it('transfer-position: one way, so the vault must exist for this pool\'s quote token and the holder must be the creator', async () => {
      const damm = await dammAddresses(bound, base, quote);
      accounts.set(damm.pool, { data: new Uint8Array(8), owner: DAMM_V2_PROGRAM_ADDRESS });
      accounts.set(damm.positionNftAccount, tokenAccount(creator, damm.positionNftMint, 1n));
      const a = await feeVault({ users: [{ address: creator, share: 6000 }, { address: recipientB, share: 4000 }] });
      const ok = await post('/v1/tx/fee-share-transfer-position', { cross: bound, owner: creator, base: fresh });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(ok.body.warning).toMatch(/One way/);
      expect(ok.body.recipients).toHaveLength(2);
      const ix = decode(ok.body.transaction).find((i) => i.programAddress === T22)!;
      expect(ix.accounts![0]!.address).toBe(damm.positionNftAccount);
      expect(ok.body.feeVault).toBe(a.feeVault);
      expect((await post('/v1/tx/fee-share-transfer-position', { cross: bound, owner: stranger, base: fresh })).body.reason).toBe('NOT_THE_CREATOR');
      // a vault of another token cannot receive this pool's fees: a one-way hand-over to it would strand them
      await feeVault({ mint: other, users: [{ address: creator, share: 1 }] });
      accounts.set(a.feeVault, { ...accounts.get(feeShareAddresses(fresh, other).feeVault)! });
      expect((await post('/v1/tx/fee-share-transfer-position', { cross: bound, owner: creator, base: fresh })).body.reason).toBe('VAULT_TOKEN_MISMATCH');
      await feeVault({ users: [{ address: creator, share: 1 }] });
      accounts.set(damm.positionNftAccount, tokenAccount(a.feeVault, damm.positionNftMint, 1n));
      expect((await post('/v1/tx/fee-share-transfer-position', { cross: bound, owner: creator, base: fresh })).body.reason).toBe('ALREADY_IN_VAULT');
      accounts.set(damm.positionNftAccount, tokenAccount(stranger, damm.positionNftMint, 1n));
      expect((await post('/v1/tx/fee-share-transfer-position', { cross: bound, owner: creator, base: fresh })).body.reason).toBe('NOT_THE_HOLDER');
      accounts.delete(a.feeVault);
      expect((await post('/v1/tx/fee-share-transfer-position', { cross: bound, owner: creator, base: fresh })).body.reason).toBe('NO_FEE_VAULT');
      expect((await post('/v1/tx/fee-share-transfer-position', { cross: live, owner: creator, base: fresh })).body.reason).toBe('LIVE');
    });

    it('fund-from-damm: the position must be in the vault and the signer one of its recipients', async () => {
      const damm = await dammAddresses(bound, base, quote);
      const a = await feeVault({ users: [{ address: creator, share: 6000 }, { address: recipientB, share: 4000 }] });
      accounts.set(damm.positionNftAccount, tokenAccount(creator, damm.positionNftMint, 1n));
      expect((await post('/v1/tx/fee-share-fund-from-damm', { cross: bound, signer: creator, base: fresh })).body.reason).toBe('POSITION_NOT_IN_VAULT');
      accounts.set(damm.positionNftAccount, tokenAccount(a.feeVault, damm.positionNftMint, 1n));
      const notMember = await post('/v1/tx/fee-share-fund-from-damm', { cross: bound, signer: stranger, base: fresh });
      expect(notMember.status).toBe(422);
      expect(notMember.body.reason).toBe('NOT_A_RECIPIENT');
      const ok = await post('/v1/tx/fee-share-fund-from-damm', { cross: bound, signer: recipientB, base: fresh });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      const ixs = decode(ok.body.transaction);
      const fund = of(ixs, DYNAMIC_FEE_SHARING_PROGRAM_ADDRESS)[0]!;
      expect(starts(fund, disc('fund_by_claiming_fee'))).toBe(true);
      expect(ok.body.tokenAAccount).toBe(await ata(recipientB, base, T22));
      expect(ixs.some((i) => i.programAddress === 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')).toBe(true);
    });

    it('GET reads the vault and each recipient\'s share', async () => {
      const a = await feeVault({ users: [{ address: creator, share: 6000 }, { address: recipientB, share: 4000 }] });
      const r = await get(`/v1/fee-share/${fresh}/${quote}`);
      expect(r.status).toBe(200);
      expect(r.body.feeVault).toBe(a.feeVault);
      expect(r.body.shares.map((s: { percent: number }) => s.percent)).toEqual([60, 40]);
      const none = await get(`/v1/fee-share/${creator}/${quote}`);
      expect(none.body.vault).toBeNull();
      expect((await get(`/v1/fee-share/x/${quote}`)).status).toBe(400);
    });
  });

  it('refuses every route when the external program is missing from the cluster', async () => {
    const keep = accounts.get(MET_LOCK_PROGRAM_ADDRESS)!;
    accounts.delete(MET_LOCK_PROGRAM_ADDRESS);
    const r = await post('/v1/tx/metlock-create', { sender: creator, base: fresh, mint: other, recipient: stranger, schedule: { total: '10', start: String(NOW), periods: '1', frequency: '1' } });
    accounts.set(MET_LOCK_PROGRAM_ADDRESS, keep);
    expect(r.status).toBe(409);
    expect(r.body.reason).toBe('EXTERNAL_PROGRAM_MISSING');
  });
});
