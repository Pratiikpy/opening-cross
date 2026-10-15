// The pool engines of packages/adapters/src/health.ts (ADR-0920), checked against real Meteora accounts and against a second implementation.
//
// The fixtures are the pools the devnet proofs opened (packages/router/test/fixtures/devnet-pools.json, captured by packages/router/scripts/capture-pool-fixtures.mjs). Every
// figure that comes from chain evidence is named with the evidence file it comes from. Where a branch has no on-chain fixture it is tested on
// constructed state and says so.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  type DlmmBinArray,
  type LbPairState,
  DLMM_BINS_PER_ARRAY,
  HEALTH_SLIPPAGE_LEVELS_BPS,
  decodeBinArray,
  decodeClock,
  decodeDammPool,
  decodeLbPair,
  dammCurrentPoint,
  dammEngine,
  dammMidQ64,
  dammReserves,
  dammSwapStatus,
  depthPersistence,
  dlmmEngine,
  dlmmFeeRate,
  dlmmLadder,
  dlmmQuoteExactIn,
  dlmmSwapStatus,
  engineDepth,
  engineHealth,
  engineSlippageBps,
  slippageAtSizes,
  transferFeeOf,
  withTransferFees,
} from '../src/health.js';
import { binPriceQ64 } from '../src/dlmm.js';

const fx = JSON.parse(readFileSync(new URL('../../router/test/fixtures/devnet-pools.json', import.meta.url), 'utf8')) as {
  pools: { 'dlmm-proof': { pair: string; binArrays: { address: string }[] }; 'dlmm-ladder': { pair: string; binArrays: { address: string }[] }; 'damm-proof': { pool: string } };
  accounts: Record<string, { owner: string; slot: number; data: string }>;
};
const bytes = (a: string) => new Uint8Array(Buffer.from(fx.accounts[a]!.data, 'base64'));
const load = (name: 'dlmm-proof' | 'dlmm-ladder') => ({ pair: decodeLbPair(bytes(fx.pools[name].pair)), arrays: fx.pools[name].binArrays.map((b) => decodeBinArray(bytes(b.address))) });
const NOW = 1_791_900_000n;
// Far enough from the pair's last swap that the volatility references have decayed, as they would be for a quote taken later.
const Q64 = 1n << 64n;

describe('DLMM accounts', () => {
  it('decodes the pair the A3 proof opened (docs/evidence/A3-dlmm-devnet.md)', () => {
    const { pair } = load('dlmm-proof');
    expect(pair.binStep).toBe(10);
    expect(pair.activeId).toBe(262);
    expect(pair.tokenXMint).toBe('AypfHSmpMQ2C1zaGRHRyoYbQBjFA8Wphc7AQrkmCLZXN');
    expect(pair.tokenYMint).toBe('HRYt8BVWnDkBNXJQ8CUpAkVEaQUgFeUAshGCRAk8JEGN');
    // the creator the proof logged and a 0.10% base fee: baseFactor 10000 x binStep 10 x 10 = 1,000,000 of 1e9
    expect(pair.creator).toBe('EScH6fW8JR7UWHyY25dxhigWNcpq9YyZmwyy2kajDZcC');
    expect(dlmmFeeRate(pair, 0)).toBe(1_000_000n);
    expect(pair.pairType).toBe('customizable-permissionless');
    expect(pair.status).toBe(0);
    expect(pair.params.functionType).toBe(2);
  });

  it('decodes a bin array and the bin prices equal the adapter price function', () => {
    for (const name of ['dlmm-proof', 'dlmm-ladder'] as const) {
      const { pair, arrays } = load(name);
      let checked = 0;
      for (const a of arrays) {
        expect(a.lbPair).toBe(fx.pools[name].pair);
        a.bins.forEach((b, i) => {
          if (b.amountX === 0n && b.amountY === 0n) return;
          // The program keeps its own rounding of (1 + step)^id, so the stored price and the adapter's agree to about 1e-16 of the price, not to the last bit.
          const computed = binPriceQ64(a.index * DLMM_BINS_PER_ARRAY + i, pair.binStep);
          const gap = b.price > computed ? b.price - computed : computed - b.price;
          expect(gap * 10n ** 12n).toBeLessThan(computed);
          checked++;
        });
      }
      expect(checked).toBeGreaterThan(2);
    }
  });

  it('refuses bytes that are not the account', () => {
    expect(() => decodeLbPair(new Uint8Array(904))).toThrow(/not a DLMM LbPair/);
    expect(() => decodeBinArray(new Uint8Array(100))).toThrow(/not a DLMM BinArray/);
    expect(() => decodeDammPool(new Uint8Array(1112))).toThrow(/not a DAMM v2 Pool/);
  });

  it('reads the Clock sysvar layout', () => {
    const b = new Uint8Array(40);
    const v = new DataView(b.buffer);
    v.setBigUint64(0, 511_450_000n, true);
    v.setBigUint64(16, 1_183n, true);
    v.setBigInt64(32, 1_791_855_000n, true);
    expect(decodeClock(b)).toEqual({ slot: 511_450_000n, epoch: 1_183n, unixTimestamp: 1_791_855_000n });
    expect(() => decodeClock(new Uint8Array(8))).toThrow();
  });
});

