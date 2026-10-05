# opening-cross-cpi

CPI bindings for [Opening Cross](https://github.com/Pratiikpy/opening-cross): program IDs,
account types, instruction arguments, PDA derivations and typed CPI calls into `cross_core` and
`cross_gate`, generated with Anchor's `declare_program!` from the IDLs in `idls/`.

```toml
[dependencies]
anchor-lang = "=1.0.2"
opening-cross-cpi = "0.1"
```

```rust
use opening_cross_cpi::{cross_core, pda};

let (order, _) = pda::order(&cross, &owner, nonce);
cross_core::cpi::commit_order(CpiContext::new(cross_core_program, accounts), args)?;
```

`examples/venue` in the repository is a complete program that routes its users' orders into a
cross with one CPI through this crate. Licensed Apache-2.0.
