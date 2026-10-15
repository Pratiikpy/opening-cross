// Meteora pools around a cross: health, depth, routing and swaps (ADR-0920 to ADR-0924; rows D9, A10, X8, K5, Z1, W9).
//
// A cross prices an asset once. After it, the asset trades in the pools its issuer opens at the clearing price (DAMM v2, DLMM). This file reads
// those pools from chain, says how healthy they are, prices an order against them next to the cross and Jupiter, and builds the unsigned swap.
//
//   GET  /v1/pools/:address?base=<mint>             one pool: price, fee, depth at slippage limits, price impact of set sizes, the bin ladder of a DLMM pair, persistence
//   GET  /v1/pools?base=<mint>&quote=<mint>         the pools the adapters open for a pair, found at their canonical addresses
//   GET  /v1/pools/route?base&quote&side&amount     /v1/router/quote with the pools named that it read, and `pool=<address>` for a pool elsewhere (the router route itself now prices the canonical pools too)
//   GET  /v1/pools/by-cross/:address                the issuer's view: the cross's pools, how far each sits from the clearing price, how deep it is
//   GET  /v1/pools/summary                          the pools of the latest cleared crosses on one page (the dashboard's liquidity section)
//   GET  /v1/depth/cross/:address?sizes=            a cross's own depth and the price impact of orders of set sizes, beside the pools' slippage for the same sizes
//   POST /v1/pools/swap-tx                          { pool, owner, inputMint, amountIn, maxSlippageBps?, minimumAmountOut? }  an unsigned exact-input swap
//
// Everything is read from chain at the moment of the request, through the same account reader the rest of the API uses, and priced with the venues'
// own arithmetic (packages/adapters/src/health.ts). A pool the router cannot read or price is reported with the reason; nothing is defaulted.
// The API never holds a key: the swap comes back unsigned with the trader as fee payer.
import type { FastifyInstance, FastifyReply } from 'fastify';
import { type Address, type Instruction, createNoopSigner } from '@solana/kit';
import { getCreateAssociatedTokenIdempotentInstruction, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { getMintDecoder, TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import { CROSS_CORE_PROGRAM_ADDRESS, CROSS_DISCRIMINATOR, ata } from '@opening-cross/sdk';
import { getCrossDecoder } from '@opening-cross/cross-core-client';
import { type PoolRef, type PoolVenueQuote, type SerializedRanking, crossDepth, mergePoolsIntoRanking, quotePool } from '@opening-cross/router';
import { buildDammSwap, buildDlmmSwap, minimumOut } from '@opening-cross/liquidity';
import type { DammPool, DlmmBinArray, LbPairState, PoolEngine } from '@opening-cross/adapters';
import type { ApiDeps } from '../server.js';
import { type Lifetime, RequestError, compile } from '../tx.js';
import { addr, json, obj, only, opt, u64 } from './_inputs.js';
import { computeUnits, fits } from './program-gate.js';

type ChainAccount = { data: Uint8Array; owner: Address };
export type PoolsDeps = {
  account: (a: Address) => Promise<ChainAccount | null>;
  lifetime: () => Promise<Lifetime>;
  /** Only the cross index is read (for `summary`); a deployment without it still serves every other route. */
  db?: ApiDeps['db'];
  network?: string;
  /** Unix seconds; used only when the Clock sysvar cannot be read. Tests inject one. */
  clock?: () => number;
};
export type PoolsOptions = {
  /** Bin arrays read on each side of the active bin array of a DLMM pair. Default 4 (nine accounts, about 630 bins). */
  arraysEachSide?: number;
  /** How long `summary` is reused, in milliseconds. Default 60,000. */
  summaryTtlMs?: number;
  /** Samples kept per pool for persistence. Default 720. */
  maxSamples?: number;
};

const adapters = () => import('@opening-cross/adapters');
type Adapters = Awaited<ReturnType<typeof adapters>>;

const ZERO = '11111111111111111111111111111111' as Address;
const NATIVE_MINT = 'So11111111111111111111111111111111111111112' as Address;
const CLOCK = 'SysvarC1ock11111111111111111111111111111111' as Address;
const Q64 = 1n << 64n;
const send = (reply: FastifyReply, v: unknown, status = 200) => reply.code(status).type('application/json').send(json(v));
const starts = (data: Uint8Array, prefix: ArrayLike<number>) => data.length >= prefix.length && Array.from(prefix).every((b, i) => data[i] === b);

/** `1234500` atoms of a 6-decimal token as `1.2345`; trailing zeros are dropped. */
export function decimalOf(atoms: bigint, decimals: number, places = decimals): string {
  const neg = atoms < 0n;
  const a = neg ? -atoms : atoms;
  const unit = 10n ** BigInt(decimals);
  const whole = a / unit;
  let frac = (a % unit).toString().padStart(decimals, '0').slice(0, Math.max(0, places)).replace(/0+$/, '');
  if (places < decimals && frac === '' && a % unit !== 0n && places > 0) frac = '0';
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// What the chain says: time, mints, pools
// ---------------------------------------------------------------------------------------------------------------------------------------------

export type ChainTime = { slot: bigint | null; epoch: bigint | null; unixTimestamp: bigint; source: 'the Clock sysvar' | 'the API clock (the Clock sysvar could not be read)' };
export type MintFacts = {
  mint: Address;
  tokenProgram: Address;
  decimals: number;
  transferFee: { bps: number; maxFee: bigint } | null;
  extensions: string[];
  hasTransferHook: boolean;
  paused: boolean;
  supply: bigint;
};
type LoadedPool = {
  kind: 'dlmm' | 'damm-v2';
  address: Address;
  /** The engine as a trader meets it: token-2022 transfer fees of both mints applied. */
  engine: PoolEngine;
  tokenA: MintFacts;
  tokenB: MintFacts;
  status: { open: boolean; reason: string | null; opensAtPoint: bigint | null; pointUnit: 'slot' | 'timestamp' };
  dlmm: { pair: LbPairState; arrays: DlmmBinArray[]; indexesRead: number[] } | null;
  damm: { pool: DammPool } | null;
  sources: Address[];
  chain: ChainTime;
};

export type PoolPricing = {
  /**
   * Prices the pools the adapters open for a pair and merges them into a router ranking (what `GET /v1/router/quote` returns). A pool that cannot be
   * read, or a failure reading the chain, leaves the ranking as it was with the reason under `excluded`; it never fails the quote.
   */
  mergeInto(ranking: SerializedRanking, p: { base: Address; quote: Address; side: 'buy' | 'sell'; amount: bigint; baseDecimals: number }): Promise<SerializedRanking>;
};

export function registerPools(app: FastifyInstance, d: PoolsDeps, opts: PoolsOptions = {}): PoolPricing {
  const arraysEachSide = opts.arraysEachSide ?? 4;
  const maxSamples = opts.maxSamples ?? 720;
  const summaryTtl = opts.summaryTtlMs ?? 60_000;
  const wall = () => BigInt(d.clock?.() ?? Math.floor(Date.now() / 1000));
  const network = () => d.network ?? 'unknown';

  async function chainTime(a: Adapters): Promise<ChainTime> {
    try {
      const acct = await d.account(CLOCK);
      if (acct) {
        const c = a.decodeClock(acct.data);
        return { slot: c.slot, epoch: c.epoch, unixTimestamp: c.unixTimestamp, source: 'the Clock sysvar' };
      }
    } catch {
      // fall through to the API clock
    }
    return { slot: null, epoch: null, unixTimestamp: wall(), source: 'the API clock (the Clock sysvar could not be read)' };
  }

  async function readMint(mint: Address, epoch: bigint | null): Promise<MintFacts> {
    const acct = await d.account(mint);
    if (!acct) throw new RequestError(404, `mint ${mint} does not exist on this network`, { reason: 'MINT_NOT_FOUND', mint });
    if (acct.owner !== TOKEN_PROGRAM_ADDRESS && acct.owner !== TOKEN_2022_PROGRAM_ADDRESS) throw new RequestError(422, `${mint} is not a token mint`, { reason: 'NOT_A_MINT', mint });
    const m = getMintDecoder().decode(acct.data.length > 82 ? acct.data : acct.data.subarray(0, 82));
    const exts = m.extensions.__option === 'Some' ? m.extensions.value : [];
    let transferFee: MintFacts['transferFee'] = null;
    let hasTransferHook = false;
    let paused = false;
    for (const e of exts) {
      if (e.__kind === 'TransferFeeConfig') {
        const f = epoch !== null && epoch >= e.newerTransferFee.epoch ? e.newerTransferFee : e.olderTransferFee;
        if (f.transferFeeBasisPoints > 0) transferFee = { bps: f.transferFeeBasisPoints, maxFee: f.maximumFee };
      } else if (e.__kind === 'TransferHook' && e.programId !== ZERO) hasTransferHook = true;
      else if (e.__kind === 'PausableConfig' && e.paused) paused = true;
    }
    return { mint, tokenProgram: acct.owner, decimals: m.decimals, transferFee, extensions: exts.map((e) => e.__kind), hasTransferHook, paused, supply: m.supply };
  }

  /** A pool account that fails to decode is not the account it claims to be. */
  function decoding<T>(f: () => T, pool: Address): T {
    try {
      return f();
    } catch (e) {
      throw new RequestError(422, `${pool} could not be read as a Meteora pool: ${e instanceof Error ? e.message : String(e)}`, { reason: 'NOT_A_POOL', pool });
    }
  }

  async function loadPool(poolAddress: Address): Promise<LoadedPool> {
    const a = await adapters();
    const [acct, chain] = await Promise.all([d.account(poolAddress), chainTime(a)]);
    if (!acct) throw new RequestError(404, `no account at ${poolAddress}`, { reason: 'POOL_NOT_FOUND', pool: poolAddress });
    const kind = a.meteoraPoolKind(acct);
    if (!kind) throw new RequestError(422, `${poolAddress} is not a Meteora DAMM v2 pool or DLMM pair`, { reason: 'NOT_A_POOL', pool: poolAddress });
    const sources: Address[] = [poolAddress];
    const now = chain.unixTimestamp;

    if (kind === 'dlmm') {
      const pair = decoding(() => a.decodeLbPair(acct.data), poolAddress);
      const [tokenX, tokenY] = await Promise.all([readMint(pair.tokenXMint, chain.epoch), readMint(pair.tokenYMint, chain.epoch)]);
      const activeIdx = Math.floor(pair.activeId / a.DLMM_BINS_PER_ARRAY);
      const wanted: number[] = [];
      for (let i = activeIdx - arraysEachSide; i <= activeIdx + arraysEachSide; i++) wanted.push(i);
      const addrs = wanted.map((i) => a.binArrayAddress(poolAddress, i));
      const read = await Promise.all(addrs.map((x) => d.account(x)));
      const arrays: DlmmBinArray[] = [];
      const indexesRead: number[] = [];
      read.forEach((r, n) => {
        if (!r || r.owner !== a.DLMM_PROGRAM_ADDRESS) return;
        const decoded = a.decodeBinArray(r.data);
        if (decoded.lbPair !== poolAddress || decoded.index !== wanted[n]) return;
        arrays.push(decoded);
        indexesRead.push(decoded.index);
        sources.push(addrs[n]!);
      });
      const timeline = { slot: chain.slot ?? 0n, unixTimestamp: chain.unixTimestamp };
      let status = a.dlmmSwapStatus(pair, timeline);
      if (status.open && pair.activationType === 0 && chain.slot === null && (pair.pairType === 'permissioned' || pair.pairType === 'customizable-permissionless')) {
        status = { open: false, reason: 'whether the pair is open depends on the slot, which could not be read', opensAtPoint: pair.activationPoint, pointUnit: 'slot' };
      }
      const raw = a.dlmmEngine({ pair, arrays, nowSeconds: now });
      return withMintStatus({ kind, address: poolAddress, engine: a.withTransferFees(raw, tokenX.transferFee ?? undefined, tokenY.transferFee ?? undefined), tokenA: tokenX, tokenB: tokenY, status, dlmm: { pair, arrays, indexesRead }, damm: null, sources, chain });
    }

    const pool = decoding(() => a.decodeDammPool(acct.data), poolAddress);
    const [tokenA, tokenB] = await Promise.all([readMint(pool.tokenAMint.toBase58() as Address, chain.epoch), readMint(pool.tokenBMint.toBase58() as Address, chain.epoch)]);
    const point = pool.activationType === 0 ? chain.slot : chain.unixTimestamp;
    let status: LoadedPool['status'];
    if (point === null) status = { open: false, reason: 'whether the pool is open depends on the slot, which could not be read', opensAtPoint: BigInt(pool.activationPoint.toString(10)), pointUnit: 'slot' };
    else status = a.dammSwapStatus(pool, point);
    const raw = a.dammEngine({ pool, currentPoint: point ?? 0n, decimalsA: tokenA.decimals, decimalsB: tokenB.decimals });
    return withMintStatus({ kind, address: poolAddress, engine: a.withTransferFees(raw, tokenA.transferFee ?? undefined, tokenB.transferFee ?? undefined), tokenA, tokenB, status, dlmm: null, damm: { pool }, sources, chain });
  }

  /** A paused mint stops every transfer, so a pool that holds it cannot swap whatever the pool itself says. */
  function withMintStatus(p: LoadedPool): LoadedPool {
    const paused = [p.tokenA, p.tokenB].find((t) => t.paused);
    if (paused && p.status.open) return { ...p, status: { open: false, reason: `the issuer has paused transfers of ${paused.mint}`, opensAtPoint: null, pointUnit: p.status.pointUnit } };
    return p;
  }

  const refOf = (p: LoadedPool): PoolRef => ({ venue: p.kind === 'dlmm' ? 'meteora-dlmm' : 'meteora-damm-v2', pool: p.address, tokenA: p.tokenA.mint, tokenB: p.tokenB.mint, open: p.status.open, reason: p.status.reason, engine: p.engine });

  /** Which token is the base. Default: token A, the base of every pool the adapters open. */
  function orient(p: LoadedPool, base: Address | null): { base: MintFacts; quote: MintFacts; baseIsA: boolean } {
    if (base === null || base === p.tokenA.mint) return { base: p.tokenA, quote: p.tokenB, baseIsA: true };
    if (base === p.tokenB.mint) return { base: p.tokenB, quote: p.tokenA, baseIsA: false };
    throw new RequestError(400, `base ${base} is neither token of the pool (${p.tokenA.mint}, ${p.tokenB.mint})`, { reason: 'BASE_NOT_IN_POOL' });
  }

  // ---------------------------------------------------------------------------------------------------------------------------------------
  // Health
  // ---------------------------------------------------------------------------------------------------------------------------------------
  const samples = new Map<string, { baseSize: bigint; quoteSize: bigint; points: { timestamp: number; sell: bigint; buy: bigint }[] }>();

  /** The price of one whole base token in quote atoms, and as a decimal in quote units, from the pool's mid price. */
  function priceOf(p: LoadedPool, o: ReturnType<typeof orient>) {
    const mid = p.engine.midQ64;
    const perAtomQ64 = o.baseIsA ? mid : mid === 0n ? 0n : (Q64 * Q64) / mid; // quote atoms per base atom, Q64.64
    const unit = 10n ** BigInt(o.base.decimals);
    const atomsPerWhole = (perAtomQ64 * unit) / Q64;
    const fine = (perAtomQ64 * unit * 10n ** 9n) / Q64; // 1e-9 of a quote atom per whole base
    return { quoteAtomsPerWholeBase: atomsPerWhole, quotePerBase: decimalOf(fine, o.quote.decimals + 9, 9), perAtomQ64 };
  }

  function feeInfo(a: Adapters, p: LoadedPool) {
    if (p.dlmm) {
      const s = p.dlmm.pair;
      return {
        kind: 'dlmm' as const,
        baseFeeBps: Number(a.dlmmFeeRate({ binStep: s.binStep, params: { ...s.params, variableFeeControl: 0 } }, 0)) / 100_000,
        variableFee: s.params.variableFeeControl > 0 ? 'yes: it rises with volatility and is charged per bin' : 'no',
        binStepBps: s.binStep,
        collects: s.params.collectFeeMode === 0 ? 'fee on the input token' : 'fee on token Y only',
        protocolSharePercent: s.params.protocolShare / 100,
      };
    }
    const pool = p.damm!.pool;
    const cliff = Buffer.from(pool.poolFees.baseFee.baseFeeInfo.data as number[]).readBigUInt64LE(0);
    return {
      kind: 'damm-v2' as const,
      cliffFeeBps: Number(cliff) / 100_000,
      dynamicFee: pool.poolFees.dynamicFee.initialized === 1,
      collects: ['both tokens', 'token B only', 'compounding into the pool'][pool.collectFeeMode] ?? 'unknown',
      protocolFeePercent: pool.poolFees.protocolFeePercent,
    };
  }

  async function health(p: LoadedPool, o: ReturnType<typeof orient>, a: Adapters) {
    const h = a.engineHealth(p.engine);
    const price = priceOf(p, o);
    const side = (aToB: boolean) => (aToB ? 'sellA' : 'sellB') as 'sellA' | 'sellB';
    const sellBase = side(o.baseIsA);
    const buyBase = side(!o.baseIsA);
    const baseReserve = o.baseIsA ? p.engine.reserveA : p.engine.reserveB;
    const quoteReserve = o.baseIsA ? p.engine.reserveB : p.engine.reserveA;
    const tvlInQuote = o.baseIsA ? h.tvlInB : p.engine.reserveA + (p.engine.reserveB * Q64) / (p.engine.midQ64 === 0n ? 1n : p.engine.midQ64);
    const depth = h.depth.map((row) => ({
      maxSlippageBps: row.maxSlippageBps,
      sellBase: { maxBaseIn: row[sellBase].maxIn, quoteOut: row[sellBase].out, slippageBps: row[sellBase].slippageBps },
      buyBase: { maxQuoteIn: row[buyBase].maxIn, baseOut: row[buyBase].out, slippageBps: row[buyBase].slippageBps },
    }));
    const tenthsOfPercent = [1n, 5n, 10n, 50n, 100n, 500n]; // 0.1%, 0.5%, 1%, 5%, 10% and 50% of the reserve sold
    const impactOf = (aToB: boolean, reserve: bigint) =>
      reserve === 0n
        ? []
        : tenthsOfPercent.map((tenths) => {
            const amountIn = (reserve * tenths) / 1000n;
            if (amountIn === 0n) return null;
            const r = p.engine.swap(aToB, amountIn);
            return { percentOfReserve: Number(tenths) / 10, amountIn, out: r.out, slippageBps: a.engineSlippageBps(p.engine, aToB, amountIn), partial: r.partial || r.consumed < amountIn };
          }).filter((x): x is NonNullable<typeof x> => x !== null);
    // The size a trader sells is measured against the reserve of the token they sell: base reserve for a sell, quote reserve for a buy.
    const impact = { sellBase: impactOf(o.baseIsA, baseReserve), buyBase: impactOf(!o.baseIsA, quoteReserve) };

    // Persistence: a sample on each read, at most one every 20 s; the target is one percent of the reserve the pool had when first seen.
    const nowSec = Number(p.chain.unixTimestamp);
    const at100 = depth.find((r) => r.maxSlippageBps === 100n)!;
    let entry = samples.get(p.address);
    if (!entry) {
      entry = { baseSize: baseReserve / 100n, quoteSize: quoteReserve / 100n, points: [] };
      samples.set(p.address, entry);
    }
    const last = entry.points.at(-1);
    if (!last || nowSec - last.timestamp >= 20) {
      entry.points.push({ timestamp: nowSec, sell: at100.sellBase.maxBaseIn, buy: at100.buyBase.maxQuoteIn });
      if (entry.points.length > maxSamples) entry.points.shift();
    }
    const span = entry.points.length > 1 ? entry.points.at(-1)!.timestamp - entry.points[0]!.timestamp : 0;
    const persistence =
      entry.points.length >= 3 && span >= 60
        ? {
            window: 'since this API process first read the pool; it restarts with the process',
            observedSeconds: span,
            samples: entry.points.length,
            limitBps: 100,
            sizeRule: 'one percent of the pool’s reserve of the token sold, as it was when first read',
            sellBaseShare: a.depthPersistence(entry.points.map((x) => ({ timestamp: x.timestamp, maxIn: x.sell })), entry.baseSize),
            buyBaseShare: a.depthPersistence(entry.points.map((x) => ({ timestamp: x.timestamp, maxIn: x.buy })), entry.quoteSize),
          }
        : { window: 'not enough observations yet: needs three reads at least a minute apart', observedSeconds: span, samples: entry.points.length };

    const ladder = p.dlmm
      ? a.dlmmLadder({ pair: p.dlmm.pair, arrays: p.dlmm.arrays, binsEachSide: 40 }).map((b) => ({
          binId: b.binId,
          role: b.role,
          quoteAtomsPerBaseAtomQ64: b.priceQ64,
          amountX: b.amountX,
          amountY: b.amountY,
          orderAmount: b.orderAmount,
          orderSide: b.orderSide,
          cumulativeX: b.cumulativeX,
          cumulativeY: b.cumulativeY,
        }))
      : null;
    const hook = [p.tokenA, p.tokenB].find((t) => t.hasTransferHook);
    const swapTx = hook && p.kind === 'dlmm' ? { supported: false, reason: `${hook.mint} has a transfer hook, whose accounts a DLMM swap must name; this API does not build that swap` } : [p.tokenA, p.tokenB].some((t) => t.mint === NATIVE_MINT) ? { supported: false, reason: 'native SOL must be wrapped before it can be swapped; wrapping is not part of this swap' } : { supported: p.status.open, reason: p.status.reason };
    const caveats = [
      'Every figure is computed from the pool’s accounts as they are now, with the venue’s own swap arithmetic; any trade in the pool changes it.',
      'Slippage is measured against the pool’s mid price and includes the pool’s fee.',
      ...(p.dlmm ? [`Only the ${p.dlmm.indexesRead.length} bin arrays read (indexes ${p.dlmm.indexesRead.join(', ') || 'none'}) are counted; liquidity in bins outside them is not.`] : []),
      ...[p.tokenA, p.tokenB].filter((t) => t.transferFee).map((t) => `${t.mint} charges a token-2022 transfer fee of ${t.transferFee!.bps} bps (at most ${t.transferFee!.maxFee} atoms); the figures are net of it.`),
      ...[p.tokenA, p.tokenB].filter((t) => t.extensions.includes('ScaledUiAmountConfig')).map((t) => `${t.mint} shows balances scaled by a multiplier; every amount here is raw atoms.`),
    ];
    return {
      schema: 'opening-cross/pool-health/v1',
      network: network(),
      at: new Date(Number(p.chain.unixTimestamp) * 1000).toISOString(),
      chain: p.chain,
      pool: p.address,
      kind: p.kind,
      orientation: o.baseIsA ? 'the base is token A of the pool (token X of a DLMM pair)' : 'the base is token B of the pool (token Y of a DLMM pair)',
      baseIsA: o.baseIsA,
      base: tokenView(o.base, baseReserve),
      quote: tokenView(o.quote, quoteReserve),
      status: p.status,
      price: { quoteAtomsPerWholeBase: price.quoteAtomsPerWholeBase, quotePerBase: price.quotePerBase, source: p.dlmm ? `active bin ${p.dlmm.pair.activeId} (bin step ${p.dlmm.pair.binStep} bps)` : 'the pool’s sqrt price' },
      fee: feeInfo(a, p),
      liquidity: { baseReserve, quoteReserve, tvlInQuote, counted: p.dlmm ? `bins ${Math.min(...p.dlmm.indexesRead) * 70} to ${Math.max(...p.dlmm.indexesRead) * 70 + 69}` : 'the whole price range of the pool' },
      depth,
      impact,
      ladder,
      persistence,
      swapTx,
      sources: p.sources,
      caveats,
    };
  }
  const tokenView = (m: MintFacts, reserve: bigint) => ({ mint: m.mint, decimals: m.decimals, tokenProgram: m.tokenProgram, reserve, transferFee: m.transferFee, extensions: m.extensions, paused: m.paused });

  /** The compact form: what a list, the dashboard or the issuer view shows for each pool. */
  function summary(p: LoadedPool, o: ReturnType<typeof orient>, a: Adapters) {
    const sell = a.engineDepth(p.engine, o.baseIsA, 100n);
    const buy = a.engineDepth(p.engine, !o.baseIsA, 100n);
    const price = priceOf(p, o);
    const baseReserve = o.baseIsA ? p.engine.reserveA : p.engine.reserveB;
    const quoteReserve = o.baseIsA ? p.engine.reserveB : p.engine.reserveA;
    return {
      pool: p.address,
      kind: p.kind,
      status: p.status,
      baseMint: o.base.mint,
      quoteMint: o.quote.mint,
      quotePerBase: price.quotePerBase,
      quoteAtomsPerWholeBase: price.quoteAtomsPerWholeBase,
      baseReserve,
      quoteReserve,
      tvlInQuote: quoteReserve + (baseReserve * price.perAtomQ64) / Q64,
      depthAt100bps: { sellBase: { maxBaseIn: sell.maxIn, quoteOut: sell.out }, buyBase: { maxQuoteIn: buy.maxIn, baseOut: buy.out } },
      fee: feeInfo(a, p),
    };
  }

  const baseQuery = (v: unknown, field: string) => (v === undefined ? null : addr(v, field));

  app.get('/v1/pools/:address', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const pool = addr((req.params as { address: string }).address, 'address');
    const base = baseQuery(q.base, 'base');
    const a = await adapters();
    const p = await loadPool(pool);
    return send(reply, await health(p, orient(p, base), a));
  });

  // ---------------------------------------------------------------------------------------------------------------------------------------
  // Discovery
  // ---------------------------------------------------------------------------------------------------------------------------------------
  /** The pools the adapters open for a pair, at the addresses they open them: the customizable DAMM v2 pool and the DLMM pair of the base and quote mints. Others exist for most pairs and cannot be listed without scanning the programs; `pool=` names one. */
  async function discover(base: Address, quote: Address, extra: Address[] = []) {
    const a = await adapters();
    const candidates: { kind: 'damm-v2' | 'dlmm'; address: Address }[] = [
      { kind: 'damm-v2', address: a.dammCanonicalPool(base, quote) },
      { kind: 'dlmm', address: a.dlmmCanonicalPair(base, quote) },
    ];
    for (const x of extra) if (!candidates.some((c) => c.address === x)) candidates.push({ kind: 'dlmm', address: x }); // the kind is re-read from the account
    const found: LoadedPool[] = [];
    const absent: { kind: string; address: Address }[] = [];
    const failed: { address: Address; reason: string }[] = [];
    await Promise.all(
      candidates.map(async (c) => {
        try {
          found.push(await loadPool(c.address));
        } catch (e) {
          if (e instanceof RequestError && e.status === 404) absent.push({ kind: c.kind, address: c.address });
          else if (e instanceof RequestError) failed.push({ address: c.address, reason: e.message });
          else throw e;
        }
      }),
    );
    found.sort((x, y) => (x.address < y.address ? -1 : 1));
    return { found, absent, failed };
  }
  const DISCOVERY_NOTE = 'Pools are looked for at the addresses the Opening Cross adapters create them at (the customizable DAMM v2 pool and the DLMM pair of the two mints). Other pools for the same pair may exist; name one with pool=<address>.';

  function pair(q: Record<string, string | undefined>) {
    const base = addr(q.base, 'base');
    const quote = addr(q.quote, 'quote');
    if (base === quote) throw new RequestError(400, 'base and quote must be different mints');
    return { base, quote };
  }

  app.get('/v1/pools', async (req, reply) => {
    const { base, quote } = pair(req.query as Record<string, string | undefined>);
    const a = await adapters();
    const { found, absent, failed } = await discover(base, quote);
    const rows = found.filter((p) => [p.tokenA.mint, p.tokenB.mint].includes(base) && [p.tokenA.mint, p.tokenB.mint].includes(quote)).map((p) => summary(p, orient(p, base), a));
    return send(reply, { schema: 'opening-cross/pools/v1', network: network(), base, quote, discovery: DISCOVERY_NOTE, pools: rows, absent, failed });
  });

  // ---------------------------------------------------------------------------------------------------------------------------------------
  // Routing
  // ---------------------------------------------------------------------------------------------------------------------------------------
  /** The 404 an unmounted route gives, as opposed to a 404 the route itself returns. */
  const routeAbsent = (body: string) => {
    try {
      const j = JSON.parse(body) as { error?: string; message?: string };
      return j.error === 'no such route' || (typeof j.message === 'string' && j.message.startsWith('Route GET:'));
    } catch {
      return false;
    }
  };

  app.get('/v1/pools/route', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const { base, quote } = pair(q);
    if (q.side !== 'buy' && q.side !== 'sell') throw new RequestError(400, 'side must be "buy" or "sell"');
    const side = q.side;
    const amount = u64(q.amount, 'amount');
    if (amount === 0n) throw new RequestError(400, 'amount must be at least 1 base atom');
    const named = q.pool === undefined ? [] : [addr(q.pool, 'pool')];
    // The cross and Jupiter legs are the router's own answer; the pools are priced here and merged into it.
    const inner = await app.inject({ method: 'GET', url: `/v1/router/quote?base=${base}&quote=${quote}&side=${side}&amount=${amount}&pools=0` });
    let ranking: SerializedRanking;
    let envelope: Record<string, unknown> = {};
    if (inner.statusCode === 404 && routeAbsent(inner.body)) {
      ranking = { venues: [], excluded: [{ venue: 'cross', reason: 'the cross/Jupiter router is not enabled on this deployment' }], best: null, caveats: ['This is a quote comparison only. Nothing is signed or sent.'] };
    } else if (inner.statusCode !== 200) {
      // The router refused the pair (a mint that does not exist, a token program it cannot read): the same refusal applies here.
      return reply.code(inner.statusCode).type('application/json').send(inner.body);
    } else {
      const { venues, excluded, best, caveats, ...rest } = JSON.parse(inner.body) as SerializedRanking & Record<string, unknown>;
      ranking = { venues, excluded, best, caveats };
      envelope = rest;
    }
    const a = await adapters();
    const { found, absent } = await discover(base, quote, named);
    const ofPair = found.filter((p) => [p.tokenA.mint, p.tokenB.mint].includes(base) && [p.tokenA.mint, p.tokenB.mint].includes(quote));
    const baseDecimals = (ofPair[0] ? orient(ofPair[0], base).base.decimals : null) ?? (envelope.base as { decimals?: number } | undefined)?.decimals ?? (await readMint(base, null)).decimals;
    const quotes: PoolVenueQuote[] = found.map((p) => quotePool(refOf(p), base, quote, baseDecimals, { side, quantity: amount }));
    const merged = mergePoolsIntoRanking(ranking, quotes, side);
    return send(reply, {
      schema: 'opening-cross/router-quote/v1',
      network: network(),
      ...envelope,
      intent: { base, quote, side, amount },
      base: { decimals: baseDecimals },
      priceUnit: 'quote atoms per one whole base token',
      ...merged,
      pools: { discovery: DISCOVERY_NOTE, read: found.map((p) => ({ pool: p.address, kind: p.kind, sources: p.sources })), absent },
      chain: found[0]?.chain ?? (await chainTime(a)),
    });
  });

  // ---------------------------------------------------------------------------------------------------------------------------------------
  // The issuer's view of a cross's liquidity (A10) and the dashboard's summary
  // ---------------------------------------------------------------------------------------------------------------------------------------
  async function readCross(address: Address) {
    const acct = await d.account(address);
    if (!acct) throw new RequestError(404, `cross ${address} not found on chain`, { reason: 'CROSS_NOT_FOUND' });
    if (acct.owner !== CROSS_CORE_PROGRAM_ADDRESS || !starts(acct.data, CROSS_DISCRIMINATOR)) throw new RequestError(404, `${address} is not an Opening Cross account`, { reason: 'NOT_A_CROSS' });
    return getCrossDecoder().decode(acct.data);
  }

  app.get('/v1/pools/by-cross/:address', async (req, reply) => {
    const crossAddress = addr((req.params as { address: string }).address, 'address');
    const c = await readCross(crossAddress);
    const a = await adapters();
    const state = (['Live', 'Cleared', 'NoPrint', 'Finalized'] as const)[c.state] ?? 'Live';
    const cleared = c.clearing.__option === 'Some' ? c.clearing.value : null;
    const cross = {
      address: crossAddress,
      state,
      creator: c.creator,
      baseMint: c.baseBound ? c.baseMint : null,
      quoteMint: c.quoteMint,
      priceScale: c.priceScale,
      clearingPrice: cleared?.price ?? null,
      matched: cleared?.matched ?? null,
    };
    if (!c.baseBound || c.baseMint === ZERO) {
      return send(reply, { schema: 'opening-cross/issuer-liquidity/v1', network: network(), cross, pools: [], absent: [], note: 'The cross has no base mint yet, so there is no market to look at.', discovery: DISCOVERY_NOTE });
    }
    const { found, absent, failed } = await discover(c.baseMint, c.quoteMint);
    const rows = found.map((p) => {
      const o = orient(p, c.baseMint);
      const s = summary(p, o, a);
      // The pool is seeded at the clearing price: quote atoms per base atom is price / priceScale. How far its price has moved since is what an issuer watches first.
      const price = priceOf(p, o);
      let deviationBps: bigint | null = null;
      if (cleared && cleared.price > 0n) {
        const poolQ = price.perAtomQ64; // quote atoms per base atom, Q64.64
        const clearQ = (cleared.price * Q64) / c.priceScale;
        const diff = poolQ - clearQ;
        deviationBps = diff >= 0n ? (diff * 10_000n + clearQ / 2n) / clearQ : -((-diff * 10_000n + clearQ / 2n) / clearQ);
      }
      const ladder = p.dlmm ? a.dlmmLadder({ pair: p.dlmm.pair, arrays: p.dlmm.arrays, binsEachSide: 140 }).filter((b) => b.role === 'ask') : null;
      return {
        ...s,
        movedFromClearingBps: deviationBps,
        askLadder: ladder ? { bins: ladder.length, baseOffered: ladder.at(-1)?.cumulativeX ?? 0n, fromBin: ladder[0]?.binId ?? null, toBin: ladder.at(-1)?.binId ?? null } : null,
      };
    });
    return send(reply, {
      schema: 'opening-cross/issuer-liquidity/v1',
      network: network(),
      cross,
      pools: rows,
      absent,
      failed,
      discovery: DISCOVERY_NOTE,
      note: rows.length === 0 ? 'No pool was found at the addresses the adapters open. The cross may not have opened its market yet, or the market is in a pool elsewhere.' : null,
    });
  });

  let summaryCache: { at: number; value: Promise<unknown> } | null = null;
  app.get('/v1/pools/summary', async (_req, reply) => {
    if (!d.db) throw new RequestError(404, 'the cross index is not available on this deployment');
    const db = d.db;
    if (!summaryCache || Date.now() - summaryCache.at > summaryTtl) {
      const value = (async () => {
        const a = await adapters();
        const { rows } = await db.query(
          `SELECT address, COALESCE(base_bound_mint, base_mint) AS base_mint, quote_mint, clearing_price, close_ts
             FROM crosses WHERE state IN ('Cleared', 'Finalized') ORDER BY close_ts DESC LIMIT 12`,
        );
        const seen = new Set<string>();
        const pairs = (rows as { address: string; base_mint: string; quote_mint: string; clearing_price: string | null }[]).filter((r) => {
          const key = `${r.base_mint}/${r.quote_mint}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        // The pairs are read together: the dashboard gives a section a few seconds, and each pair is several account reads.
        const perPair = await Promise.all(
          pairs.map(async (r) => {
            try {
              const { found } = await discover(r.base_mint as Address, r.quote_mint as Address);
              return found.map((p) => ({ cross: r.address, clearingPrice: r.clearing_price, ...summary(p, orient(p, r.base_mint as Address), a) }));
            } catch {
              return []; // one pair that cannot be read does not hide the others; it simply has no row
            }
          }),
        );
        const out = perPair.flat();
        const scanned = pairs.length;
        return { schema: 'opening-cross/pools-summary/v1', network: network(), pairsScanned: scanned, pools: out, discovery: DISCOVERY_NOTE };
      })();
      summaryCache = { at: Date.now(), value };
      value.catch(() => {
        summaryCache = null;
      });
    }
    return send(reply, await summaryCache.value);
  });

  // ---------------------------------------------------------------------------------------------------------------------------------------
  // A cross's own depth, beside the pools (X8)
  // ---------------------------------------------------------------------------------------------------------------------------------------
  app.get('/v1/depth/cross/:address', async (req, reply) => {
    const crossAddress = addr((req.params as { address: string }).address, 'address');
    const q = req.query as Record<string, string | undefined>;
    let sizes: bigint[] | undefined;
    if (q.sizes !== undefined) {
      const parts = q.sizes.split(',');
      if (parts.length === 0 || parts.length > 12) throw new RequestError(400, 'sizes must hold one to twelve base amounts, comma separated');
      sizes = parts.map((s) => u64(s.trim(), 'sizes'));
      if (sizes.some((s) => s === 0n)) throw new RequestError(400, 'every size must be at least 1 base atom');
    }
    const depth = await crossDepth(d.account, crossAddress, sizes ? { sizes } : {});
    if (!depth.available) throw new RequestError(404, depth.reason, { reason: 'CROSS_NOT_FOUND' });
    // The pools of the pair, priced for the same sizes, so the cross and the pool can be read side by side.
    let pools: unknown[] = [];
    let poolNote: string | null = null;
    const c = await readCross(crossAddress);
    if (c.baseBound && c.baseMint !== ZERO) {
      const { found } = await discover(c.baseMint, c.quoteMint);
      const sizeList = sizes ?? [...new Set(depth.impact.map((r) => r.size))];
      pools = found.map((p) => {
        const o = orient(p, c.baseMint);
        const rows = sizeList.flatMap((size) =>
          (['buy', 'sell'] as const).map((side) => {
            const r = quotePool(refOf(p), c.baseMint, c.quoteMint, o.base.decimals, { side, quantity: size });
            return r.available ? { side, size, pricePerBase: r.pricePerBase, slippageBps: r.slippageBps, partial: r.partial, quote: r.quote, base: r.base } : { side, size, unavailable: r.reason };
          }),
        );
        return { pool: p.address, kind: p.kind, status: p.status, rows };
      });
      if (pools.length === 0) poolNote = 'No pool was found at the addresses the adapters open for this pair.';
    } else poolNote = 'The cross has no base mint yet.';
    return send(reply, {
      ...depth,
      schema: 'opening-cross/cross-depth/v1',
      network: network(),
      market: { baseMint: c.baseBound && c.baseMint !== ZERO ? c.baseMint : null, quoteMint: c.quoteMint, baseDecimals: c.baseDecimals, quoteDecimals: c.quoteDecimals },
      priceUnit: 'cross price units: quote atoms per priceScale base atoms; pool prices are quote atoms per one whole base token',
      pools,
      poolNote,
      notes: [
        'A cross has no marginal price: its price impact is how much an extra order of the size moves the clearing price, found by running the clearing rule on the live book with and without the order.',
        'A pool’s slippage is the worse price a trade of the size gets against the pool’s mid price, fee included. The two are different quantities and are shown side by side, not as one number.',
      ],
    });
  });

  // ---------------------------------------------------------------------------------------------------------------------------------------
  // Swap
  // ---------------------------------------------------------------------------------------------------------------------------------------
  const SWAP_KEYS = ['pool', 'owner', 'inputMint', 'amountIn', 'maxSlippageBps', 'minimumAmountOut'] as const;
  app.post('/v1/pools/swap-tx', async (req, reply) => {
    const b = obj(req.body);
    only(b, SWAP_KEYS, 'swap');
    const poolAddress = addr(b.pool, 'pool');
    const owner = addr(b.owner, 'owner');
    const inputMint = addr(b.inputMint, 'inputMint');
    const amountIn = u64(b.amountIn, 'amountIn');
    if (amountIn === 0n) throw new RequestError(400, 'amountIn must be at least 1 atom');
    const toleranceBps = opt(b.maxSlippageBps, (x) => {
      if (typeof x !== 'number' || !Number.isInteger(x) || x < 0 || x > 5000) throw new RequestError(400, 'maxSlippageBps must be a whole number of basis points from 0 to 5,000');
      return x;
    }) ?? 50;
    const explicitMin = opt(b.minimumAmountOut, (x) => u64(x, 'minimumAmountOut'));

    const p = await loadPool(poolAddress);
    if (inputMint !== p.tokenA.mint && inputMint !== p.tokenB.mint) throw new RequestError(400, `inputMint must be one of the pool's tokens (${p.tokenA.mint}, ${p.tokenB.mint})`, { reason: 'INPUT_NOT_IN_POOL' });
    if (!p.status.open) throw new RequestError(409, `The pool cannot be swapped in now: ${p.status.reason ?? 'it is closed'}.`, { reason: 'POOL_CLOSED', opensAtPoint: p.status.opensAtPoint, pointUnit: p.status.pointUnit });
    for (const t of [p.tokenA, p.tokenB]) {
      if (t.mint === NATIVE_MINT) throw new RequestError(422, 'Native SOL must be wrapped before it can be swapped, and this swap does not wrap it. Wrap it to a token account first.', { reason: 'NATIVE_MINT' });
      if (t.hasTransferHook && p.kind === 'dlmm') throw new RequestError(422, `${t.mint} has a transfer hook, whose accounts a DLMM swap must name; this API does not build that swap.`, { reason: 'TRANSFER_HOOK' });
    }
    const aToB = inputMint === p.tokenA.mint;
    const tokenIn = aToB ? p.tokenA : p.tokenB;
    const tokenOut = aToB ? p.tokenB : p.tokenA;
    const quote = p.engine.swap(aToB, amountIn);
    if (quote.partial || quote.consumed < amountIn) {
      throw new RequestError(409, 'The pool cannot take this much in one swap.', { reason: 'POOL_CANNOT_ABSORB', consumable: quote.consumed, requested: amountIn });
    }
    if (quote.out === 0n) throw new RequestError(409, 'The pool would return nothing for an amount this small.', { reason: 'AMOUNT_TOO_SMALL' });
    const minOut = explicitMin ?? minimumOut(quote.out, toleranceBps);
    if (minOut > quote.out) throw new RequestError(409, `minimumAmountOut ${minOut} is more than the ${quote.out} the pool returns now, so the swap would fail.`, { reason: 'MINIMUM_ABOVE_QUOTE', expectedOut: quote.out });

    // The trader must hold what they sell.
    const inputAccount = await ata(owner, tokenIn.mint, tokenIn.tokenProgram);
    const held = await d.account(inputAccount);
    if (!held || held.data.length < 72) throw new RequestError(409, `${owner} has no token account for ${tokenIn.mint} (${inputAccount}), so there is nothing to sell.`, { reason: 'NO_INPUT_ACCOUNT', account: inputAccount });
    const have = new DataView(held.data.buffer, held.data.byteOffset).getBigUint64(64, true);
    if (have < amountIn) throw new RequestError(422, `${owner} holds ${have} of ${tokenIn.mint}; the swap sells ${amountIn}.`, { reason: 'INSUFFICIENT_INPUT', have, need: amountIn, account: inputAccount });
    const outputAccount = await ata(owner, tokenOut.mint, tokenOut.tokenProgram);
    const ensure = getCreateAssociatedTokenIdempotentInstruction({ payer: createNoopSigner(owner), ata: outputAccount, owner, mint: tokenOut.mint, tokenProgram: tokenOut.tokenProgram }) as Instruction;

    let swap: Instruction;
    let units: number;
    if (p.dlmm) {
      const a = await adapters();
      const q = a.dlmmQuoteExactIn({ pair: p.dlmm.pair, arrays: p.dlmm.arrays, swapForY: aToB, amountIn: amountIn - transferIn(tokenIn, amountIn), nowSeconds: p.chain.unixTimestamp });
      // The arrays the swap walks, plus the next one in the direction of travel when it exists, so a trade that lands a little further than quoted still has its accounts.
      const loaded = new Set(p.dlmm.indexesRead);
      const walk = [...q.arraysTouched];
      const last = walk.at(-1);
      if (last !== undefined) {
        const next = last + (aToB ? -1 : 1);
        if (loaded.has(next)) walk.push(next);
      }
      swap = await buildDlmmSwap({
        lbPair: poolAddress,
        reserveX: p.dlmm.pair.reserveX,
        reserveY: p.dlmm.pair.reserveY,
        tokenXMint: p.tokenA.mint,
        tokenYMint: p.tokenB.mint,
        tokenXProgram: p.tokenA.tokenProgram,
        tokenYProgram: p.tokenB.tokenProgram,
        oracle: p.dlmm.pair.oracle,
        trader: owner,
        inputAccount,
        outputAccount,
        amountIn,
        minimumAmountOut: minOut,
        binArrays: walk,
      });
      units = 300_000 + 100_000 * Math.max(0, q.arraysTouched.length - 1);
    } else {
      const pool = p.damm!.pool;
      swap = await buildDammSwap({
        pool: poolAddress,
        tokenAMint: p.tokenA.mint,
        tokenBMint: p.tokenB.mint,
        tokenAVault: pool.tokenAVault.toBase58() as Address,
        tokenBVault: pool.tokenBVault.toBase58() as Address,
        tokenAProgram: p.tokenA.tokenProgram,
        tokenBProgram: p.tokenB.tokenProgram,
        trader: owner,
        inputAccount,
        outputAccount,
        amountIn,
        minimumAmountOut: minOut,
      });
      units = 300_000;
    }
    const ixs = [computeUnits(units), ensure, swap];
    fits(owner, ixs, 'swap');
    const lifetime = await d.lifetime();
    const tx = compile(owner, ixs, lifetime);
    return send(reply, {
      transaction: tx.transaction,
      signers: tx.signers,
      lastValidBlockHeight: lifetime.lastValidBlockHeight,
      pool: poolAddress,
      kind: p.kind,
      swap: {
        inputMint: tokenIn.mint,
        outputMint: tokenOut.mint,
        amountIn,
        expectedOut: quote.out,
        minimumAmountOut: minOut,
        toleranceBps: explicitMin === null ? toleranceBps : null,
        slippageVsMidBps: (await adapters()).engineSlippageBps(p.engine, aToB, amountIn),
        inputAccount,
        outputAccount,
      },
      chain: p.chain,
      caveats: [
        'The quote is the pool as it is now. If other trades move the pool before this lands, the swap fails rather than filling below the minimum.',
        'Nothing has been signed or sent. The transaction needs the trader’s signature.',
        ...(tokenIn.transferFee || tokenOut.transferFee ? ['A token-2022 transfer fee applies to one of these tokens; expectedOut and the minimum are net of it.'] : []),
      ],
    });
    function transferIn(t: MintFacts, gross: bigint): bigint {
      // The pool receives the input less the mint's own transfer fee.
      if (!t.transferFee) return 0n;
      const raw = (gross * BigInt(t.transferFee.bps) + 9_999n) / 10_000n;
      return raw > t.transferFee.maxFee ? t.transferFee.maxFee : raw;
    }
  });

  return {
    async mergeInto(ranking, p) {
      try {
        const { found } = await discover(p.base, p.quote);
        const quotes: PoolVenueQuote[] = found.map((x) => quotePool(refOf(x), p.base, p.quote, p.baseDecimals, { side: p.side, quantity: p.amount }));
        const merged = mergePoolsIntoRanking(ranking, quotes, p.side);
        if (quotes.length > 0) return merged;
        // The router no longer says "Meteora is not priced": it looked, at the addresses the adapters open pools at, and found nothing.
        return { ...merged, excluded: [...merged.excluded, { venue: 'meteora', reason: 'No Meteora DAMM v2 pool or DLMM pair exists for this pair at the addresses the Opening Cross adapters open them at. Other pools may exist; GET /v1/pools/route?pool=<address> prices one by name.' }] };
      } catch (e) {
        return { ...ranking, excluded: [...ranking.excluded, { venue: 'meteora', reason: `Meteora pools could not be read: ${e instanceof Error ? e.message : String(e)}` }] };
      }
    },
  };
}