describe('DLMM swap quote', () => {
  it('reproduces the real swap of the A3 proof: 5,000,000 base in gave 6,490,285 quote out', () => {
    const { pair, arrays } = load('dlmm-proof');
    const q = dlmmQuoteExactIn({ pair, arrays, swapForY: true, amountIn: 5_000_000n, nowSeconds: NOW });
    expect(q.out).toBe(6_490_285n);
    expect(q.fee).toBe(5_000n);
    expect(q.partial).toBe(false);
    expect(q.binsCrossed).toBe(1);
  });

  // A second implementation, written from the fee formulas and not from the port: walk the bins from the active bin, charge the fee on the
  // input and stop when the input is spent. It knows nothing of limit orders (the fixtures hold none).
  function oracle(pair: LbPairState, arrays: DlmmBinArray[], swapForY: boolean, amountIn: bigint) {
    const bins = new Map<number, { x: bigint; y: bigint }>();
    for (const a of arrays) a.bins.forEach((b, i) => bins.set(a.index * 70 + i, { x: b.amountX, y: b.amountY }));
    let left = amountIn;
    let out = 0n;
    let id = pair.activeId;
    const ref = pair.activeId; // references decayed: the reference bin is the active bin and the volatility reference is zero
    const lo = Math.min(...bins.keys());
    const hi = Math.max(...bins.keys());
    while (left > 0n && id >= lo && id <= hi) {
      const b = bins.get(id);
      const available = b ? (swapForY ? b.y : b.x) : 0n;
      if (available > 0n) {
        const price = binPriceQ64(id, pair.binStep);
        const acc = BigInt(Math.min(Math.abs(ref - id) * 10_000, pair.params.maxVolatilityAccumulator));
        const base = BigInt(pair.params.baseFactor) * BigInt(pair.binStep) * 10n;
        const variable = (BigInt(pair.params.variableFeeControl) * (acc * BigInt(pair.binStep)) ** 2n + 99_999_999_999n) / 100_000_000_000n;
        const rate = base + variable;
        const fullIn = swapForY ? (available * Q64 + price - 1n) / price : (available * price + Q64 - 1n) / Q64;
        const fullGross = (fullIn * 1_000_000_000n + (1_000_000_000n - rate) - 1n) / (1_000_000_000n - rate);
        if (left >= fullGross) {
          left -= fullGross;
          out += available;
        } else {
          const fee = (left * rate + 999_999_999n) / 1_000_000_000n;
          const net = left - fee;
          out += swapForY ? (net * price) / Q64 : (net * Q64) / price;
          left = 0n;
        }
      }
      if (left > 0n) id += swapForY ? -1 : 1;
    }
    return { out, left };
  }

  it('agrees with the second implementation across sizes, both directions, on the 20-bin ladder pair', () => {
    const { pair, arrays } = load('dlmm-ladder');
    // The ladder pair was last swapped long before NOW, so its references decay to zero in the port too.
    let multi = 0;
    for (const swapForY of [true, false]) {
      for (let k = 1; k <= 60; k++) {
        const amountIn = BigInt(Math.floor(1.45 ** k)) + BigInt(k);
        const q = dlmmQuoteExactIn({ pair, arrays, swapForY, amountIn, nowSeconds: NOW });
        const o = oracle(pair, arrays, swapForY, amountIn);
        expect(q.out, `${swapForY ? 'X->Y' : 'Y->X'} ${amountIn}`).toBe(o.out);
        expect(q.partial).toBe(o.left > 0n);
        if (q.binsCrossed > 1) multi++;
      }
    }
    expect(multi).toBeGreaterThan(10);
  });

  it('charges the variable fee in every bin a swap enters, and decays it with time', () => {
    const { pair, arrays } = load('dlmm-ladder');
    const hot: LbPairState = { ...pair, vars: { volatilityAccumulator: 120_000, volatilityReference: 100_000, indexReference: pair.activeId, lastUpdateTimestamp: NOW - 3n } };
    const cold: LbPairState = { ...hot, vars: { ...hot.vars, lastUpdateTimestamp: NOW - 500n } };
    const ask = (p: LbPairState) => dlmmQuoteExactIn({ pair: p, arrays, swapForY: false, amountIn: 200_000_000n, nowSeconds: NOW });
    // inside the filter period (3 s < 10 s) nothing decays: the reference stays 100,000, so the fee is higher than after the decay period
    expect(ask(hot).fee).toBeGreaterThan(ask(cold).fee);
    expect(ask(hot).out).toBeLessThan(ask(cold).out);
    // a fee can never pass the 10% cap
    expect(dlmmFeeRate({ binStep: 10, params: { ...pair.params, variableFeeControl: 4_000_000_000 } }, 150_000)).toBe(100_000_000n);
  });

  it('takes the fee from the output when the pair collects on token Y only (SDK getFeeMode)', () => {
    const { pair, arrays } = load('dlmm-proof');
    const onY: LbPairState = { ...pair, params: { ...pair.params, collectFeeMode: 1 } };
    const base = dlmmQuoteExactIn({ pair, arrays, swapForY: true, amountIn: 5_000_000n, nowSeconds: NOW });
    const y = dlmmQuoteExactIn({ pair: onY, arrays, swapForY: true, amountIn: 5_000_000n, nowSeconds: NOW });
    // selling X for Y: the fee is on the output, so the whole input trades and the fee is 0.1% of the gross output
    const gross = (5_000_000n * binPriceQ64(262, 10)) / Q64;
    expect(y.out).toBe(gross - (gross * 1_000_000n + 999_999_999n) / 1_000_000_000n);
    expect(y.consumed).toBe(5_000_000n);
    // buying X with Y on the same pair charges the fee on the input, as in mode 0
    const buyY = dlmmQuoteExactIn({ pair: onY, arrays, swapForY: false, amountIn: 5_000_000n, nowSeconds: NOW });
    const buy0 = dlmmQuoteExactIn({ pair, arrays, swapForY: false, amountIn: 5_000_000n, nowSeconds: NOW });
    expect(buyY.out).toBe(buy0.out);
    // the fee is counted in the token it was taken in: token X on the input in mode 0, token Y on the output in mode 1
    expect(base.fee).toBe(5_000n);
    expect(y.fee).toBe((gross * 1_000_000n + 999_999_999n) / 1_000_000_000n);
  });

  it('is partial when the loaded bins cannot absorb the trade, and treats a missing array as empty', () => {
    const { pair, arrays } = load('dlmm-ladder');
    const all = dlmmQuoteExactIn({ pair, arrays, swapForY: false, amountIn: 5_000_000_000n, nowSeconds: NOW });
    expect(all.partial).toBe(true);
    expect(all.out).toBe(arrays.flatMap((a) => a.bins).reduce((s, b) => s + b.amountX, 0n));
    const onlyFirst = dlmmQuoteExactIn({ pair, arrays: arrays.slice(0, 1), swapForY: false, amountIn: 5_000_000_000n, nowSeconds: NOW });
    expect(onlyFirst.out).toBeLessThanOrEqual(all.out);
    const none = dlmmQuoteExactIn({ pair, arrays: [], swapForY: true, amountIn: 1_000n, nowSeconds: NOW });
    expect(none).toMatchObject({ out: 0n, consumed: 0n, partial: true, binsCrossed: 0 });
  });

  it('lists the bin arrays a swap touches, in order', () => {
    const { pair, arrays } = load('dlmm-ladder');
    const q = dlmmQuoteExactIn({ pair, arrays, swapForY: false, amountIn: 400_000_000n, nowSeconds: NOW });
    expect(q.arraysTouched.length).toBeGreaterThanOrEqual(1);
    expect([...q.arraysTouched].sort((a, b) => a - b)).toEqual(q.arraysTouched);
    expect(q.endActiveId).toBeGreaterThanOrEqual(pair.activeId);
  });

  // No pair on chain holds a limit order, so the order branches are exercised on constructed bins and are NOT VERIFIED against the program.
  describe('limit orders (constructed state, NOT VERIFIED on chain)', () => {
    const empty = { amountX: 0n, amountY: 0n, price: 0n, openOrderAmount: 0n, processedOrderRemaining: 0n, orderAskSide: false };
    const mk = (pair: LbPairState, bin: Partial<typeof empty>): DlmmBinArray => {
      const idx = Math.floor(pair.activeId / 70);
      const bins = Array.from({ length: 70 }, () => ({ ...empty }));
      bins[pair.activeId - idx * 70] = { ...empty, price: binPriceQ64(pair.activeId, pair.binStep), ...bin };
      return { index: idx, lbPair: 'A'.repeat(32) as never, bins };
    };
    const { pair } = load('dlmm-proof');
    const lo: LbPairState = { ...pair, params: { ...pair.params, functionType: 2 } };
    const buy = (p: LbPairState, a: DlmmBinArray, amt: bigint) => dlmmQuoteExactIn({ pair: p, arrays: [a], swapForY: false, amountIn: amt, nowSeconds: NOW });

    it('a buy takes the market-making amount, then processed orders, then open orders, all at the bin price', () => {
      const a = mk(lo, { amountX: 1_000n, openOrderAmount: 2_000n, processedOrderRemaining: 500n, orderAskSide: true });
      const q = buy(lo, a, 10_000_000n);
      expect(q.out).toBe(3_500n);
      expect(q.partial).toBe(true);
    });

    it('orders on the other side do not fill a buy; bid-side orders fill a sell of X', () => {
      const bid = mk(lo, { amountX: 1_000n, openOrderAmount: 2_000n, orderAskSide: false });
      expect(buy(lo, bid, 10_000_000n).out).toBe(1_000n);
      const sell = dlmmQuoteExactIn({ pair: lo, arrays: [bid], swapForY: true, amountIn: 10_000_000n, nowSeconds: NOW });
      expect(sell.out).toBe(2_000n);
    });

    it('a liquidity-mining pair ignores orders; an undetermined pair with rewards does too', () => {
      const a = mk(lo, { amountX: 1_000n, openOrderAmount: 2_000n, orderAskSide: true });
      expect(buy({ ...lo, params: { ...lo.params, functionType: 1 } }, a, 10_000_000n).out).toBe(1_000n);
      expect(buy({ ...lo, params: { ...lo.params, functionType: 0 }, hasRewards: true }, a, 10_000_000n).out).toBe(1_000n);
      expect(buy({ ...lo, params: { ...lo.params, functionType: 0 }, hasRewards: false }, a, 10_000_000n).out).toBe(3_000n);
    });
  });
});

