# D4 — TypeScript packages and Rust CPI crate (2026-10-05)

## TypeScript
Eight packages are publishable: `cross-core-client`, `cross-gate-client`, `cross-settle-client`,
`cross-calendar-client`, `sdk`, `verifier` (with the `opening-cross-verify` binary),
`token-safety`, `adapters`. Each builds to `dist/` with declarations; `publishConfig` points the
packed manifest at `dist/` while the workspace keeps using sources, and `workspace:*` ranges
become real versions at pack time. Each has a README.

`examples/ts-quickstart/run.sh` packs the four packages an integrator needs, copies the
quickstart into a fresh temp directory outside the workspace, installs only those tarballs from
npm-style tarballs plus public npm dependencies, typechecks against the published `.d.ts`
(`skipLibCheck: false`), and runs a complete sealed launch on LiteSVM with the released
`cross_core.so`. Output (WSL, 2026-10-05):

```
cleared at 1200000 quote atoms per token for 5000000000 base atoms
bidder at 1500000: 2000000000 base atoms, 7600000000 quote atoms
bidder at 1300000: 2000000000 base atoms, 7600000000 quote atoms
bidder at 1200000: 1000000000 base atoms, 8800000000 quote atoms
fairness proof: verified=true state=Finalized price=1200000
```

Checked by hand: supply 5 tokens; demand at 1.2 is 6, so P* = 1.2 with the marginal 1.2 bidder
rationed to 1 token; each buyer pays 1.2 per token (10 − 2.4 = 7.6, 10 − 1.2 = 8.8).

## Rust
`crates/opening-cross-cpi`: `declare_program!` bindings for `cross_core` and `cross_gate` from
IDLs shipped in the crate (CI diffs them against `idls/`), plus every PDA derivation.
`cargo test -p opening-cross-cpi`: program IDs, seeds, derivations and an Order serialised by
the program and decoded by the binding all match (4/4). `cargo package -p opening-cross-cpi`
builds the crate from its packaged sources alone. `examples/venue` now depends on the crate
instead of declaring the program itself; `tests/core/test/venue.test.ts` passes (2/2).

CI runs the quickstart and `cargo package` on every push.

## Not done here
Publishing to npm and crates.io needs registry accounts and tokens: HUMAN_TASKS H12. Both
names were unclaimed on 2026-10-05.
