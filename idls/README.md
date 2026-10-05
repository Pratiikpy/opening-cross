# Program IDLs used for typed CPI (`declare_program!`)

- `dynamic_bonding_curve.json` â€” Meteora Dynamic Bonding Curve v0.2.1 IDL, copied from
  `@meteora-ag/dynamic-bonding-curve-sdk` 1.5.13 (MIT licence, Â© Meteora). Only the interface is
  used; the program itself is called at its deployed address and never copied.
- `cp_amm.json` — Meteora DAMM v2 (cp-amm) v0.2.5 IDL, copied from `@meteora-ag/cp-amm-sdk`
  (MIT licence, © Meteora). Interface only; the program is called at its deployed address.
- `lb_clmm.json` — Meteora DLMM v0.12.0 IDL, copied from `@meteora-ag/dlmm` (ISC licence). Interface
  only; the program is called at its deployed address.
- `cross_core.json`, `cross_gate.json` â€” this repository's programs (regenerated with
  `anchor idl build`).