describe('DLMM trading status', () => {
  const { pair } = load('dlmm-proof');
  it('is open once the activation point has passed, and says when it opens before then', () => {
    const batched: LbPairState = { ...pair, activationType: 1, activationPoint: 2_000n };
    expect(dlmmSwapStatus(batched, { slot: 0n, unixTimestamp: 1_999n })).toMatchObject({ open: false, opensAtPoint: 2_000n, pointUnit: 'timestamp' });
    expect(dlmmSwapStatus(batched, { slot: 0n, unixTimestamp: 2_000n }).open).toBe(true);
    const bySlot: LbPairState = { ...pair, activationType: 0, activationPoint: 500n };
    expect(dlmmSwapStatus(bySlot, { slot: 499n, unixTimestamp: 9_999n })).toMatchObject({ open: false, pointUnit: 'slot' });
  });
  it('lets the named pre-activation address in early, and a disabled pair never trades', () => {
    const early: LbPairState = { ...pair, activationPoint: 2_000n, preActivationDuration: 300n, preActivationSwapAddress: 'So11111111111111111111111111111111111111112' as never };
    expect(dlmmSwapStatus(early, { slot: 0n, unixTimestamp: 1_800n }).open).toBe(false);
    expect(dlmmSwapStatus(early, { slot: 0n, unixTimestamp: 1_800n }, 'So11111111111111111111111111111111111111112' as never).open).toBe(true);
    expect(dlmmSwapStatus({ ...pair, status: 1 }, { slot: 0n, unixTimestamp: 9_999_999_999n })).toMatchObject({ open: false, reason: 'the pair is disabled' });
    const permissionless: LbPairState = { ...pair, pairType: 'permissionless-v2', activationPoint: 9_999_999_999n };
    expect(dlmmSwapStatus(permissionless, { slot: 0n, unixTimestamp: 1n }).open).toBe(true);
  });
});

