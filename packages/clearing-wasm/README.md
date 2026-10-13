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

Not exposed: supply caps, allocation classes and the other v2 guards. Evidence: `docs/evidence/W2A-V-E-clearing-wasm.md`; decision: `docs/adr/0300-clearing-rule-in-webassembly-and-python.md`.
