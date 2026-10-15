// cross_settle over HTTP, part two: the instructions that OPEN a market for a cleared cross, as unsigned transactions (ADR-0700).
//
// The payouts and the greenshoe are in settle-tx.ts. These are the issuer's steps that put the cleared price into a venue: the DBC continuation
// (locked, compounding design), a DAMM v2 pool (plain, batch-opened, with an Alpha Vault binding, with a permanent lock or a vesting schedule), a
// DLMM pair (plain, batch-opened, with Token Badges for tokenized stocks) and a Raydium CPMM pool.
//
// The API never holds a key. Every transaction comes back unsigned with the named wallet as fee payer, every check the program would make that can be
// made from chain state is made first (and answers with a reason), and every transaction is measured against the 1,232-byte limit. These instructions
// exist only in the cross_settle build that is NOT deployed on devnet yet (docs/HUMAN_TASKS.md H27): the program's own bytes are read first, and a
// route answers 409 PROGRAM_NOT_DEPLOYED when the instruction is not in the deployed program (routes/program-gate.ts).
//
//   POST /v1/tx/open-dbc-pool       { cross, creator, design, name, symbol, uri, locked? }       the DBC config and pool at the clearing price, then the mint bound; { transactions }
//   POST /v1/tx/bind-dbc-mint       { cross, payer }                                             the second step alone, when the first landed in its own transaction
//   POST /v1/tx/seed-damm-v2        { cross, creator, baseAmount, quoteAmount, feeBps, batch?, alphaVault?, lock?, ... }   a DAMM v2 pool at exactly the clearing price
//   POST /v1/tx/open-dlmm-pair      { cross, creator, binStep, baseFactor, batch?, badges?, ... }   a DLMM pair whose active bin holds the clearing price
//   POST /v1/tx/seed-raydium-cpmm   { cross, creator, baseAmount, ammConfigIndex?, openTime? }    a Raydium CPMM pool whose deposits are in the clearing price's ratio
//   GET  /v1/crosses/:address/venues                                                             which venues the cross has opened, and which openings are available now
import type { FastifyInstance, FastifyReply } from 'fastify';
import { type Address, type Instruction, createNoopSigner, getAddressDecoder } from '@solana/kit';
import {
  CROSS_CORE_PROGRAM_ADDRESS,
  CROSS_DISCRIMINATOR,
  CrossState,
  SupplyMode,
  ata,
  readRuledCross,
  type CrossView,
} from '@opening-cross/sdk';
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
import { type Lifetime, RequestError, compile } from '../tx.js';
import { addr, bool, int, json, obj, only, opt, u64 } from './_inputs.js';
import { requireGraduationApproval } from './programs-support.js';
import { HEAVY_UNITS, type ReleaseGate, computeUnits, fits, releaseGate, requireInstruction, requireProgram } from './program-gate.js';

type ChainAccount = { data: Uint8Array; owner: Address };
export type SettleOpenDeps = {
  account: (a: Address) => Promise<ChainAccount | null>;
  lifetime: () => Promise<Lifetime>;
  /** `devnet` selects Raydium's devnet deployment; anything else, the mainnet one. */
  network?: string;
  /** Unix seconds; defaults to the wall clock. Tests inject one. */
  clock?: () => number;
  /** Replaces the release check (tests); by default the program's own bytes are read. */
  gate?: ReleaseGate;
};

const send = (reply: FastifyReply, v: unknown, status = 200) => reply.code(status).type('application/json').send(json(v));
const starts = (data: Uint8Array, prefix: ArrayLike<number>) => data.length >= prefix.length && Array.from(prefix).every((b, i) => data[i] === b);
const ZERO = '11111111111111111111111111111111' as Address;
/** Loaded on first use: the adapters package pulls in Meteora's SDK, which the rest of the API does not need. */
const adapters = () => import('@opening-cross/adapters');

/** A mint account's `COption<Pubkey>` mint authority (offset 0), or null. */
function mintAuthority(data: Uint8Array): Address | null {
  if (data.length < 36) return null;
  const v = new DataView(data.buffer, data.byteOffset);
  return v.getUint32(0, true) === 1 ? getAddressDecoder().decode(data.subarray(4, 36)) : null;
}

