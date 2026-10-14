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
- `met_lock.json` — Meteora Met Lock (`locker`) v0.5.0, extracted from `@meteora-ag/met-lock-sdk` 1.0.1 (MIT licence, © Meteora). Interface only; called at its deployed address.
- `zap.json` — Meteora Zap v0.2.0, extracted from `@meteora-ag/zap-sdk` 1.3.2 (licence per that package). Interface only; no code in this repository calls it yet.
- `alpha_vault.json` — Meteora Alpha Vault v0.4.0 from the Meteora damm-v2 repository's test helpers (`tests/helpers/idl`, Apache-2.0 per that repository's `license.md`). Its declared address is the local-test one; the adapters call the mainnet id `vaU6kP7i…`. Interface only.
- `presale.json` — Meteora Presale Vault v0.1.1, extracted from `@meteora-ag/presale` 0.1.1 (licence per that package). Interface only; called at its deployed address `presSVxnf9UU8jMxhgSMqaRwNiT36qeBdNeTRKjTdbj` by `cross_settle::open_fixed_price_presale`.
