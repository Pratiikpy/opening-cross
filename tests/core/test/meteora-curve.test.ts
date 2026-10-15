// Demand-calibrated DBC curve (ADR-0913, row D3) on the real DBC binary: a launch clears, the bids above P* are read into curve bands, the design built from them
// opens a DBC pool at exactly P*, and the config DBC stores holds the calibrated price points and the liquidity ratios the weights asked for.
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OrderSide, SupplyMode, crossAddress } from '@opening-cross/sdk';
import { buildOpenDbcPool, calibrateCurveFromDemand, settlerAddress, sqrtPriceQ64 } from '@opening-cross/adapters';
import { World } from '../src/world.js';
import { DBC_FIXTURE } from '../src/harness.js';
import { CU, DEFAULT_SCHEDULE, defaultDesign } from '../src/settle-world.js';

describe.skipIf(!existsSync(DBC_FIXTURE))('demand-calibrated DBC curve', () => {
  it('opens at P* with the calibrated price points, and DBC stores the liquidity ratios the weights asked for', async () => {
    const w = await World.create();
    const crossAddr = await crossAddress(w.creator.address, 1n);
    const settler = await settlerAddress(crossAddr);
    const cross = await w.newCross({ supplyMode: SupplyMode.DeferredMint, schedule: DEFAULT_SCHEDULE, settler, settleDeadlineTs: 1_800_001_000n });
    // The call's demand: heavy at its clearing price, thinning toward higher limits.
    const book = [
      { price: 2_900_000n, quantity: 300_000_000n },
      { price: 2_600_000n, quantity: 500_000_000n },
      { price: 2_200_000n, quantity: 1_000_000_000n },
      { price: 2_000_000n, quantity: 2_800_000_000n },
    ];
    for (const b of book) {
      const who = await w.trader(20_000_000_000n);
      await w.place(cross, who, OrderSide.Buy, b.price, b.quantity);
    }
    const settled = await w.settle(cross);
    const pStar = settled.data.clearing.__option === 'Some' ? settled.data.clearing.value.price : 0n;
    expect(pStar > 0n).toBe(true);

    const curve = calibrateCurveFromDemand({ clearingPrice: pStar, bids: book, segments: 3 });
    expect(curve.basis).toBe('demand');
    expect(curve.sqrtPriceMultiples).toHaveLength(3);
    const design = { ...defaultDesign(), sqrtPriceMultiples: curve.sqrtPriceMultiples, liquidityWeights: curve.liquidityWeights };
    const open = await buildOpenDbcPool({ cross: settled, creator: w.creator, design, name: 'Calibrated', symbol: 'CAL', uri: 'https://github.com/Pratiikpy/opening-cross' });
    await w.h.send([CU, open.instruction], w.creator);

    const config = w.h.svm.getAccount(open.addresses.config);
    if (!config.exists) throw new Error('DBC config missing');
    const raw = Buffer.from(config.data);
    const start = sqrtPriceQ64(pStar, settled.data.priceScale);
    // The stored config holds the start square-root price (u128) followed by twenty curve points of (sqrt_price u128, liquidity u128) (idls/dynamic_bonding_curve.json).
    const u128 = (at: number) => raw.readBigUInt64LE(at) | (raw.readBigUInt64LE(at + 8) << 64n);
    const startBytes = Buffer.alloc(16);
    startBytes.writeBigUInt64LE(start & 0xffff_ffff_ffff_ffffn, 0);
    startBytes.writeBigUInt64LE(start >> 64n, 8);
    const startAt = raw.indexOf(startBytes);
    expect(startAt).toBeGreaterThan(0);
    expect(raw.indexOf(startBytes, startAt + 1)).toBe(-1); // it appears once
    const points = Array.from({ length: 20 }, (_, i) => ({ sqrtPrice: u128(startAt + 16 + i * 32), liquidity: u128(startAt + 32 + i * 32) })).filter((p) => p.sqrtPrice > 0n);
    expect(points).toHaveLength(3);
    // The stored price points are the calibrated ones, computed the way the adapter fixes the multiples (a 1e9 fixed point of the start price).
    points.forEach((p, i) => expect(p.sqrtPrice).toBe((start * BigInt(Math.round(curve.sqrtPriceMultiples[i]! * 1e9))) / 1_000_000_000n));
    // Liquidity per band follows the weights: ratio of band i to band 0 within 0.2% of the ratio of their weights.
    const ratios = points.map((p, i) => ({ stored: Number(p.liquidity) / Number(points[0]!.liquidity), asked: curve.liquidityWeights[i]! / curve.liquidityWeights[0]! }));
    console.table(ratios.map((r, i) => ({ band: i, weight: curve.liquidityWeights[i], stored_ratio: r.stored, asked_ratio: r.asked, demand: Number(curve.bands[i]!.demand) })));
    ratios.forEach((r) => expect(Math.abs(r.stored / r.asked - 1)).toBeLessThan(0.002));
    // The heavy first band got the most depth and the thin far bands less.
    expect(points[0]!.liquidity > points[1]!.liquidity && points[1]!.liquidity >= points[2]!.liquidity).toBe(true);
  });

  it('the program refuses a weights list of the wrong length before anything is sent', async () => {
    const w = await World.create();
    const crossAddr = await crossAddress(w.creator.address, 1n);
    const settler = await settlerAddress(crossAddr);
    const cross = await w.newCross({ supplyMode: SupplyMode.DeferredMint, schedule: DEFAULT_SCHEDULE, settler, settleDeadlineTs: 1_800_001_000n });
    const who = await w.trader(20_000_000_000n);
    await w.place(cross, who, OrderSide.Buy, 1_500_000n, 2_500_000_000n);
    const settled = await w.settle(cross);
    const design = { ...defaultDesign(), sqrtPriceMultiples: [2, 4], liquidityWeights: [1, 2, 3] };
    await expect(buildOpenDbcPool({ cross: settled, creator: w.creator, design, name: 'Bad', symbol: 'BAD', uri: 'https://github.com/Pratiikpy/opening-cross' })).rejects.toThrow(/liquidityWeights length/);
  });
});
