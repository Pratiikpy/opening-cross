# Mollusk tests

Instruction-level tests of `cross_core` against the built binary (`target/deploy/cross_core.so`): one instruction, hand-built accounts, and a check of exactly what changed, which error came back and how many compute units it took. The LiteSVM suites in `tests/core` run whole flows; these are for a single instruction's contract.

```
cargo +nightly test            # from tests/mollusk, after `anchor build` (or cargo build-sbf) has produced target/deploy/cross_core.so
cargo +nightly test -- --nocapture   # also prints the compute units of init_protocol, set_paused and an unknown instruction
```

Why nightly and why a separate workspace: `mollusk-svm 0.16.2` pulls `solana-program-runtime 4.3.x`, which needs a compiler newer than the repository's pin (1.96.1). The crate is its own workspace (`[workspace]` in `Cargo.toml`) so the programs keep building with the pin. Verified on Windows (MSVC) with `rustc 1.101.0-nightly (e9bbadf68 2026-10-12)`; 11 tests pass.

What they pin: the Anchor discriminators (derived and compared with the IDL's), `init_protocol` writing exactly the given fields into a 147-byte account the admin pays for, the 100 bps fee cap on all four slots (accepted at 100, refused at 101 with `FeeTooHigh`), no second init, `set_paused` by guardian or admin and by no one else (and only a key that signed), the protocol PDA seed constraint, `set_guardian` and `set_protocol_fees` being the admin's alone, the two-step admin handover, and the unknown-instruction error.

Not covered here: the order, clearing and settlement instructions (they need token accounts and the cross state machine; `tests/core` covers them end to end), and `cross_gate`, `cross_settle`, `cross_calendar` and `treasury`.
