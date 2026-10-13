# W2A-V-E: clearing rule as WebAssembly, and the Python simulator

Date: 2026-10-13. Decision: ADR-0300.

## What was built

- `crates/clearing-wasm`: `clearing-core` behind a C interface; 5 Rust unit tests.
- `packages/clearing-wasm`: `clearing.wasm` (23.9 KB after `wasm-opt -Oz`) and a typed loader (`loadClearing`, `preview`, `buyerPays`, `sellerReceives`).
- `tools/simulator`: `opening_cross_sim` (plain-Python rule, WebAssembly loader through wasmtime, seeded simulator, CLI) and 13 tests.

## Run

- `cargo test -p clearing-wasm --lib`: 5 passed.
- `packages/clearing-wasm` vitest: 2 passed. All 525 conformance vectors of `packages/verifier/conformance/v1.json` reproduced by the compiled module through the JavaScript loader, price, matched volume, rationed side and every fill; input refusals and money rounding checked. `tsc` for source and tests: clean.
- `tools/simulator`, standard library only: 13 tests, 5 skipped (the ones needing the compiled module), 0 failed; the plain-Python rule reproduces all 525 vectors.
- `tools/simulator` with wasmtime and the module: 13 passed, 0 skipped. The compiled module reproduces all 525 vectors from Python, agrees with the plain-Python rule on 1,500 random books (price, matched volume, rationed side and every fill; grids of 2 to 40 prices, up to 25 orders, quantities up to 10^12, optional reference), and the simulator returns identical results with either rule.
- `python -m opening_cross_sim --trials 300 --sniper 100000000 --wasm`: every trial printed; median clearing price 100 bps above the underlying value (p10 -200, p90 +300); a 100M-atom late buy at the top of the grid moved the clearing price a median of 2 ticks (max 7) and was filled in full. These figures describe the parameters in the scenario, not live traffic.

## Found while testing

- My first test of the late buy assumed it would clear below its limit. With only 6 atoms on offer the only feasible price was the buyer's own limit, which is what the rule says; the test now gives the book enough supply.
- My first wasm build capped grids at 256 prices; one conformance vector has more. Removed the cap, so the limit is the program's own (65,535).

## Not covered

No second-engine check against `packages/verifier` beyond the shared vectors (the TypeScript verifier is exercised by its own suite). v2 vectors (supply caps, allocation classes) are not exposed by the module: it implements the base rule and print guards only. The module was run under wasmtime and Node, not in a browser. The committed `clearing.wasm` is not rebuilt by CI here. The simulator is not calibrated to live data.