describe('DLMM ladder', () => {
  it('lists asks above and bids below the active bin with running totals', () => {
    const { pair, arrays } = load('dlmm-ladder');
    const ladder = dlmmLadder({ pair, arrays, binsEachSide: 30 });
    const ids = ladder.map((l) => l.binId);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    const asks = ladder.filter((l) => l.role === 'ask');
    const bids = ladder.filter((l) => l.role === 'bid');
    expect(asks.length).toBeGreaterThan(5);
    expect(bids.length).toBeGreaterThan(1);
    expect(asks.every((l) => l.binId > pair.activeId) && bids.every((l) => l.binId < pair.activeId)).toBe(true);
    // the running token X total of the highest ask is everything the loaded bins above (and in) the active bin hold
    const x = arrays.flatMap((a) => a.bins.map((b, i) => ({ id: a.index * 70 + i, b }))).filter((e) => e.id >= pair.activeId && e.id <= pair.activeId + 30).reduce((s, e) => s + e.b.amountX, 0n);
    expect(asks.at(-1)!.cumulativeX).toBe(x);
    for (let i = 1; i < asks.length; i++) {
      expect(asks[i]!.cumulativeX).toBeGreaterThanOrEqual(asks[i - 1]!.cumulativeX);
      expect(asks[i]!.priceQ64).toBeGreaterThan(asks[i - 1]!.priceQ64);
    }
  });
});

