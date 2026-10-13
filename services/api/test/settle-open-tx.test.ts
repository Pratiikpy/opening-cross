// The instructions that open a market for a cleared cross, over HTTP with accounts injected in memory: the refusals that come before a transaction, the
// release check against fabricated program bytes, the size check, and every built transaction decoded back to instructions. The programs are not run
// here (their LiteSVM suites run against the real binaries, tests/core).
import Fastify from 'fastify';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  type Address,
  type Instruction,
  decompileTransactionMessage,
  generateKeyPairSigner,
  getAddressEncoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  none,
  some,
} from '@solana/kit';
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import { CROSS_BODY_LEN, CROSS_CORE_PROGRAM_ADDRESS, CrossKind, CrossState, Disclosure, SupplyMode, ata, crossAddress, getCrossEncoder } from '@opening-cross/sdk';
import {
  BIND_DBC_MINT_DISCRIMINATOR,
  CROSS_SETTLE_PROGRAM_ADDRESS,
  OPEN_DBC_POOL_DISCRIMINATOR,
  OPEN_DBC_POOL_LOCKED_DISCRIMINATOR,
  OPEN_DLMM_PAIR_BADGED_DISCRIMINATOR,
  OPEN_DLMM_PAIR_BATCHED_DISCRIMINATOR,
  OPEN_DLMM_PAIR_DISCRIMINATOR,
  SEED_DAMM_V2_BATCHED_DISCRIMINATOR,
  SEED_DAMM_V2_DISCRIMINATOR,
  SEED_RAYDIUM_CPMM_DISCRIMINATOR,
} from '@opening-cross/cross-settle-client';
import { DAMM_V2_PROGRAM_ADDRESS, DBC_PROGRAM_ADDRESS, DLMM_PROGRAM_ADDRESS, RAYDIUM_CPMM_PROGRAM_ADDRESS, continuationAddresses, continuationMintAddress, dammAddresses, dlmmAddresses, dlmmTokenBadgeAddress, settlerAddress } from '@opening-cross/adapters';
import { RequestError } from '../src/tx.js';
import { registerSettleOpenTx } from '../src/routes/settle-open-tx.js';
import { type ReleaseGate, releaseGate } from '../src/routes/program-gate.js';

const NOW = 1_800_000_000;
const BLOCKHASH = '4NCYB3kRT8sCNodPNuCZo8VkwveZSHhg7R7mrRBFM1Uy' as never;
const ZERO = '11111111111111111111111111111111' as Address;
const LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111' as Address;
const T22 = TOKEN_2022_PROGRAM_ADDRESS;
const key = async () => (await generateKeyPairSigner()).address;
type Account = { data: Uint8Array; owner: Address };

/** A locked, compounding curve design, as JSON: every enum a number (see tests/core/src/settle-world.ts, which runs it against the real binaries). */
const LOCKED_DESIGN = {
  token: { tokenBaseDecimal: 6, tokenQuoteDecimal: 6, totalTokenSupply: 1_000_000_000, leftover: 5_000_000 },
  fee: {
    baseFeeParams: { baseFeeMode: 0, feeSchedulerParam: { startingFeeBps: 100, endingFeeBps: 100, numberOfPeriod: 0, totalDuration: 0 } },
    dynamicFeeEnabled: false,
    collectFeeMode: 0,
    creatorTradingFeePercentage: 40,
    poolCreationFee: 0,
    enableFirstSwapWithMinFee: false,
  },
  migration: { migrationOption: 1, migrationFeeOption: 6, migrationFee: { feePercentage: 0, creatorFeePercentage: 0 }, migratedPoolFee: { collectFeeMode: 2, dynamicFee: 0, poolFeeBps: 100, compoundingFeeBps: 5000 } },
  liquidityDistribution: {
    partnerLiquidityPercentage: 0,
    partnerPermanentLockedLiquidityPercentage: 30,
    creatorLiquidityPercentage: 0,
    creatorPermanentLockedLiquidityPercentage: 10,
    creatorLiquidityVestingInfoParams: { vestingPercentage: 60, bpsPerPeriod: 2500, numberOfPeriods: 4, cliffDurationFromMigrationTime: 0, totalDuration: 4 * 86_400 },
  },
  lockedVesting: { totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0, totalVestingDuration: 0, cliffDurationFromMigrationTime: 0 },
  activationType: 1,
  sqrtPriceMultiples: [2, 4],
};

