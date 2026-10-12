# D5: DLMM conviction ladder

Date: 2026-10-13. Code: `packages/adapters/src/dlmm.ts` (`buildDlmmConvictionLadder`, `ladderStrategy`, `binArrayAddress`, `binArrayIndex`). Test: `tests/core/test/dlmm.test.ts`. Decision: ADR-0023.

Environment: LiteSVM with the real lb_clmm binary (`tests/fixtures/lb_clmm.so`). Run in `tests/core`: `node node_modules/vitest/vitest.mjs run test/dlmm.test.ts`. Result: **4 passed** (2 existing, 2 new).

Setup: a cross clears at P* = 1.20 (active bin 182, bin price 1.1995). The issuer commits 2,000,000,000 base atoms as a `taper` ladder over the 20 bins 183 to 202.

| Check | Result |
|---|---|
| Base atoms that left the issuer's wallet equal the pair's X reserve; all but at most 100 of the 2,000,000,000 moved (DLMM rounding dust) | equal |
| Pair's Y reserve after the ladder | 0 (no quote) |
| First ladder bin price vs top bin price | 1.2007 and 1.2237 (0.1% per bin) |
| Buyer A swaps 100,000,000 quote through DLMM's `swap2`: average price paid | 1.2019, not below the first ladder bin (less nothing; the pair's fee adds to it) |
| Buyer B swaps 1,500,000,000 quote: average price paid | 1.2065, higher than A's, below the top bin plus 3% |
| Shapes map to Meteora's `SpotImBalanced`, `CurveImBalanced`, `BidAskImBalanced` (checked against the IDL) | 6, 7, 8 |

## NOT covered

- Devnet: no SOL (faucet exhausted), so no devnet transaction.
- The `flat` and `wall` shapes were not swapped through; only `taper` was.
- A ladder wider than one position (more than 70 bins) and bin arrays that already exist were not exercised.
- Withdrawal and fee claims on the ladder position use Meteora's own instructions and were not run.