describe('DAMM v2 accounts and quote', () => {
  const dammBytes = () => bytes(fx.pools['damm-proof'].pool);
  const pool = () => decodeDammPool(dammBytes());
  const POINT = 1_791_900_000n;

  it('reads the pool the A2 proof seeded: reserves are the deposit plus the swap the proof made', () => {
    const r = dammReserves(pool());
    // docs/evidence/A2-damm-v2-devnet.md: vault A 900,000,000 and B 1,170,000,000 at seeding; then 5,000,000 base in, 6,464,088 gross quote out
    expect(r.reserveA).toBe(905_000_000n);
    expect(r.reserveB).toBe(1_170_000_000n - 6_464_088n);
    expect(pool().tokenAMint.toBase58()).toBe('EkisVxYv7x5pJfXUM75WiQC9AgYKy2ps5R3pyTEeovCV');
    expect(pool().tokenBMint.toBase58()).toBe('7BavPghywmfMMvt7VctXpFvqKCB8kwnXDyA2iZUQzidy');
  });

  it('prices a swap as the concentrated-liquidity formula does, fee included', () => {
    const p = pool();
    const e = dammEngine({ pool: p, currentPoint: POINT, decimalsA: 9, decimalsB: 9 });
    const L = BigInt(p.liquidity.toString(10));
    const sqrtP = BigInt(p.sqrtPrice.toString(10));
    const cases: [boolean, bigint][] = [[true, 5_000_000n], [true, 120_000_000n], [false, 5_000_000n], [false, 90_000_000n]];
    for (const [aToB, dx] of cases) {
      const q = e.swap(aToB, dx);
      // 0.30% fee, collected on token B (collectFeeMode OnlyB): from the output when selling A, from the input when selling B
      let out: bigint;
      // Reserves are A = L / sqrtP and B = L * sqrtP / 2^128 (sqrtP in Q64.64), so the price after a trade follows from the invariant.
      if (aToB) {
        const next = (L * sqrtP) / (L + dx * sqrtP);
        const gross = (L * (sqrtP - next)) / (Q64 * Q64);
        out = gross - (gross * 3_000_000n) / 1_000_000_000n;
      } else {
        const net = dx - (dx * 3_000_000n) / 1_000_000_000n;
        const next = sqrtP + (net * Q64 * Q64) / L;
        out = (L * (next - sqrtP)) / (next * sqrtP);
      }
      const diff = q.out > out ? q.out - out : out - q.out;
      expect(diff <= 2n, `${aToB ? 'A->B' : 'B->A'} ${dx}: sdk ${q.out}, formula ${out}`).toBe(true);
      expect(q.partial).toBe(false);
    }
  });

  it('mid price is the sqrt price squared and sits between what a sell and a buy of one atom pay', () => {
    const p = pool();
    const mid = dammMidQ64(p);
    const s = BigInt(p.sqrtPrice.toString(10));
    expect(mid).toBe((s * s) / Q64);
    expect(Number(mid) / 2 ** 64).toBeGreaterThan(1.28);
    expect(Number(mid) / 2 ** 64).toBeLessThan(1.32);
  });

  it('opens at its activation point and not before', () => {
    const p = pool();
    expect(dammCurrentPoint(p, { slot: 7n, unixTimestamp: 99n })).toBe(p.activationType === 0 ? 7n : 99n);
    expect(dammSwapStatus(p, POINT).open).toBe(true);
    const future = { ...p, activationPoint: p.activationPoint.addn(10_000_000) } as typeof p;
    expect(dammSwapStatus(future, POINT)).toMatchObject({ open: false });
    expect(dammSwapStatus({ ...p, poolStatus: 1 } as typeof p, POINT).reason).toBe('the pool is disabled');
    // a pool that is not open takes nothing, so its depth is zero rather than an error
    const closed = dammEngine({ pool: future, currentPoint: POINT, decimalsA: 9, decimalsB: 9 });
    expect(closed.swap(true, 1_000_000n).partial).toBe(true);
  });
});

