# Q2: fuzzing the clearing rule, and the other Q2 tools

Run: 2026-10-13, WSL2 Ubuntu 22.04. Result: **cargo-fuzz works; one real fuzz target over `clearing-core` ran for 15 minutes on 8 workers (120 CPU-minutes, 11,968,260 executions, 4,278 corpus entries) with 0 crashes; the target kills 5 of 5 hand-made defects in the crate; Mollusk and Surfpool also install and run.**

## The target

`crates/clearing-core/fuzz/fuzz_targets/clear_vs_reference.rs` (own detached workspace in `crates/clearing-core/fuzz`, so the repository workspace and its pinned stable toolchain are untouched). Each input is a price grid (`OffsetGrid` with a random minimum, tick and 2 to 49 ticks, or `LinearGrid`), an optional reference price on the grid, and up to 48 orders (side, grid price, quantity with a random right shift so that 1 atom and `u64::MAX` both occur). It asserts:

1. **Agreement with an exhaustive reference.** `clear` returns the same `(price, matched)` as the ADR-0003 rule evaluated directly from the order list at every grid price (the same reference the proptest suite uses, here over arbitrary grids and 64-bit quantities).
2. **Uniform price.** Every fill is computed from the single `Clearing` price; no filled order has a limit on the wrong side of it, and nothing fills beyond its quantity (`fill <= quantity`).
3. **Strictly better orders fill completely; strictly worse orders do not fill.**
4. **Volume conservation.** `Σ sell fills >= Σ buy fills`, the gap is at most `max_dust()` (the number of rationed orders), and `Σ buy fills <= matched <= Σ sell fills`.
5. **Rounding favours the protocol.** For every filled order `buyer_pays >= seller_receives` at the clearing price.
6. **Order independence.** Reversing the order list gives the identical `Clearing`.

## Result

```
cargo +nightly fuzz run clear_vs_reference -- -max_total_time=900 -jobs=8 -workers=8
worker executions in ~903 s: 1,498,990  1,549,418  1,507,413  1,509,560  1,432,939  1,473,525  1,537,799  1,458,616   (total 11,968,260)
crashes / artifacts: 0        corpus: 4,278 inputs        exit 0
```

No defect was found in `clearing-core`, so the crate was not changed.

## Does the target detect defects? (mutation check)

A clean run proves nothing unless the target can fail. Each change below was made to `crates/clearing-core/src/lib.rs`, fuzzed for 45 to 60 seconds, and reverted (`git diff crates/clearing-core/src` is empty):

| Defect introduced | Result | First failure |
|---|---|---|
| sell rationing rounds down instead of up | killed | `sold 0 < bought 1` (volume conservation) |
| tie-break picks the highest price instead of the lowest | killed | disagrees with the exhaustive reference: sell at 0, buy at 176090972160, one atom each |
| smallest imbalance replaced by largest | killed | disagrees with the exhaustive reference |
| buy rationing rounds up instead of down | killed | `sold 1 < bought 2` |
| nearest-to-reference replaced by farthest | killed | disagrees with the exhaustive reference |

## Other Q2 tools

| Tool | Installable and runnable? | What was done |
|---|---|---|
| cargo-fuzz | Yes | `cargo-fuzz 0.13.2` was already installed; `cargo +nightly fuzz build` takes 21 s; nightly is `rustc 1.99.0-nightly (2026-07-25)` |
| Mollusk | Yes, on nightly only | `mollusk-svm 0.16.1` needs `rustc 1.97.1`; the repository pin (1.96.1) and 1.92.0 cannot build it ("solana-program-runtime@4.3.0 requires rustc 1.97.1"), `+nightly` can. A probe crate outside the repository loaded the real `target/deploy/cross_core.so` and executed it: the program answered an unknown instruction with Anchor error 101 (`InstructionFallbackNotFound`) after 1,343 of 1,400,000 compute units. No Mollusk tests were added to the repository |
| Surfpool | Yes | `surfpool 1.6.1` (release `solana-foundation/surfpool`, linux-x64 binary) runs in WSL with `start --offline --no-tui --no-studio`; `getVersion` reports `solana-core 4.2.1`; an airdrop of 50 SOL worked and `solana program deploy target/deploy/cross_core.so` succeeded against it. No tests were written against it |

## Not covered

- Only `clear`, `fill`, `buyer_pays`, `seller_receives` are fuzzed. `PrintGuards::check`, the program instructions and the on-chain accounting are not (they are covered by the LiteSVM suite and the conformance vectors).
- Prices are limited to `min + index * step` with `min < 2^32` and `step < 2^32`, and 49 grid points, so that the exhaustive reference stays exact; behaviour near `u64::MAX` prices is not fuzzed (the crate uses checked arithmetic and `#![deny(clippy::arithmetic_side_effects)]`).
- The target compares `clear` with a reference written for this target from the same ADR; it is not the TypeScript verifier. The cross-language check is the 525 conformance vectors (`docs/evidence/D5-conformance.md`).
- Coverage of `clearing-core` was not measured (no `cargo fuzz coverage` run).
- Fifteen minutes is a bounded run, not proof of absence; the mutation table is the evidence that the target is sharp, not that the crate is correct.

## Reproduce

```sh
cd crates/clearing-core
cargo +nightly fuzz run clear_vs_reference -- -max_total_time=900 -jobs=8 -workers=8
```
