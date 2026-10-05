# Audit package

What an external auditor needs, in reading order.

## Scope

| Program | Path | Purpose |
|---|---|---|
| `cross_core` | `programs/cross_core` | Orders, commit–reveal, sharded book, clearing, claims, fees, pause |
| `cross_gate` | `programs/cross_gate` | Eligibility passes (allowlist, SAS, Merkle), transfer-hook locks |
| `cross_settle` | `programs/cross_settle` | Settlement adapters: Meteora DBC, DAMM v2, DLMM, Raydium CPMM |
| `cross_calendar` | `programs/cross_calendar` | Sessions and feeds behind a ≥7-day timelock |
| `treasury` | `programs/treasury` | Ownership-coin treasury: allowance, attestation gate, liquidation (ADR-0014) |
| `sas-attestation` | `crates/sas-attestation` | Shared SAS attestation parser |
| `clearing-core` | `crates/clearing-core` | The clearing rule; `no_std`, no `unsafe`, `clippy::arithmetic_side_effects` denied |

Out of scope: the off-chain services and the web app. They hold no protocol authority. Their
threats are in `THREAT_MODEL.md`.

## Read first

1. `docs/adr/0003-clearing-rule.md`: the rule. Then `0005-cross-core.md`, `0010-fee-model.md`, and
   `0004`/`0012` (gating).
2. `docs/security/THREAT_MODEL.md` and `docs/security/INVARIANTS.md`.
3. The adapters: ADR-0006 to 0009.

## Build and test

Toolchain (ADR-0001): Rust 1.96.1, Anchor 1.0.2, Agave 4.0.2, Node 22, pnpm 10.32.1.

```sh
pnpm install --frozen-lockfile
cargo test --workspace --release             # clearing-core proptests, CPI crate
sh scripts/build-programs.sh
sh tests/fixtures/fetch.sh                   # Meteora, Raydium, SAS binaries from mainnet
DATABASE_URL=postgres://... pnpm --filter @opening-cross/core-tests test
```

The program suite runs every instruction against LiteSVM, including the third-party programs
dumped from mainnet. It covers adversarial cases, 25 randomized crosses checked against an
independent implementation, compute budgets, and the 525 conformance vectors run on the program.
CI runs all of it on every push (`.github/workflows/ci.yml`).

## Known limitations and deliberate choices

- Upgrade authority is a single devnet key today; L3 moves it to a Squads multisig with a timelock.
- The admin can change the fee schedule for **new** crosses only, and pause new activity.
  Neither power can reach live escrow.
- Sealed bids are commit–reveal; an unrevealed bid is refunded, not executed.
- The oracle guard trusts Pyth's receiver programs; the feed id is pinned per cross.
- Third-party adapters CPI into Meteora and Raydium programs at the versions dumped from mainnet
  (see `tests/fixtures/fetch.sh`).

## Contacts and process

Findings go to the repository's security advisories (private). Every finding and its fix will be
published after the fix is deployed.
