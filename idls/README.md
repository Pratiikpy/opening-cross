# Program IDLs used for typed CPI (`declare_program!`)

- `dynamic_bonding_curve.json` — Meteora Dynamic Bonding Curve v0.2.1 IDL, copied from
  `@meteora-ag/dynamic-bonding-curve-sdk` 1.5.13 (MIT licence, © Meteora). Only the interface is
  used; the program itself is called at its deployed address and never copied.
- `cp_amm.json` — Meteora DAMM v2 (cp-amm) v0.2.5 IDL, copied from `@meteora-ag/cp-amm-sdk`
  (MIT licence, © Meteora). Interface only; the program is called at its deployed address.
- `lb_clmm.json` — Meteora DLMM v0.12.0 IDL, copied from `@meteora-ag/dlmm` (ISC licence). Interface
  only; the program is called at its deployed address.
- `raydium_cp_swap.json` — Raydium CPMM v0.2.0 IDL from `raydium-io/raydium-idl` (Apache-2.0).
  Interface only; the program is called at its deployed address.
- `cross_core.json`, `cross_gate.json` — this repository's programs (regenerated with
  `anchor idl build`).
