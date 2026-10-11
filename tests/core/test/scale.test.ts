// Scale (DP13): settlement cost must not grow with the number of orders. Orders aggregate into per-tick shard counters
// as they arrive, so merging 32 shards and clearing 256 ticks costs the same at 10 orders and at 100,000. This
// measures it on the real program: every order is a real transaction, then the cross is settled, every settlement
// instruction's compute is recorded, the result is checked against the independent verifier, and a spread of orders is
// claimed. Default 2,000 orders; SCALE_ORDERS=100000 reproduces the figure in docs/evidence/DP13-scale.md.
import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { CrossState, Disclosure, OrderSide, SupplyMode, buildClaim, buildPlaceOrder, buildSettleBook, orderAddress } from '@opening-cross/sdk';
import { verifyCross } from '@opening-cross/verifier';
import { World } from '../src/world.js';

const N = Number(process.env.SCALE_ORDERS ?? 2_000);
const SHARDS = 32;
const TICKS = 256;

describe('scale', () => {
  it(`settles ${N} orders at the cost of ten`, async () => {
    const w = await World.create();
    // Supply is a fraction of demand, so the price rises and the marginal orders are rationed pro rata.
    const supply = BigInt(N) * 300_000n;
    const cross = await w.newCross({
      disclosure: Disclosure.Open,
      supplyMode: SupplyMode.Mint,
      shards: SHARDS,
      ticks: TICKS,
      tick: 10_000n,
      minPrice: 1_000_000n,
      maxOrders: N + 16,
      schedule: [{ price: 1_000_000n, quantity: supply }],
    });
    // Each order account costs rent, so the buyer needs SOL in proportion to the number of orders.
    const buyer = await w.h.wallet(BigInt(N) / 200n + 20n);
    await w.h.fund(w.quoteMint, w.admin, buyer.address, BigInt(N) * 4_000_000n);

    const placeCu: number[] = [];
    const t0 = Date.now();
    for (let i = 0; i < N; i++) {
      // Spread bids across the whole grid, deterministically.
      const tick = (i * 97) % TICKS;
      const price = 1_000_000n + BigInt(tick) * 10_000n;
      const ix = await buildPlaceOrder({ cross: w.view(cross.address), owner: buyer, nonce: BigInt(i), side: OrderSide.Buy, price, quantity: 1_000_000n, salt: new Uint8Array(32) });
      placeCu.push(Number(await w.h.send([ix], buyer)));
      if (N >= 20_000 && i % 10_000 === 9_999) console.log(`placed ${i + 1}/${N} in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    }
    const placeSeconds = (Date.now() - t0) / 1000;
    expect(w.view(cross.address).data.ordersTotal).toBe(N);

    w.h.setTime(cross.data.revealEndTs + 1n);
    const ixs = await buildSettleBook(w.view(cross.address));
    const settleCu: number[] = [];
    for (const ix of ixs) settleCu.push(Number(await w.h.send([ix], w.admin)));
    const settled = w.view(cross.address);
    expect(settled.data.state).toBe(CrossState.Cleared);

    const fetch = async (a: string) => {
      const x = w.h.svm.getAccount(a as never);
      return x.exists ? (x.data as Uint8Array) : null;
    };
    const proof = await verifyCross(fetch as never, cross.address);
    expect(proof.verified, proof.notes.join('; ')).toBe(true);

    // Claim a spread of orders (all of them when the cross is small); each is paid from the same vaults.
    const picks = N <= 2_000 ? Array.from({ length: N }, (_, i) => i) : Array.from({ length: 200 }, (_, i) => Math.floor((i * (N - 1)) / 199));
    const claimCu: number[] = [];
    for (const i of picks) claimCu.push(Number(await w.h.send(await buildClaim(w.view(cross.address), w.admin, buyer.address, BigInt(i)), w.admin)));
    // A claimed order is closed: its account is gone.
    const last = picks[picks.length - 1]!;
    expect(w.h.svm.getAccount(await orderAddress(cross.address, buyer.address, BigInt(last))).exists).toBe(false);

    const stats = (xs: number[]) => ({ n: xs.length, min: Math.min(...xs), max: Math.max(...xs), mean: Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) });
    const report = {
      orders: N,
      shards: SHARDS,
      ticks: TICKS,
      placeOrder: stats(placeCu),
      settleInstructions: settleCu.length,
      settleTotalCu: settleCu.reduce((a, b) => a + b, 0),
      settleMaxInstructionCu: Math.max(...settleCu),
      claim: stats(claimCu),
      clearingPrice: settled.data.clearing.__option === 'Some' ? settled.data.clearing.value.price.toString() : null,
      matched: settled.data.clearing.__option === 'Some' ? settled.data.clearing.value.matched.toString() : null,
      verifiedByIndependentImplementation: proof.verified,
      placeSeconds: Math.round(placeSeconds),
    };
    console.log(JSON.stringify(report, null, 1));
    if (process.env.SCALE_OUT) writeFileSync(process.env.SCALE_OUT, JSON.stringify(report, null, 1));
    expect(report.placeOrder.max).toBeLessThanOrEqual(25_000);
    expect(report.settleMaxInstructionCu).toBeLessThanOrEqual(200_000);
  }, 7_200_000);
});