describe('depth and slippage', () => {
  const engines = () => {
    const a = load('dlmm-proof');
    const b = load('dlmm-ladder');
    return [
      ['dlmm one-bin', dlmmEngine({ ...a, nowSeconds: NOW })],
      ['dlmm ladder', dlmmEngine({ ...b, nowSeconds: NOW })],
      ['damm', dammEngine({ pool: decodeDammPool(bytes(fx.pools['damm-proof'].pool)), currentPoint: NOW, decimalsA: 9, decimalsB: 9 })],
    ] as const;
  };

  it('the depth at a limit is the largest size within it: one atom more is over the limit or cannot be absorbed', () => {
    for (const [name, e] of engines()) {
      for (const limit of HEALTH_SLIPPAGE_LEVELS_BPS) {
        for (const aToB of [true, false]) {
          const d = engineDepth(e, aToB, limit);
          if (d.maxIn === 0n) continue;
          expect(engineSlippageBps(e, aToB, d.maxIn), `${name} ${aToB} ${limit}`).toBeLessThanOrEqual(limit);
          expect(engineSlippageBps(e, aToB, d.maxIn + 1n), `${name} ${aToB} ${limit} +1`).toBeGreaterThan(limit);
        }
      }
    }
  });

  it('a limit below the pool fee has no depth, and depth never shrinks as the limit grows', () => {
    for (const [name, e] of engines()) {
      const depths = HEALTH_SLIPPAGE_LEVELS_BPS.map((l) => engineDepth(e, true, l).maxIn);
      depths.forEach((d, i) => i > 0 && expect(d, name).toBeGreaterThanOrEqual(depths[i - 1]!));
    }
    const damm = engines()[2]![1];
    expect(engineDepth(damm, true, 10n).maxIn).toBe(0n);
    expect(engineDepth(damm, true, 100n).maxIn).toBeGreaterThan(0n);
  });

  it('health carries the reserves, a value in token B and depth both ways', () => {
    const [, e] = engines()[0]!;
    const h = engineHealth(e);
    expect(h.depth).toHaveLength(HEALTH_SLIPPAGE_LEVELS_BPS.length);
    expect(h.tvlInB).toBe(e.reserveB + (e.reserveA * e.midQ64) / Q64);
    expect(h.reserveA).toBe(804_995_000n);
  });

  it('slippage at set sizes grows with size', () => {
    const [, e] = engines()[2]!;
    const rows = slippageAtSizes(e, true, [1_000_000n, 10_000_000n, 100_000_000n, 1_000_000_000n]);
    rows.forEach((r, i) => i > 0 && expect(r.slippageBps).toBeGreaterThanOrEqual(rows[i - 1]!.slippageBps));
    expect(rows.at(-1)!.slippageBps).toBeGreaterThan(rows[0]!.slippageBps);
  });

  it('an engine answers depth itself, the same as the function, with transfer fees applied when it is wrapped', () => {
    for (const [, e] of engines()) {
      expect(e.depth(true, 100n)).toEqual(engineDepth(e, true, 100n));
      expect(e.depth(false, 50n)).toEqual(engineDepth(e, false, 50n));
    }
    const [, base] = engines()[2]!;
    const taxed = withTransferFees(base, undefined, { bps: 100, maxFee: 10n ** 12n });
    // selling A returns B less 1%, so the same slippage limit admits less
    expect(taxed.depth(true, 300n).maxIn).toBeLessThan(base.depth(true, 300n).maxIn);
    expect(taxed.depth(true, 300n)).toEqual(engineDepth(taxed, true, 300n));
  });

  it('the DAMM engine takes an input too small to return an atom and returns nothing; an input beyond the price range it cannot take', () => {
    const [, e] = engines()[2]!;
    expect(e.swap(true, 1n)).toEqual({ consumed: 1n, out: 0n, fee: 0n, partial: false });
    expect(e.swap(false, 1n)).toMatchObject({ consumed: 1n, out: 0n, partial: false });
    expect(e.swap(true, 2n ** 63n)).toMatchObject({ consumed: 0n, out: 0n, partial: true });
    expect(e.swap(true, 0n)).toEqual({ consumed: 0n, out: 0n, fee: 0n, partial: false });
  });

  it('a sell the pool cannot absorb is 100% slippage', () => {
    const [, e] = engines()[0]!;
    expect(engineSlippageBps(e, true, 10n ** 12n)).toBe(10_000n);
    expect(engineSlippageBps(e, true, 0n)).toBe(0n);
  });
});