const U128_MAX = (1n << 128n) - 1n;
/** Liquidity in DAMM v2 is a u128 (Q64.64 scale): a decimal string. */
function u128(v: unknown, field: string): bigint {
  const s = typeof v === 'number' && Number.isSafeInteger(v) ? String(v) : v;
  if (typeof s !== 'string' || !/^\d{1,39}$/.test(s) || BigInt(s) > U128_MAX) throw new RequestError(400, `${field} must be an unsigned 128-bit integer (decimal string)`);
  return BigInt(s);
}

/** Design JSON may hold numbers, booleans, objects and arrays of them: every DBC enum is numeric, and a string would reach the SDK as a surprise. */
function plain(v: unknown, path: string, depth = 0): void {
  if (depth > 6) throw new RequestError(400, `${path} is nested too deeply`);
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new RequestError(400, `${path} must be a finite number`);
  } else if (typeof v === 'boolean') {
    // fine
  } else if (Array.isArray(v)) {
    v.forEach((x, i) => plain(x, `${path}[${i}]`, depth + 1));
  } else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) plain(x, `${path}.${k}`, depth + 1);
  } else {
    throw new RequestError(400, `${path} must be a number, a boolean, an object or an array (every enum in a curve design is a number)`);
  }
}

const DESIGN_KEYS = ['token', 'fee', 'migration', 'liquidityDistribution', 'lockedVesting', 'activationType', 'sqrtPriceMultiples', 'liquidityWeights', 'volatilityFee'] as const;
const DESIGN_REQUIRED = ['token', 'fee', 'migration', 'liquidityDistribution', 'lockedVesting', 'activationType', 'sqrtPriceMultiples'] as const;

