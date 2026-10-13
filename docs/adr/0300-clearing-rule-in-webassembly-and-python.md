# ADR-0300: The clearing rule in WebAssembly, and an independent Python rule

Status: accepted, 2026-10-13. Row: V-E.

## Decision

1. `crates/clearing-wasm` compiles `clearing-core`, the crate the program runs on chain, to `wasm32-unknown-unknown` behind a small C interface (`alloc`, `dealloc`, `preview`, `buyer_pays`, `seller_receives`). It aggregates orders into price levels, calls `clearing_core::clear`, applies the print guards and computes every fill with `clearing_core::fill`, which is the path `cross_core::clear` takes. It holds no second copy of the rule.
2. `packages/clearing-wasm` ships the optimised module (`clearing.wasm`, about 24 KB) and a typed loader for browsers and Node. A holder can preview where a book would clear without a server.
3. `tools/simulator` holds a plain-Python rule written from ADR-0003, not from the Rust, plus a seeded Monte-Carlo simulator. It runs against the same 525 conformance vectors as the Rust and TypeScript implementations, and against the compiled module on random books.

## Why

- A preview that is a re-implementation can drift from the chain. A preview that is the chain's own code compiled cannot, so the module is the preview.
- A raw C interface instead of wasm-bindgen: no generator, no JavaScript glue to trust, and the same module loads from Python (wasmtime) and any other runtime. The cost is a hand-written byte layout, which the tests exercise from two languages.
- The Python rule is deliberately a third, slow, exhaustive implementation. Three independent readings of the ADR agreeing on 525 vectors and 1,500 random books is evidence a single implementation cannot give.
- Orders larger than 64 bits and grids of more than 65,535 prices are refused, as in the program.

## Consequences

`clearing.wasm` is a build artefact committed with the package; `pnpm --filter @opening-cross/clearing-wasm build` regenerates it (needs the `wasm32-unknown-unknown` target and `wasm-opt`). A change to `clearing-core` must be followed by a rebuild; the conformance test fails if the committed module disagrees with the vectors the Rust generator writes.

The simulator is a model with parameters a person chose and is not calibrated to live traffic.
