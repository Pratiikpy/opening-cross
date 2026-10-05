# Program IDLs used for typed CPI (`declare_program!`)

- `dynamic_bonding_curve.json` — Meteora Dynamic Bonding Curve v0.2.1 IDL, copied from
  `@meteora-ag/dynamic-bonding-curve-sdk` 1.5.13 (MIT licence, © Meteora). Only the interface is
  used; the program itself is called at its deployed address and never copied.
- `cross_core.json`, `cross_gate.json` — this repository's programs (regenerated with
  `anchor idl build`).