describe('token-2022 transfer fees', () => {
  it('computes the mint fee the way the token program does: rounded up, capped', () => {
    expect(transferFeeOf(10_000n, { bps: 100, maxFee: 1_000_000n })).toBe(100n);
    expect(transferFeeOf(10_001n, { bps: 100, maxFee: 1_000_000n })).toBe(101n);
    expect(transferFeeOf(10_000_000n, { bps: 100, maxFee: 5_000n })).toBe(5_000n);
    expect(transferFeeOf(0n, { bps: 100, maxFee: 5n })).toBe(0n);
    expect(transferFeeOf(100n, undefined)).toBe(0n);
  });

  it('charges the input mint on the way in and the output mint on the way out', () => {
    const { pair, arrays } = load('dlmm-proof');
    const e = dlmmEngine({ pair, arrays, nowSeconds: NOW });
    const withFees = withTransferFees(e, { bps: 100, maxFee: 10_000_000n }, { bps: 50, maxFee: 10_000_000n });
    const plain = e.swap(true, 5_000_000n - 50_000n);
    const net = withFees.swap(true, 5_000_000n);
    expect(net.out).toBe(plain.out - transferFeeOf(plain.out, { bps: 50, maxFee: 10_000_000n }));
    expect(net.consumed).toBe(5_000_000n);
    expect(withTransferFees(e, undefined, undefined)).toBe(e);
    expect(engineSlippageBps(withFees, true, 5_000_000n)).toBeGreaterThan(engineSlippageBps(e, true, 5_000_000n));
  });
});

describe('persistence from observed depth', () => {
  it('weights each sample by the time to the next and gives the last no weight', () => {
    const s = [
      { timestamp: 0, maxIn: 100n },
      { timestamp: 60, maxIn: 10n },
      { timestamp: 100, maxIn: 100n },
      { timestamp: 200, maxIn: 0n },
    ];
    // sizes of 50: sample 0 (60 s) ok, sample 1 (40 s) not, sample 2 (100 s) ok -> 160 of 200
    expect(depthPersistence(s, 50n)).toBeCloseTo(0.8, 10);
    expect(depthPersistence([], 1n)).toBe(0);
    expect(() => depthPersistence([{ timestamp: 5, maxIn: 1n }, { timestamp: 1, maxIn: 1n }], 1n)).toThrow(/time order/);
  });
});