describe('opening a market for a cleared cross over HTTP', () => {
  const accounts = new Map<string, Account>();
  let app: ReturnType<typeof Fastify>;
  let creator: Address, stranger: Address, base: Address, quote: Address, integrator: Address, fees: Address, vesting: Address;
  let gate: ReleaseGate | undefined;
  let deferred: Address, live: Address, bound: Address, noSettler: Address;

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
  const programOf = (ixs: Instruction[]) => ixs.filter((i) => i.programAddress === CROSS_SETTLE_PROGRAM_ADDRESS);
  const is = (ix: Instruction, disc: Uint8Array) => ix.programAddress === CROSS_SETTLE_PROGRAM_ADDRESS && disc.every((b, i) => ix.data![i] === b);

  async function putCross(id: bigint, o: { state: CrossState; supplyMode?: SupplyMode; cleared?: boolean; baseBound?: boolean; settler?: boolean }): Promise<Address> {
    const address = await crossAddress(creator, id);
    const body = getCrossEncoder().encode({
      creator, crossId: id, kind: CrossKind.Launch, supplyMode: o.supplyMode ?? SupplyMode.DeferredMint, disclosure: Disclosure.Open, state: o.state,
      baseMint: o.baseBound === false ? ZERO : base, quoteMint: quote, baseTokenProgram: T22, quoteTokenProgram: T22, baseDecimals: 6, quoteDecimals: 6, proceedsTo: creator,
      minPrice: 1_000_000n, tick: 100_000n, ticks: 20, priceScale: 1_000_000n, openTs: 1n, closeTs: 2n, revealEndTs: 3n, referencePrice: none(), minMatched: 0n, maxImbalanceBps: none(),
      protocolFeeBps: 30, integratorFeeBps: 20, integrator, feeRecipient: fees, gateMint: none(), shards: 2, maxOrders: 64, dustBond: 0n, ordersTotal: 0, ordersOpen: 0, mergedMask: 3,
      clearing: o.cleared === false ? none() : some({ price: 1_300_000n, matched: 1_000_000_000n, demand: 1_000_000_000n, supply: 1_000_000_000n, rationed: 0, marginalQuantity: 0n, marginalRemaining: 0n, marginalOrders: 0 }),
      noPrintReason: none(), buyerPaid: 2_600_000_000n, baseBought: 0n, baseSold: 0n, sellerPaid: 0n, feesAccrued: 0n, oracle: none(), calendar: none(),
      settler: o.settler === false ? none() : some(await settlerAddress(address)),
      settleDeadlineTs: 0n, baseBound: o.baseBound ?? false, bump: 1, quoteVaultBump: 1, baseVaultBump: 1, bookBump: 1,
    } as never);
    const data = new Uint8Array(CROSS_BODY_LEN);
    data.set(body);
    accounts.set(address, { owner: CROSS_CORE_PROGRAM_ADDRESS, data });
    return address;
  }
  const tokenAccount = (owner: Address, mint: Address, amount: bigint) => {
    const data = new Uint8Array(165);
    data.set(getAddressEncoder().encode(mint), 0);
    data.set(getAddressEncoder().encode(owner), 32);
    new DataView(data.buffer).setBigUint64(64, amount, true);
    return { data, owner: T22 };
  };
  const fund = async (who: Address, baseAmount: bigint, quoteAmount: bigint) => {
    accounts.set(await ata(who, base, T22), tokenAccount(who, base, baseAmount));
    accounts.set(await ata(who, quote, T22), tokenAccount(who, quote, quoteAmount));
  };
  const program = (a: Address) => accounts.set(a, { data: new Uint8Array(36), owner: LOADER });

  beforeAll(async () => {
    [creator, stranger, base, quote, integrator, fees, vesting] = await Promise.all(Array.from({ length: 7 }, key));
    deferred = await putCross(1n, { state: CrossState.Cleared, baseBound: false });
    live = await putCross(2n, { state: CrossState.Live, cleared: false, baseBound: false });
    bound = await putCross(3n, { state: CrossState.Cleared, baseBound: true });
    noSettler = await putCross(4n, { state: CrossState.Cleared, baseBound: false, settler: false });
    for (const p of [DBC_PROGRAM_ADDRESS, DAMM_V2_PROGRAM_ADDRESS, DLMM_PROGRAM_ADDRESS, RAYDIUM_CPMM_PROGRAM_ADDRESS]) program(p);
    await fund(creator, 5_000_000_000_000n, 5_000_000_000_000n);
    app = Fastify({ logger: false });
    app.setErrorHandler((err, _req, reply) => {
      if (err instanceof RequestError) return reply.code(err.status).type('application/json').send(JSON.stringify({ error: err.message, ...err.detail }, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)));
      return reply.code(500).send({ error: String(err) });
    });
    registerSettleOpenTx(app, { account: async (a) => accounts.get(a) ?? null, lifetime: async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 100n }), clock: () => NOW, gate: (...args) => (gate ? gate(...args) : Promise.resolve('unknown')) });
  }, 120_000);

  // ------------------------------------------------------------------------------------------------------------------------ the DBC continuation
  describe('open-dbc-pool', () => {
    const body = (over: Record<string, unknown> = {}) => ({ cross: deferred, creator, design: LOCKED_DESIGN, name: 'Opening Token', symbol: 'OPEN', uri: 'https://example.invalid/open.json', ...over });

    it('builds the locked open and the bind, in one transaction when they fit, with a compute limit, and names the pool', async () => {
      const r = await post('/v1/tx/open-dbc-pool', body());
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const a = await continuationAddresses(deferred, quote);
      expect(r.body.pool).toBe(a.pool);
      expect(r.body.config).toBe(a.config);
      expect(r.body.baseMint).toBe(await continuationMintAddress(deferred));
      expect(r.body.locked).toBe(true);
      expect(r.body.designIssues).toEqual([]);
      for (const t of r.body.transactions) expect(Buffer.from(t.transaction, 'base64').length).toBeLessThanOrEqual(1232);
      expect(r.body.sizes.every((s: number) => s <= 1232)).toBe(true);
      const ixs = r.body.transactions.flatMap((t: { transaction: string }) => decode(t.transaction));
      const settle = programOf(ixs);
      expect(is(settle[0]!, OPEN_DBC_POOL_LOCKED_DISCRIMINATOR)).toBe(true);
      expect(is(settle[1]!, BIND_DBC_MINT_DISCRIMINATOR)).toBe(true);
      // the creator signs and pays; the mint authority handover is done by the program, so nobody else signs
      expect(r.body.transactions[0].signers).toEqual([creator]);
      expect(r.body.atomic).toBe(r.body.transactions.length === 1);
      expect(r.body.release).toEqual({ program: CROSS_SETTLE_PROGRAM_ADDRESS, instruction: 'open_dbc_pool_locked', deployed: null });
    });

    it('splits the open and the bind into two transactions when a long curve does not leave room for both, and refuses a curve that does not fit even alone', async () => {
      const curve = (n: number) => ({ ...LOCKED_DESIGN, sqrtPriceMultiples: Array.from({ length: n }, (_, i) => 1.1 + i * 0.4) });
      const two = await post('/v1/tx/open-dbc-pool', body({ design: curve(2) }));
      expect(two.body.atomic).toBe(true);
      const eight = await post('/v1/tx/open-dbc-pool', body({ design: curve(8) }));
      expect(eight.status, JSON.stringify(eight.body)).toBe(200);
      expect(eight.body.atomic).toBe(false);
      expect(eight.body.transactions).toHaveLength(2);
      expect(eight.body.sizes.every((s: number) => s <= 1232)).toBe(true);
      const settle = eight.body.transactions.map((t: { transaction: string }) => programOf(decode(t.transaction)));
      expect(is(settle[0][0], OPEN_DBC_POOL_LOCKED_DISCRIMINATOR)).toBe(true);
      expect(is(settle[1][0], BIND_DBC_MINT_DISCRIMINATOR)).toBe(true);
      const huge = await post('/v1/tx/open-dbc-pool', body({ design: curve(16) }));
      expect(huge.status).toBe(422);
      expect(huge.body.reason).toBe('TX_TOO_LARGE');
      expect(huge.body.bytes).toBeGreaterThan(1232);
    });

    it('with locked false uses open_dbc_pool, and says what the buyers lose', async () => {
      const r = await post('/v1/tx/open-dbc-pool', body({ locked: false }));
      expect(r.status).toBe(200);
      expect(programOf(r.body.transactions.flatMap((t: { transaction: string }) => decode(t.transaction)))[0]).toSatisfy((ix: Instruction) => is(ix, OPEN_DBC_POOL_DISCRIMINATOR));
      expect(r.body.warnings[0]).toMatch(/does not promise/);
    });

    it('either variant needs the build that has open_dbc_pool_locked: the same instruction name in an older program takes the older argument layout', async () => {
      gate = async (_program, instruction) => (instruction.name === 'open_dbc_pool_locked' ? 'absent' : 'present');
      for (const locked of [true, false]) {
        const r = await post('/v1/tx/open-dbc-pool', body({ locked }));
        expect(r.status).toBe(409);
        expect(r.body).toMatchObject({ reason: 'PROGRAM_NOT_DEPLOYED', instruction: 'open_dbc_pool_locked' });
      }
      gate = undefined;
    });

    it('refuses a design that is not the locked design, naming every departure', async () => {
      const bad = structuredClone(LOCKED_DESIGN);
      bad.migration.migratedPoolFee = { collectFeeMode: 0, dynamicFee: 0, poolFeeBps: 100, compoundingFeeBps: 0 };
      bad.liquidityDistribution.partnerPermanentLockedLiquidityPercentage = 5;
      bad.liquidityDistribution.creatorPermanentLockedLiquidityPercentage = 5;
      bad.liquidityDistribution.creatorLiquidityVestingInfoParams.vestingPercentage = 90;
      const r = await post('/v1/tx/open-dbc-pool', body({ design: bad }));
      expect(r.status).toBe(422);
      expect(r.body.reason).toBe('DESIGN_NOT_LOCKED');
      expect(r.body.issues.map((i: { code: string }) => i.code)).toEqual(expect.arrayContaining(['DesignNotCompounding', 'DesignLockTooLow']));
      // the same design is fine for the plain instruction
      expect((await post('/v1/tx/open-dbc-pool', body({ design: bad, locked: false }))).status).toBe(200);
    });

    it('refuses the states the program refuses', async () => {
      expect((await post('/v1/tx/open-dbc-pool', body({ creator: stranger }))).body.reason).toBe('NOT_THE_CREATOR');
      expect((await post('/v1/tx/open-dbc-pool', body({ cross: live }))).body.reason).toBe('LIVE');
      expect((await post('/v1/tx/open-dbc-pool', body({ cross: bound }))).body.reason).toBe('ALREADY_BOUND');
      expect((await post('/v1/tx/open-dbc-pool', body({ cross: noSettler }))).body.reason).toBe('WRONG_SETTLER');
      const a = await continuationAddresses(deferred, quote);
      accounts.set(a.config, { data: new Uint8Array(8), owner: DBC_PROGRAM_ADDRESS });
      expect((await post('/v1/tx/open-dbc-pool', body())).body.reason).toBe('POOL_EXISTS');
      accounts.delete(a.config);
      expect((await post('/v1/tx/open-dbc-pool', body({ cross: '11111111111111111111111111111112' }))).status).toBe(404);
    });

    it('refuses malformed input before reading anything', async () => {
      expect((await post('/v1/tx/open-dbc-pool', body({ design: { ...LOCKED_DESIGN, tokenQuoteAddress: 'x' } }))).status).toBe(400);
      expect((await post('/v1/tx/open-dbc-pool', body({ design: { token: LOCKED_DESIGN.token } }))).status).toBe(400);
      expect((await post('/v1/tx/open-dbc-pool', body({ design: { ...LOCKED_DESIGN, activationType: 'timestamp' } }))).status).toBe(400);
      expect((await post('/v1/tx/open-dbc-pool', body({ name: '' }))).status).toBe(400);
      expect((await post('/v1/tx/open-dbc-pool', body({ symbol: 'ABCDEFGHIJK' }))).status).toBe(400);
      expect((await post('/v1/tx/open-dbc-pool', body({ locked: 'yes' }))).status).toBe(400);
      expect((await post('/v1/tx/open-dbc-pool', body({ extra: 1 }))).status).toBe(400);
      expect((await post('/v1/tx/open-dbc-pool', { creator })).status).toBe(400);
    });

    it('answers a design the SDK cannot build as 422 DESIGN_INVALID', async () => {
      const r = await post('/v1/tx/open-dbc-pool', body({ design: { ...LOCKED_DESIGN, sqrtPriceMultiples: [4, 2] } }));
      expect(r.status).toBe(422);
      expect(r.body.reason).toBe('DESIGN_INVALID');
    });

    it('requires Meteora\'s DBC program on the cluster', async () => {
      const keep = accounts.get(DBC_PROGRAM_ADDRESS)!;
      accounts.delete(DBC_PROGRAM_ADDRESS);
      const r = await post('/v1/tx/open-dbc-pool', body());
      accounts.set(DBC_PROGRAM_ADDRESS, keep);
      expect(r.status).toBe(409);
      expect(r.body.reason).toBe('EXTERNAL_PROGRAM_MISSING');
    });
  });

  describe('bind-dbc-mint', () => {
    it('needs the pool opened: the mint exists with the settler as its authority', async () => {
      expect((await post('/v1/tx/bind-dbc-mint', { cross: deferred, payer: stranger })).body.reason).toBe('POOL_NOT_OPENED');
      const mint = new Uint8Array(82);
      new DataView(mint.buffer).setUint32(0, 1, true);
      mint.set(getAddressEncoder().encode(await settlerAddress(deferred)), 4);
      accounts.set(await continuationMintAddress(deferred), { data: mint, owner: T22 });
      const r = await post('/v1/tx/bind-dbc-mint', { cross: deferred, payer: stranger });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(is(programOf(decode(r.body.transaction))[0]!, BIND_DBC_MINT_DISCRIMINATOR)).toBe(true);
      expect(r.body.signers).toEqual([stranger]);
      // a mint whose authority is someone else is not this cross's pool
      new DataView(mint.buffer).setUint32(0, 0, true);
      expect((await post('/v1/tx/bind-dbc-mint', { cross: deferred, payer: stranger })).body.reason).toBe('POOL_NOT_OPENED');
      accounts.delete(await continuationMintAddress(deferred));
      expect((await post('/v1/tx/bind-dbc-mint', { cross: bound, payer: stranger })).body.reason).toBe('ALREADY_BOUND');
      expect((await post('/v1/tx/bind-dbc-mint', { cross: deferred, payer: 'x' })).status).toBe(400);
    });
  });

  // ------------------------------------------------------------------------------------------------------------------------ DAMM v2
  describe('seed-damm-v2', () => {
    const body = (over: Record<string, unknown> = {}) => ({ cross: bound, creator, baseAmount: '1000000000', quoteAmount: '1300000000', feeBps: 100, ...over });
    const batch = (over: Record<string, unknown> = {}) => ({ windowSecs: 300, activationPoint: String(NOW + 600), endingFeeBps: 25, periods: 10, periodSecs: 60, ...over });

    it('builds the plain seeding at the clearing price', async () => {
      const r = await post('/v1/tx/seed-damm-v2', body());
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const addrs = await dammAddresses(bound, base, quote);
      expect(r.body.pool).toBe(addrs.pool);
      expect(r.body.position).toBe(addrs.position);
      expect(BigInt(r.body.liquidity) > 0n).toBe(true);
      expect(r.body.atomic).toBe(true);
      expect(is(programOf(decode(r.body.transactions[0].transaction))[0]!, SEED_DAMM_V2_DISCRIMINATOR)).toBe(true);
      expect(r.body.sizes[0]).toBeLessThanOrEqual(1232);
      expect(r.body.landBy).toBeUndefined();
    });

    it('builds the batch-opened seeding with its landing deadline, and the alpha-vault flag only with a batch', async () => {
      const r = await post('/v1/tx/seed-damm-v2', body({ batch: batch(), alphaVault: true }));
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(is(programOf(decode(r.body.transactions[0].transaction))[0]!, SEED_DAMM_V2_BATCHED_DISCRIMINATOR)).toBe(true);
      expect(r.body.landBy).toBe(String(NOW + 600 - 300));
      expect((await post('/v1/tx/seed-damm-v2', body({ alphaVault: true }))).body.reason).toBe('ALPHA_NEEDS_BATCH');
    });

    it('refuses a batch the program would refuse, with every issue', async () => {
      const early = await post('/v1/tx/seed-damm-v2', body({ batch: batch({ activationPoint: String(NOW + 299) }) }));
      expect(early.status).toBe(422);
      expect(early.body.reason).toBe('BATCH_INVALID');
      expect(early.body.issues[0].code).toBe('BatchActivation');
      expect((await post('/v1/tx/seed-damm-v2', body({ batch: batch({ windowSecs: 29 }) }))).body.issues[0].code).toBe('BatchWindow');
      expect((await post('/v1/tx/seed-damm-v2', body({ batch: batch({ endingFeeBps: 100 }) }))).body.issues[0].code).toBe('BatchFeeNotDecaying');
      expect((await post('/v1/tx/seed-damm-v2', body({ batch: batch({ periods: 0 }) }))).body.issues[0].code).toBe('BatchFeeNotDecaying');
      expect((await post('/v1/tx/seed-damm-v2', body({ batch: batch(), collectFeeMode: 0 }))).body.reason).toBe('BatchNotCompounding');
    });

    it('locks liquidity from the first block in the same transaction: permanently, or on a vesting schedule', async () => {
      const r = await post('/v1/tx/seed-damm-v2', body({ lock: { permanentLiquidity: 'all' } }));
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const ixs = decode(r.body.transactions[0].transaction);
      expect(ixs.filter((i) => i.programAddress === DAMM_V2_PROGRAM_ADDRESS)).toHaveLength(1);
      expect(r.body.atomic).toBe(true);
      const v = await post('/v1/tx/seed-damm-v2', body({ lock: { vest: { vesting, cliffPoint: String(NOW + 86_400), periodFrequency: '86400', liquidityPerPeriod: '1000', numberOfPeriod: 4 } } }));
      expect(v.status, JSON.stringify(v.body)).toBe(200);
      expect(v.body.transactions.flatMap((t: { signers: string[] }) => t.signers)).toEqual(expect.arrayContaining([creator, vesting]));
    });

    it('refuses to lock more than the pool opens with', async () => {
      const r = await post('/v1/tx/seed-damm-v2', body({ lock: { permanentLiquidity: '340282366920938463463374607431768211455' } }));
      expect(r.status).toBe(422);
      expect(r.body.reason).toBe('LOCK_OVER_LIQUIDITY');
      expect((await post('/v1/tx/seed-damm-v2', body({ lock: {} }))).status).toBe(400);
    });

    it('refuses what the program refuses, and what the creator could not pay for', async () => {
      expect((await post('/v1/tx/seed-damm-v2', body({ creator: stranger }))).body.reason).toBe('NOT_THE_CREATOR');
      expect((await post('/v1/tx/seed-damm-v2', body({ cross: deferred }))).body.reason).toBe('NO_BASE_MINT');
      expect((await post('/v1/tx/seed-damm-v2', body({ cross: live }))).body.reason).toBe('LIVE');
      const short = await post('/v1/tx/seed-damm-v2', body({ baseAmount: '9999999999999999' }));
      expect(short.status).toBe(422);
      expect(short.body.reason).toBe('INSUFFICIENT_BASE');
      expect(short.body.need).toBe('9999999999999999');
      const addrs = await dammAddresses(bound, base, quote);
      accounts.set(addrs.pool, { data: new Uint8Array(8), owner: DAMM_V2_PROGRAM_ADDRESS });
      expect((await post('/v1/tx/seed-damm-v2', body())).body.reason).toBe('POOL_EXISTS');
      accounts.delete(addrs.pool);
      for (const bad of [{ feeBps: 0 }, { feeBps: 10_001 }, { baseAmount: 'x' }, { quoteAmount: '-1' }, { collectFeeMode: 3 }, { extra: 1 }]) expect((await post('/v1/tx/seed-damm-v2', body(bad))).status).toBe(400);
    });

    it('a creator with no quote account is told which account to create', async () => {
      const lonely = await key();
      accounts.set(await ata(lonely, base, T22), tokenAccount(lonely, base, 10n ** 12n));
      const cross = await putCross(9n, { state: CrossState.Cleared, baseBound: true });
      void cross;
      // the creator is fixed per cross, so ask as the creator with the quote account removed
      const quoteAta = await ata(creator, quote, T22);
      const keep = accounts.get(quoteAta)!;
      accounts.delete(quoteAta);
      const r = await post('/v1/tx/seed-damm-v2', body());
      accounts.set(quoteAta, keep);
      expect(r.status).toBe(409);
      expect(r.body.reason).toBe('NO_QUOTE_ACCOUNT');
      expect(r.body.account).toBe(quoteAta);
    });
  });

  // ------------------------------------------------------------------------------------------------------------------------ DLMM
  describe('open-dlmm-pair', () => {
    const body = (over: Record<string, unknown> = {}) => ({ cross: bound, creator, binStep: 10, baseFactor: 10_000, ...over });

    it('builds the plain pair with the active bin that holds the clearing price', async () => {
      const r = await post('/v1/tx/open-dlmm-pair', body());
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.lbPair).toBe(dlmmAddresses(base, quote).lbPair);
      expect(r.body.activeId).toBe(262); // ln(1.3) / ln(1.001) = 262.4
      expect(is(programOf(decode(r.body.transaction))[0]!, OPEN_DLMM_PAIR_DISCRIMINATOR)).toBe(true);
      expect(r.body.bytes).toBeLessThanOrEqual(1232);
    });

    it('builds the batch-opened pair, and refuses a start inside the window', async () => {
      const r = await post('/v1/tx/open-dlmm-pair', body({ batch: { windowSecs: 300, activationPoint: String(NOW + 400), alphaVault: true } }));
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(is(programOf(decode(r.body.transaction))[0]!, OPEN_DLMM_PAIR_BATCHED_DISCRIMINATOR)).toBe(true);
      expect(r.body.landBy).toBe(String(NOW + 100));
      const early = await post('/v1/tx/open-dlmm-pair', body({ batch: { windowSecs: 300, activationPoint: String(NOW + 10) } }));
      expect(early.status).toBe(422);
      expect(early.body.reason).toBe('BATCH_INVALID');
    });

    it('builds the badged pair with the two badge accounts, base then quote, and refuses a badge that does not exist', async () => {
      const missing = await post('/v1/tx/open-dlmm-pair', body({ badges: { base: true } }));
      expect(missing.status).toBe(422);
      expect(missing.body.reason).toBe('BADGE_MISSING');
      expect(missing.body.badge).toBe(dlmmTokenBadgeAddress(base));
      accounts.set(dlmmTokenBadgeAddress(base), { data: new Uint8Array(40), owner: DLMM_PROGRAM_ADDRESS });
      const r = await post('/v1/tx/open-dlmm-pair', body({ badges: { base: true } }));
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const ix = programOf(decode(r.body.transaction))[0]!;
      expect(is(ix, OPEN_DLMM_PAIR_BADGED_DISCRIMINATOR)).toBe(true);
      const tail = ix.accounts!.slice(-2).map((a) => a.address);
      expect(tail).toEqual([dlmmTokenBadgeAddress(base), DLMM_PROGRAM_ADDRESS]);
      // a badge account owned by someone else is not a badge
      accounts.set(dlmmTokenBadgeAddress(base), { data: new Uint8Array(40), owner: stranger });
      expect((await post('/v1/tx/open-dlmm-pair', body({ badges: { base: true } }))).body.reason).toBe('BADGE_MISSING');
      accounts.delete(dlmmTokenBadgeAddress(base));
    });

    it('refuses what the program refuses', async () => {
      expect((await post('/v1/tx/open-dlmm-pair', body({ creator: stranger }))).body.reason).toBe('NOT_THE_CREATOR');
      expect((await post('/v1/tx/open-dlmm-pair', body({ cross: deferred }))).body.reason).toBe('NO_BASE_MINT');
      expect((await post('/v1/tx/open-dlmm-pair', body({ cross: live }))).body.reason).toBe('LIVE');
      const pair = dlmmAddresses(base, quote).lbPair;
      accounts.set(pair, { data: new Uint8Array(8), owner: DLMM_PROGRAM_ADDRESS });
      expect((await post('/v1/tx/open-dlmm-pair', body())).body.reason).toBe('POOL_EXISTS');
      accounts.delete(pair);
      for (const bad of [{ binStep: 0 }, { binStep: 70_000 }, { baseFactor: 0 }, { baseFeePowerFactor: 256 }, { badges: { base: 'yes' } }, { extra: 1 }]) expect((await post('/v1/tx/open-dlmm-pair', body(bad))).status).toBe(400);
    });
  });

  // ------------------------------------------------------------------------------------------------------------------------ Raydium
  describe('seed-raydium-cpmm', () => {
    it('builds the pool with the quote amount the clearing price implies, and checks both balances', async () => {
      const r = await post('/v1/tx/seed-raydium-cpmm', { cross: bound, creator, baseAmount: '1000000000' });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.quoteAmount).toBe('1300000000');
      expect(is(programOf(decode(r.body.transaction))[0]!, SEED_RAYDIUM_CPMM_DISCRIMINATOR)).toBe(true);
      expect((await post('/v1/tx/seed-raydium-cpmm', { cross: bound, creator, baseAmount: '999999999999999999' })).body.reason).toBe('INSUFFICIENT_BASE');
      expect((await post('/v1/tx/seed-raydium-cpmm', { cross: bound, creator: stranger, baseAmount: '1' })).body.reason).toBe('NOT_THE_CREATOR');
      expect((await post('/v1/tx/seed-raydium-cpmm', { cross: bound, creator, baseAmount: '0' })).status).toBe(400);
      expect((await post('/v1/tx/seed-raydium-cpmm', { cross: deferred, creator, baseAmount: '1' })).body.reason).toBe('NO_BASE_MINT');
    });
  });

  // ------------------------------------------------------------------------------------------------------------------------ the release check
  describe('the release check', () => {
    const header = (body: Uint8Array) => {
      const out = new Uint8Array(45 + body.length);
      new DataView(out.buffer).setUint32(0, 3, true);
      new DataView(out.buffer).setBigUint64(4, 4242n, true);
      out.set(body, 45);
      return out;
    };
    const elf = (discs: Uint8Array[]) => {
      const out = new Uint8Array(4096 + discs.length * 64);
      out.fill(0x07, 0, 4096);
      discs.forEach((d, n) => {
        const at = 4096 + n * 64;
        out[at] = 0x18;
        out[at + 1] = 0x01;
        out.set(d.subarray(0, 4), at + 4);
        out.set(d.subarray(4, 8), at + 12);
      });
      return out;
    };
    const deploy = async (discs: Uint8Array[]) => {
      const data = await key();
      const prog = new Uint8Array(36);
      new DataView(prog.buffer).setUint32(0, 2, true);
      prog.set(getAddressEncoder().encode(data), 4);
      accounts.set(CROSS_SETTLE_PROGRAM_ADDRESS, { data: prog, owner: LOADER });
      accounts.set(data, { data: header(elf(discs)), owner: LOADER });
    };
    const real = (): ReleaseGate => releaseGate({ account: async (a) => accounts.get(a) ?? null, clock: () => NOW, ttlMs: 0 });
    const ask = () => post('/v1/tx/seed-damm-v2', { cross: bound, creator, baseAmount: '1000000000', quoteAmount: '1300000000', feeBps: 100 });

    it('refuses with PROGRAM_NOT_DEPLOYED when the deployed program lacks the instruction, and names the release route', async () => {
      await deploy([OPEN_DBC_POOL_DISCRIMINATOR as Uint8Array]); // the first release
      gate = real();
      const r = await ask();
      expect(r.status).toBe(409);
      expect(r.body.reason).toBe('PROGRAM_NOT_DEPLOYED');
      expect(r.body.instruction).toBe('seed_damm_v2');
      expect(r.body.error).toMatch(/GET \/v1\/programs/);
      expect(r.body.error).toMatch(/H27/);
    });

    it('builds when the instruction is in the program, and says it was found', async () => {
      await deploy([OPEN_DBC_POOL_DISCRIMINATOR, SEED_DAMM_V2_DISCRIMINATOR] as Uint8Array[]);
      gate = real();
      const r = await ask();
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.release).toEqual({ program: CROSS_SETTLE_PROGRAM_ADDRESS, instruction: 'seed_damm_v2', deployed: true });
      // the batched variant is a different instruction: this release has the plain one only
      const b = await post('/v1/tx/seed-damm-v2', { cross: bound, creator, baseAmount: '1000000000', quoteAmount: '1300000000', feeBps: 100, batch: { windowSecs: 300, activationPoint: String(NOW + 600), endingFeeBps: 25, periods: 10, periodSecs: 60 } });
      expect(b.body.reason).toBe('PROGRAM_NOT_DEPLOYED');
      expect(b.body.instruction).toBe('seed_damm_v2_batched');
    });

    it('never reads an unreadable or unrecognisable program as an old one', async () => {
      await deploy([SEED_DAMM_V2_DISCRIMINATOR] as Uint8Array[]); // the control instruction every release has is missing: the scan is not trusted
      gate = real();
      const r = await ask();
      expect(r.status).toBe(200);
      expect(r.body.release.deployed).toBeNull();
      accounts.delete(CROSS_SETTLE_PROGRAM_ADDRESS);
      expect((await ask()).body.release.deployed).toBeNull();
      gate = undefined;
    });
  });

  // ------------------------------------------------------------------------------------------------------------------------ the read
  describe('GET /v1/crosses/:address/venues', () => {
    it('says which venues are open and which openings are available', async () => {
      const a = await get(`/v1/crosses/${deferred}/venues`);
      expect(a.status).toBe(200);
      expect(a.body.available).toEqual(['open-dbc-pool']);
      expect(a.body.venues.dbc.opened).toBe(false);
      expect(a.body.venues.dammV2).toBeNull();
      const b = await get(`/v1/crosses/${bound}/venues`);
      expect(b.body.available).toEqual(['seed-damm-v2', 'open-dlmm-pair', 'seed-raydium-cpmm']);
      accounts.set(dlmmAddresses(base, quote).lbPair, { data: new Uint8Array(8), owner: DLMM_PROGRAM_ADDRESS });
      const c = await get(`/v1/crosses/${bound}/venues`);
      expect(c.body.venues.dlmm.opened).toBe(true);
      expect(c.body.available).not.toContain('open-dlmm-pair');
      accounts.delete(dlmmAddresses(base, quote).lbPair);
      const l = await get(`/v1/crosses/${live}/venues`);
      expect(l.body.available).toEqual([]);
      expect(l.body.clearingPrice).toBeNull();
      expect((await get('/v1/crosses/not-an-address/venues')).status).toBe(400);
    });
  });
});
