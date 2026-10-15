# ADR-0974: The v2 rules are a second WebAssembly module built beside the loader, and are run in a browser

Status: accepted (2026-10-16) · Row V-E · Code `packages/clearing-wasm` (`rust/`, `src/v2.ts`, `test/`) · Evidence `W5-1H.md` · Extends ADR-0300

## Decision

1. **`clearing-v2.wasm` exposes what a cross applies on chain beyond the base rule**: a hard supply cap, the minimum-raise, float, valuation and price-move guards, allocation classes with reserved shares and spill-over, the class-1 lottery with the start reduced modulo the tickets, and declared insiders left out of the minimum raise (ADR-0101, 0104, 0105, 0106). It calls `clearing-core` only: `clear_with`, `check_all`, `class0_fill_upper_bound`, `fill_with_policy`. It follows the path `crates/clearing-core/examples/conformance_vectors_v2.rs` documents as the program's, field for field.
2. **A guard that stops the print still reports where the cross would have cleared** (`wouldClearAt` and the cleared summary), because "it would have cleared at 180 but the raise was short" is what an issuer previewing a book needs to be told.
3. **It refuses what the rule cannot apply**: a zero price scale, class reserves that add to more than 10,000 basis points, a class or insider flag on a sell, a class above 3.
4. **The module is built from `packages/clearing-wasm/rust`** (its own workspace, `clearing-core` by path) and not by extending `crates/clearing-wasm`. The v1 module and its package stay as they were; the v2 loader sits beside them (`loadClearingV2`). Moving the v2 entry point into `crates/clearing-wasm` so one module serves both is the cleaner end state and needs a change outside this package (stated in the evidence).
5. **It is proved by the program's own vectors and by a browser.** All 437 v2 vectors, and the 525 v1 vectors through the same module with no v2 rules (which must give the v1 module's answers). A Chromium test fetches both modules and the vectors as a web app would and runs all of them in the page.

## Alternatives rejected

- Re-implementing the guards in TypeScript: a second implementation, which is what ADR-0300 exists to avoid.
- One C interface with every v2 argument as a parameter: eleven scalar arguments and a fixed-layout rules record are less error-prone than twenty.

## Consequences

The v2 module is 37 KB, not size-optimised past `opt-level = "z"` (no `wasm-opt` was available). Whether the module builds byte-identically on another machine is not verified. The committed `clearing-v2.wasm` is not rebuilt by CI. Firefox was not run (not installed). The guards that read outside accounts (oracle divergence, a halt flag, a pause extension) are not in any module, by design: only the program can evaluate them.
