# @opening-cross/clearing-wasm

The Opening Cross clearing rule in the browser or Node: the same `clearing-core` crate the program runs on chain, compiled to WebAssembly (24 KB). Use it to preview where a book would clear before an order is placed.

```ts
import { readFile } from 'node:fs/promises';
import { loadClearing } from '@opening-cross/clearing-wasm';

const rule = await loadClearing(await readFile('clearing.wasm'));   // or fetch(url).then((r) => r.arrayBuffer())
const r = rule.preview({ grid: { min: 100n, tick: 10n, ticks: 20 }, orders: [{ side: 'buy', price: 160n, quantity: 10n }, { side: 'sell', price: 150n, quantity: 6n }] });
// r.printed, r.price, r.matched, r.rationed, r.fills (one per order, in input order)
rule.buyerPays(3n, 150n, 100n);       // 5n: rounded up
rule.sellerReceives(3n, 150n, 100n);  // 4n: rounded down
```

It does not re-implement the rule. It lays orders out in memory, calls the compiled module, and reads the answer back; prices must lie on the grid, quantities and prices fit 64 bits, and the module refuses what the program refuses. The test reproduces all 525 conformance vectors of `packages/verifier/conformance/v1.json`, fills included. Rebuild after any change to `crates/clearing-core`: `pnpm --filter @opening-cross/clearing-wasm build` (needs the `wasm32-unknown-unknown` target and `wasm-opt`). It also loads from Python (`tools/simulator`).

The v2 rules are in a second module, `clearing-v2.wasm` (37 KB, built from `rust/` against the same `clearing-core`), loaded with `loadClearingV2`: a hard supply cap, the minimum-raise, float, valuation and price-move guards, allocation classes with reserved shares, the class-1 lottery, and declared insiders left out of the minimum raise. When a guard stops the print the result still says where the cross would have cleared (`wouldClearAt`). `test/conformance-v2.test.ts` reproduces all 437 v2 vectors the program generated, and the 525 v1 vectors through the same module with no v2 rules; `test/browser/run.mjs` runs the same vectors in Chromium. Rebuild with `pnpm --filter @opening-cross/clearing-wasm build:v2` (needs the `wasm32-unknown-unknown` target).

Not exposed by either module: the checks that read accounts outside the book (an oracle, a halt flag, a pause extension), which only the program can evaluate. Evidence: `docs/evidence/W2A-V-E-clearing-wasm.md`, `docs/evidence/W5-1H.md`; decisions: `docs/adr/0300-clearing-rule-in-webassembly-and-python.md`, `docs/adr/0974-clearing-rule-v2-in-webassembly.md`.
