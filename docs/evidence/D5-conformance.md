# D5 — Verifier conformance suite (2026-10-05)

`packages/verifier/conformance/v1.json` (`opening-cross/conformance/v1`): 525 cases, 25 curated
edge cases plus 500 seeded random books (SplitMix64, fixed seed). Each case gives the grid,
reference price, print guards and orders; the expected outcome includes the no-print reason, or
the clearing price, matched volume, rationed side and every order's fill.

The expected values come from `clearing-core`, the code that runs on chain, following
`cross_core::clear` step for step (`crates/clearing-core/examples/conformance_vectors.rs`).
`OffsetGrid` moved from `cross_core` into `clearing-core`, so the program and the generator use
one grid implementation. CI regenerates the file and fails on any byte of difference.

Three independent checks:

1. The verifier's TypeScript reference, written from the ADR rather than from clearing-core,
   reproduces all 525 cases (`packages/verifier/test/conformance.test.ts`). A single off-by-one
   fill is caught, and an implementation that throws fails every case without crashing the run.
2. The deployed program reproduces every case it can represent, run as real crosses on LiteSVM:
   orders placed, book cleared, every order claimed, fills read from `OrderClaimed` events
   (`tests/core/test/conformance.test.ts`):

   ```
   conformance on chain: 523 run, 0 mismatches, 2 outside program limits:
     quantities near u64::MAX aggregate without overflow: a price level total exceeds u64
     fine grid with a large book: 2000 ticks exceeds MAX_TICKS
   ```

   Both skipped cases test clearing-core beyond the program's account limits. Their properties
   are also covered on chain by "level totals at the u64 limit the on-chain book can hold" and
   "full 256-tick grid with orders at both ends".
3. `runConformance(vectors, impl)` and the `opening-cross-conformance` command let any
   third-party implementation be held to the same file.

Curated cases were read by hand against ADR-0003. Two did not test what their names claimed and
were fixed:

- The "imbalance tie" case was decided by volume.
- The 1-atom rounding case is now named for what it shows: floor rounding can leave 1-atom
  marginal buys unfilled, with the dust covered by the bond.

Full suite: 19 files, 91/91.

Remaining: running the verifier over every devnet cross needs devnet cross_core on the current
layout (HUMAN_TASKS H10).
