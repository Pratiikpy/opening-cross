# DP13: settlement cost does not grow with the number of orders

Run: 2026-10-11, WSL, LiteSVM with the release build of `cross_core`.
Test `tests/core/test/scale.test.ts` (`SCALE_ORDERS=100000 SCALE_OUT=… vitest run test/scale.test.ts`); raw figures in [`data/dp13-scale-100000.json`](data/dp13-scale-100000.json).

One open-book launch, 32 shards, a 256-tick grid, **100,000 real orders**, each its own transaction, spread across the grid. The issuer's supply is 30% of demand, so the price rises from 1.00 to 2.79 and the marginal orders are rationed pro rata.

| Measure | Result |
|---|---|
| Compute to place an order | 21,633 CU for every one of the 100,000 (min, max and mean equal) |
| Transactions to settle | 33 (32 shard merges and one clear) |
| Compute to settle, total | 783,740 CU; the largest single instruction 116,476 CU |
| Compute to claim an order | 34,743 to 46,637 CU, mean 35,438 (200 orders sampled across the cross) |
| Clearing price and volume | 2.79; 30,000 tokens matched |
| Independent check | the verifier recomputed the whole cross from its on-chain book and matched |
| Wall time to place the orders in LiteSVM | 422 s |

The settlement cost depends on the number of shards and ticks, not on the number of orders, because every order adds into per-tick counters as it arrives. The first run (supply above demand, price at the floor) gave the same shape: 781,425 CU to settle.

## Not measured here

- Landing latency and throughput on a real network: see [`DP13-devnet-latency.md`](DP13-devnet-latency.md), which also records the concurrency defect this work found.
- Claiming all 100,000 orders (each claim is its own permissionless transaction); a spread of 200 was run.