export function registerSettleOpenTx(app: FastifyInstance, d: SettleOpenDeps): void {
  const now = () => BigInt(d.clock?.() ?? Math.floor(Date.now() / 1000));
  const gate = d.gate ?? releaseGate({ account: d.account, ...(d.clock && { clock: d.clock }) });
  const control = OPEN_DBC_POOL_DISCRIMINATOR as Uint8Array; // every cross_settle release has open_dbc_pool
  const need = (name: string, discriminator: Uint8Array) => requireInstruction(gate, CROSS_SETTLE_PROGRAM_ADDRESS, { name, discriminator }, control);

  async function readCross(a: Address): Promise<CrossView> {
    const acct = await d.account(a);
    if (!acct) throw new RequestError(404, `cross ${a} not found on chain`);
    if (acct.owner !== CROSS_CORE_PROGRAM_ADDRESS || !starts(acct.data, CROSS_DISCRIMINATOR)) throw new RequestError(404, `${a} is not an Opening Cross account`);
    return readRuledCross(a, acct.data);
  }
  const clearingPrice = (c: CrossView): bigint => {
    if (c.data.clearing.__option !== 'Some') throw new RequestError(409, c.data.state === CrossState.Live ? 'The cross has not settled yet.' : 'The cross did not print a price, so there is nothing to open a market at.', { reason: c.data.state === CrossState.Live ? 'LIVE' : 'NOT_CLEARED' });
    return c.data.clearing.value.price;
  };
  const byCreator = (c: CrossView, who: Address) => {
    if (who !== c.data.creator) throw new RequestError(422, `Only the cross's creator, ${c.data.creator}, can open its market.`, { reason: 'NOT_THE_CREATOR' });
  };
  const bound = (c: CrossView) => {
    if (!c.data.baseBound || c.data.baseMint === ZERO) throw new RequestError(409, 'The cross has no base mint yet: open and bind the DBC pool first.', { reason: 'NO_BASE_MINT' });
  };
  const absent = async (a: Address, what: string) => {
    if (await d.account(a)) throw new RequestError(409, `${what} exists already at ${a}.`, { reason: 'POOL_EXISTS', address: a });
  };
  /** A token account's balance; a missing account is a refusal that names it. */
  async function balance(owner: Address, mint: Address, tokenProgram: Address, role: string, need: bigint) {
    const account = await ata(owner, mint, tokenProgram);
    const a = await d.account(account);
    if (!a || a.data.length < 72) throw new RequestError(409, `${owner} has no ${role} token account (${account}); create it and fund it first.`, { reason: `NO_${role.toUpperCase()}_ACCOUNT`, account });
    const have = new DataView(a.data.buffer, a.data.byteOffset).getBigUint64(64, true);
    if (have < need) throw new RequestError(422, `${owner} holds ${have} of the ${role} token; the pool needs ${need}.`, { reason: `INSUFFICIENT_${role.toUpperCase()}`, have, need, account });
    return { account, have };
  }
  const issue = (status: 422, message: string, reason: string, issues: unknown[]) => new RequestError(status, message, { reason, issues });

  // ----------------------------------------------------------------------------------------------------------------- the DBC continuation
  function parseDesign(v: unknown) {
    const r = obj(v, 'design');
    only(r, DESIGN_KEYS, 'design');
    for (const k of DESIGN_REQUIRED) if (r[k] === undefined) throw new RequestError(400, `design.${k} is required`);
    plain(r, 'design');
    const { volatilityFee, ...rest } = r;
    return { rest, volatilityFee: volatilityFee === undefined ? null : obj(volatilityFee, 'design.volatilityFee') };
  }

  app.post('/v1/tx/open-dbc-pool', async (req, reply) => {
    const b = obj(req.body);
    only(b, ['cross', 'creator', 'design', 'name', 'symbol', 'uri', 'locked'], 'open-dbc-pool');
    const cross = await readCross(addr(b.cross, 'cross'));
    const creator = addr(b.creator, 'creator');
    const locked = b.locked === undefined ? true : bool(b.locked, 'locked');
    const text_ = (v: unknown, f: string, max: number) => {
      if (typeof v !== 'string' || v.length === 0 || v.length > max) throw new RequestError(400, `${f} must be a string of 1 to ${max} characters`);
      return v;
    };
    const name = text_(b.name, 'name', 32);
    const symbol = text_(b.symbol, 'symbol', 10);
    const uri = text_(b.uri, 'uri', 200);
    const parsed = parseDesign(b.design);
    byCreator(cross, creator);
    // `open_dbc_pool` itself is in every release, but its arguments changed (the config and the pool parameters are nested, W2D-D3) in the same build that added
    // `open_dbc_pool_locked`: an older program has the same instruction name and the old layout. The locked instruction is the mark of the new layout, so either
    // variant is refused unless it is there.
    const release = await need('open_dbc_pool_locked', OPEN_DBC_POOL_LOCKED_DISCRIMINATOR as Uint8Array);
    const price = clearingPrice(cross);
    if (cross.data.baseBound) throw new RequestError(409, 'The base mint is bound already: the DBC pool was opened.', { reason: 'ALREADY_BOUND' });
    const a = await import('@opening-cross/adapters');
    if (cross.data.supplyMode !== SupplyMode.DeferredMint || cross.data.settler.__option !== 'Some' || cross.data.settler.value !== (await a.settlerAddress(cross.address))) {
      throw new RequestError(422, 'This cross was not created for the DBC continuation: it must be a deferred-mint cross that names this adapter\'s settler.', { reason: 'WRONG_SETTLER' });
    }
    const addresses = await a.continuationAddresses(cross.address, cross.data.quoteMint);
    await absent(addresses.config, 'The DBC config');
    await requireProgram(d.account, a.DBC_PROGRAM_ADDRESS, 'Meteora Dynamic Bonding Curve');

    let design;
    try {
      design = { ...parsed.rest, ...(parsed.volatilityFee && { dynamicFee: a.volatilityFeeParams(parsed.volatilityFee as unknown as Parameters<typeof a.volatilityFeeParams>[0]) }) } as unknown as import('@opening-cross/adapters').ContinuationDesign;
    } catch (e) {
      throw new RequestError(422, `The curve design is not valid: ${(e as Error).message}`, { reason: 'DESIGN_INVALID' });
    }
    let built;
    try {
      built = await a.buildLaunchTransaction({ cross, creator: createNoopSigner(creator), design, name, symbol, uri, locked });
    } catch (e) {
      throw new RequestError(422, `The curve design is not valid: ${(e as Error).message}`, { reason: 'DESIGN_INVALID' });
    }
    const issues = a.checkLockedDesign(built.config);
    if (locked && issues.length > 0) {
      throw issue(422, `This design is not the locked, compounding design the program accepts for open_dbc_pool_locked: ${issues.map((i) => i.message).join(' ')}`, 'DESIGN_NOT_LOCKED', issues);
    }
    const [open, bind] = built.instructions;
    const cu = computeUnits(HEAVY_UNITS);
    // One atomic transaction when it fits (either both land or neither does, so no cross is left with a pool but no bound mint); two otherwise.
    let groups: Instruction[][];
    const joined = [cu, open, bind];
    groups = (() => {
      try {
        fits(creator, joined, 'DBC open and bind');
        return [joined];
      } catch {
        return [[cu, open], [cu, bind]];
      }
    })();
    const sizes = groups.map((g, i) => fits(creator, g, groups.length === 1 ? 'DBC open and bind' : i === 0 ? 'DBC open' : 'DBC bind'));
    const lifetime = await d.lifetime();
    return send(reply, {
      cross: cross.address,
      transactions: groups.map((g) => compile(creator, g, lifetime)),
      sizes,
      atomic: groups.length === 1,
      locked,
      clearingPrice: price,
      pool: addresses.pool,
      config: addresses.config,
      baseMint: addresses.baseMint,
      designIssues: issues,
      warnings: locked ? [] : ['This pool is opened with open_dbc_pool, not open_dbc_pool_locked: the program does not promise buyers that the opening liquidity stays locked.'],
      release,
    });
  });

  app.post('/v1/tx/bind-dbc-mint', async (req, reply) => {
    const b = obj(req.body);
    only(b, ['cross', 'payer'], 'bind-dbc-mint');
    const cross = await readCross(addr(b.cross, 'cross'));
    const payer = addr(b.payer, 'payer');
    const release = await need('bind_dbc_mint', BIND_DBC_MINT_DISCRIMINATOR as Uint8Array);
    if (cross.data.baseBound) throw new RequestError(409, 'The base mint is bound already.', { reason: 'ALREADY_BOUND' });
    const a = await import('@opening-cross/adapters');
    const mint = await d.account(await a.continuationMintAddress(cross.address));
    const settler = await a.settlerAddress(cross.address);
    const authority = mint ? mintAuthority(mint.data) : null;
    if (!mint || authority !== settler) {
      throw new RequestError(409, 'The DBC pool has not been opened for this cross: open-dbc-pool comes first.', { reason: 'POOL_NOT_OPENED' });
    }
    const ix = await a.buildBindDbcMint(cross, createNoopSigner(payer));
    fits(payer, [computeUnits(HEAVY_UNITS), ix], 'bind transaction');
    return send(reply, { ...compile(payer, [computeUnits(HEAVY_UNITS), ix], await d.lifetime()), release });
  });

  // ----------------------------------------------------------------------------------------------------------------- DAMM v2
  app.post('/v1/tx/seed-damm-v2', async (req, reply) => {
    const b = obj(req.body);
    only(b, ['cross', 'creator', 'baseAmount', 'quoteAmount', 'feeBps', 'collectFeeMode', 'compoundingFeeBps', 'batch', 'alphaVault', 'lock'], 'seed-damm-v2');
    const cross = await readCross(addr(b.cross, 'cross'));
    const creator = addr(b.creator, 'creator');
    const baseAmount = u64(b.baseAmount, 'baseAmount');
    const quoteAmount = u64(b.quoteAmount, 'quoteAmount');
    const feeBps = int(b.feeBps, 'feeBps', 10_000, 1);
    const collectFeeMode = opt(b.collectFeeMode, (v) => int(v, 'collectFeeMode', 2));
    const compoundingFeeBps = opt(b.compoundingFeeBps, (v) => int(v, 'compoundingFeeBps', 10_000, 1));
    const alphaVault = b.alphaVault === undefined ? false : bool(b.alphaVault, 'alphaVault');
    const batch = opt(b.batch, (v) => {
      const r = obj(v, 'batch');
      only(r, ['windowSecs', 'activationPoint', 'endingFeeBps', 'periods', 'periodSecs'], 'batch');
      return { windowSecs: int(r.windowSecs, 'batch.windowSecs', 2 ** 31 - 1), activationPoint: u64(r.activationPoint, 'batch.activationPoint'), endingFeeBps: int(r.endingFeeBps, 'batch.endingFeeBps', 10_000), periods: int(r.periods, 'batch.periods', 0xffff), periodSecs: int(r.periodSecs, 'batch.periodSecs', 2 ** 31 - 1) };
    });
    const lock = opt(b.lock, (v) => {
      const r = obj(v, 'lock');
      only(r, ['permanentLiquidity', 'vest'], 'lock');
      const vest = opt(r.vest, (x) => {
        const s = obj(x, 'lock.vest');
        only(s, ['vesting', 'cliffPoint', 'periodFrequency', 'cliffUnlockLiquidity', 'liquidityPerPeriod', 'numberOfPeriod'], 'lock.vest');
        return { vesting: addr(s.vesting, 'lock.vest.vesting'), schedule: { cliffPoint: u64(s.cliffPoint, 'lock.vest.cliffPoint'), periodFrequency: u64(s.periodFrequency, 'lock.vest.periodFrequency'), cliffUnlockLiquidity: u128(s.cliffUnlockLiquidity ?? '0', 'lock.vest.cliffUnlockLiquidity'), liquidityPerPeriod: u128(s.liquidityPerPeriod, 'lock.vest.liquidityPerPeriod'), numberOfPeriod: int(s.numberOfPeriod, 'lock.vest.numberOfPeriod', 0xffff, 1) } };
      });
      const permanent = r.permanentLiquidity === undefined ? null : r.permanentLiquidity === 'all' ? ('all' as const) : u128(r.permanentLiquidity, 'lock.permanentLiquidity');
      if (permanent === null && !vest) throw new RequestError(400, 'lock names neither permanentLiquidity nor vest');
      return { permanent, vest };
    });
    byCreator(cross, creator);
    const release = await need(batch ? 'seed_damm_v2_batched' : 'seed_damm_v2', (batch ? SEED_DAMM_V2_BATCHED_DISCRIMINATOR : SEED_DAMM_V2_DISCRIMINATOR) as Uint8Array);
    clearingPrice(cross);
    bound(cross);
    const graduation = await requireGraduationApproval(d.account, cross, 0);
    if (alphaVault && !batch) throw new RequestError(422, 'An Alpha Vault binding needs a batch start: before the start only the vault can buy, so there must be a start.', { reason: 'ALPHA_NEEDS_BATCH' });
    if (batch && collectFeeMode !== null && collectFeeMode !== 2) throw new RequestError(422, 'A batch-opened pool compounds its fees: collectFeeMode is 2 (or left out).', { reason: 'BatchNotCompounding' });
    const a = await import('@opening-cross/adapters');
    if (batch) {
      const issues = [...a.checkBatchStart({ now: now(), windowSecs: batch.windowSecs, activationPoint: batch.activationPoint }), ...a.checkBatchedPoolFee({ feeBps, endingFeeBps: batch.endingFeeBps, periods: batch.periods, periodSecs: batch.periodSecs })];
      if (issues.length > 0) throw issue(422, `The batch window is not one the program accepts: ${issues.map((i) => i.message).join(' ')}`, 'BATCH_INVALID', issues);
    }
    const c = cross.data;
    const addrs = await a.dammAddresses(cross.address, c.baseMint, c.quoteMint);
    await absent(addrs.pool, 'The DAMM v2 pool for these two mints');
    await requireProgram(d.account, a.DAMM_V2_PROGRAM_ADDRESS, 'Meteora DAMM v2');
    await balance(creator, c.baseMint, c.baseTokenProgram, 'base', baseAmount);
    await balance(creator, c.quoteMint, c.quoteTokenProgram, 'quote', quoteAmount);
    let seeded;
    try {
      seeded = await a.buildSeedDammV2({
        cross,
        creator: createNoopSigner(creator),
        baseAmount,
        quoteAmount,
        feeBps,
        ...(collectFeeMode !== null && { collectFeeMode }),
        ...(compoundingFeeBps !== null && { compoundingFeeBps }),
        ...(batch && { batch }),
        ...(alphaVault && { alphaVault }),
      });
    } catch (e) {
      throw new RequestError(422, (e as Error).message, { reason: 'POOL_INVALID' });
    }
    const after: Instruction[] = [];
    if (lock) {
      const permanent = lock.permanent === 'all' ? seeded.liquidity : lock.permanent;
      const vested = lock.vest ? a.vestingTotal(lock.vest.schedule) : 0n;
      if ((permanent ?? 0n) + vested > seeded.liquidity) {
        throw new RequestError(422, `The pool opens with ${seeded.liquidity} liquidity; ${(permanent ?? 0n) + vested} was asked to be locked.`, { reason: 'LOCK_OVER_LIQUIDITY', liquidity: seeded.liquidity });
      }
      if (permanent !== null && permanent > 0n) after.push(await a.buildLockDammPosition({ cross, creator: createNoopSigner(creator), liquidity: permanent }));
      if (lock.vest) after.push(await a.buildVestDammPosition({ cross, creator: createNoopSigner(creator), vesting: createNoopSigner(lock.vest.vesting), schedule: lock.vest.schedule }).catch((e: Error) => {
        throw new RequestError(422, e.message, { reason: 'LOCK_INVALID' });
      }));
    }
    const cu = computeUnits(HEAVY_UNITS);
    const joined = [cu, seeded.instruction, ...after];
    const groups: Instruction[][] = (() => {
      try {
        fits(creator, joined, 'pool seeding');
        return [joined];
      } catch (e) {
        // The seeding and the lock in one transaction lock liquidity from the pool's first block; when they do not fit, the lock follows in its own.
        if (after.length === 0) throw e;
        return [[cu, seeded.instruction], [cu, ...after]];
      }
    })();
    const sizes = groups.map((g) => fits(creator, g, 'pool seeding'));
    const lifetime = await d.lifetime();
    return send(reply, {
      cross: cross.address,
      transactions: groups.map((g) => compile(creator, g, lifetime)),
      sizes,
      atomic: groups.length === 1,
      pool: addrs.pool,
      position: addrs.position,
      positionNftMint: addrs.positionNftMint,
      liquidity: seeded.liquidity,
      ...(batch && { landBy: batch.activationPoint - BigInt(batch.windowSecs), note: 'The program refuses a start less than the window away when the transaction lands: send before landBy.' }),
      ...(graduation.governed && { graduation }), release,
    });
  });

  // ----------------------------------------------------------------------------------------------------------------- DLMM
  app.post('/v1/tx/open-dlmm-pair', async (req, reply) => {
    const b = obj(req.body);
    only(b, ['cross', 'creator', 'binStep', 'baseFactor', 'baseFeePowerFactor', 'batch', 'badges'], 'open-dlmm-pair');
    const cross = await readCross(addr(b.cross, 'cross'));
    const creator = addr(b.creator, 'creator');
    const binStep = int(b.binStep, 'binStep', 0xffff, 1);
    const baseFactor = int(b.baseFactor, 'baseFactor', 0xffff, 1);
    const baseFeePowerFactor = opt(b.baseFeePowerFactor, (v) => int(v, 'baseFeePowerFactor', 255));
    const batch = opt(b.batch, (v) => {
      const r = obj(v, 'batch');
      only(r, ['windowSecs', 'activationPoint', 'alphaVault'], 'batch');
      return { windowSecs: int(r.windowSecs, 'batch.windowSecs', 2 ** 31 - 1), activationPoint: u64(r.activationPoint, 'batch.activationPoint'), ...(r.alphaVault !== undefined && { alphaVault: bool(r.alphaVault, 'batch.alphaVault') }) };
    });
    const badges = opt(b.badges, (v) => {
      const r = obj(v, 'badges');
      only(r, ['base', 'quote'], 'badges');
      return { ...(r.base !== undefined && { base: bool(r.base, 'badges.base') }), ...(r.quote !== undefined && { quote: bool(r.quote, 'badges.quote') }) };
    });
    byCreator(cross, creator);
    const variant = badges ? ['open_dlmm_pair_badged', OPEN_DLMM_PAIR_BADGED_DISCRIMINATOR] as const : batch ? ['open_dlmm_pair_batched', OPEN_DLMM_PAIR_BATCHED_DISCRIMINATOR] as const : ['open_dlmm_pair', OPEN_DLMM_PAIR_DISCRIMINATOR] as const;
    const release = await need(variant[0], variant[1] as Uint8Array);
    clearingPrice(cross);
    bound(cross);
    const graduation = await requireGraduationApproval(d.account, cross, 1);
    const a = await import('@opening-cross/adapters');
    if (batch) {
      const issues = a.checkBatchStart({ now: now(), windowSecs: batch.windowSecs, activationPoint: batch.activationPoint });
      if (issues.length > 0) throw issue(422, `The batch window is not one the program accepts: ${issues.map((i) => i.message).join(' ')}`, 'BATCH_INVALID', issues);
    }
    const c = cross.data;
    const addrs = a.dlmmAddresses(c.baseMint, c.quoteMint);
    await absent(addrs.lbPair, 'The DLMM pair for these two mints');
    await requireProgram(d.account, a.DLMM_PROGRAM_ADDRESS, 'Meteora DLMM');
    if (badges) {
      for (const [role, wanted, mint] of [['base', badges.base, c.baseMint], ['quote', badges.quote, c.quoteMint]] as const) {
        if (!wanted) continue;
        const badge = a.dlmmTokenBadgeAddress(mint);
        const acct = await d.account(badge);
        if (!acct || acct.owner !== a.DLMM_PROGRAM_ADDRESS) {
          throw new RequestError(422, `The ${role} mint ${mint} has no Meteora Token Badge at ${badge}: only Meteora issues badges, and DLMM refuses a mint with these Token-2022 extensions without one.`, { reason: 'BADGE_MISSING', role, mint, badge });
        }
      }
    }
    let opened;
    try {
      opened = await a.buildOpenDlmmPair({
        cross,
        creator: createNoopSigner(creator),
        binStep,
        baseFactor,
        ...(baseFeePowerFactor !== null && { baseFeePowerFactor }),
        ...(batch && { batch }),
        ...(badges && { badges }),
      });
    } catch (e) {
      throw new RequestError(422, (e as Error).message, { reason: 'NO_BIN_FOR_PRICE', binStep });
    }
    const ixs = [computeUnits(HEAVY_UNITS), opened.instruction];
    const bytes = fits(creator, ixs, 'DLMM pair opening');
    return send(reply, {
      ...compile(creator, ixs, await d.lifetime()),
      bytes,
      cross: cross.address,
      lbPair: addrs.lbPair,
      activeId: opened.activeId,
      ...(batch && { landBy: batch.activationPoint - BigInt(batch.windowSecs), note: 'The program refuses a start less than the window away when the transaction lands: send before landBy.' }),
      ...(graduation.governed && { graduation }), release,
    });
  });

  // ----------------------------------------------------------------------------------------------------------------- Raydium CPMM
  app.post('/v1/tx/seed-raydium-cpmm', async (req, reply) => {
    const b = obj(req.body);
    only(b, ['cross', 'creator', 'baseAmount', 'ammConfigIndex', 'openTime'], 'seed-raydium-cpmm');
    const cross = await readCross(addr(b.cross, 'cross'));
    const creator = addr(b.creator, 'creator');
    const baseAmount = u64(b.baseAmount, 'baseAmount');
    if (baseAmount === 0n) throw new RequestError(400, 'baseAmount must be above zero');
    const ammConfigIndex = opt(b.ammConfigIndex, (v) => int(v, 'ammConfigIndex', 0xffff));
    const openTime = opt(b.openTime, (v) => u64(v, 'openTime'));
    byCreator(cross, creator);
    const release = await need('seed_raydium_cpmm', SEED_RAYDIUM_CPMM_DISCRIMINATOR as Uint8Array);
    clearingPrice(cross);
    bound(cross);
    const graduation = await requireGraduationApproval(d.account, cross, 2);
    const a = await import('@opening-cross/adapters');
    const deployment = d.network === 'devnet' ? a.RAYDIUM_DEVNET : a.RAYDIUM_MAINNET;
    const c = cross.data;
    let seeded;
    try {
      seeded = await a.buildSeedRaydiumCpmm({ cross, creator: createNoopSigner(creator), baseAmount, deployment, ...(ammConfigIndex !== null && { ammConfigIndex }), ...(openTime !== null && { openTime }) });
    } catch (e) {
      throw new RequestError(422, (e as Error).message, { reason: 'POOL_INVALID' });
    }
    if (seeded.quoteAmount === 0n) throw new RequestError(422, 'At the clearing price this base amount is worth less than one quote atom.', { reason: 'AMOUNT_TOO_SMALL' });
    await absent(seeded.addresses.pool, 'The Raydium CPMM pool for these two mints');
    await requireProgram(d.account, deployment.cpmmProgram, 'Raydium CPMM');
    await balance(creator, c.baseMint, c.baseTokenProgram, 'base', baseAmount);
    await balance(creator, c.quoteMint, c.quoteTokenProgram, 'quote', seeded.quoteAmount);
    const ixs = [computeUnits(HEAVY_UNITS), seeded.instruction];
    const bytes = fits(creator, ixs, 'Raydium pool seeding');
    return send(reply, { ...compile(creator, ixs, await d.lifetime()), bytes, cross: cross.address, pool: seeded.addresses.pool, quoteAmount: seeded.quoteAmount, ...(graduation.governed && { graduation }), release });
  });

  // ----------------------------------------------------------------------------------------------------------------- what a cross has opened
  app.get('/v1/crosses/:address/venues', async (req, reply) => {
    const cross = await readCross(addr((req.params as { address: string }).address, 'address'));
    const c = cross.data;
    const a = await import('@opening-cross/adapters');
    const cleared = c.clearing.__option === 'Some';
    const settlerOk = c.settler.__option === 'Some' && c.settler.value === (await a.settlerAddress(cross.address));
    const exists = async (addr_: Address, owner?: Address) => {
      const x = await d.account(addr_);
      return !!x && (owner === undefined || x.owner === owner);
    };
    const dbc = c.supplyMode === SupplyMode.DeferredMint && settlerOk ? await a.continuationAddresses(cross.address, c.quoteMint) : null;
    const hasBase = c.baseBound && c.baseMint !== ZERO;
    const damm = hasBase ? await a.dammAddresses(cross.address, c.baseMint, c.quoteMint) : null;
    const dlmm = hasBase ? a.dlmmAddresses(c.baseMint, c.quoteMint) : null;
    const deployment = d.network === 'devnet' ? a.RAYDIUM_DEVNET : a.RAYDIUM_MAINNET;
    const raydium = hasBase ? await a.raydiumAddresses(await a.raydiumAmmConfig(0, deployment), c.baseMint, c.quoteMint, deployment) : null;
    const venues = {
      dbc: dbc && { config: dbc.config, pool: dbc.pool, baseMint: dbc.baseMint, opened: await exists(dbc.config), bound: c.baseBound },
      dammV2: damm && { pool: damm.pool, position: damm.position, opened: await exists(damm.pool, a.DAMM_V2_PROGRAM_ADDRESS) },
      dlmm: dlmm && { lbPair: dlmm.lbPair, opened: await exists(dlmm.lbPair, a.DLMM_PROGRAM_ADDRESS) },
      raydiumCpmm: raydium && { pool: raydium.pool, opened: await exists(raydium.pool, deployment.cpmmProgram) },
    };
    const next: string[] = [];
    if (cleared && dbc && !venues.dbc!.opened && !c.baseBound) next.push('open-dbc-pool');
    else if (dbc && venues.dbc!.opened && !c.baseBound) next.push('bind-dbc-mint');
    if (cleared && hasBase) {
      if (!venues.dammV2!.opened) next.push('seed-damm-v2');
      if (!venues.dlmm!.opened) next.push('open-dlmm-pair');
      if (!venues.raydiumCpmm!.opened) next.push('seed-raydium-cpmm');
    }
    return send(reply, {
      cross: cross.address,
      state: CrossState[c.state],
      creator: c.creator,
      clearingPrice: cleared ? (c.clearing as { value: { price: bigint } }).value.price : null,
      baseBound: c.baseBound,
      deferredMintWithSettler: c.supplyMode === SupplyMode.DeferredMint && settlerOk,
      venues,
      available: next,
      note: cleared ? 'Only the cross creator can open a market. GET /v1/programs reports whether the deployed cross_settle has these instructions.' : 'The cross has not printed a price, so no market can be opened.',
    });
  });
}
