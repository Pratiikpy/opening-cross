# Opening Cross

One fair price for every new market on Solana.

Opening Cross is an open call-auction protocol: orders collect during a call period, then every filled order clears at a single uniform price. It is used for launches, reopens after weekends and halts, unlocks, tenders and recurring crosses. **Opening Bell** is the app built on it.

> Status: early development on devnet. Nothing here is deployed to mainnet, and nothing here is an offer of securities.

## Repository

| Path | What it is |
|---|---|
| `programs/cross_core` | The call auction: orders, commit–reveal, clearing, claims, fees. |
| `programs/cross_gate` | Eligibility passes (allowlist, Solana Attestation Service, Merkle) and transfer locks. |
| `programs/cross_settle` | Settlement adapters: Meteora DBC, DAMM v2, DLMM, Raydium CPMM at the clearing price. |
| `programs/cross_calendar` | Exchange-calendar sessions and price feeds behind a timelock. |
| `crates/clearing-core` | The clearing rule (ADR-0003), `no_std`, shared by the program and the generator of the conformance vectors. |
| `crates/opening-cross-cpi` | Rust CPI bindings for other programs. `examples/venue` uses it. |
| `packages/sdk`, `packages/*-client` | TypeScript SDK and Codama-generated clients. |
| `packages/verifier` | Independent verifier, fairness proofs, conformance suite. |
| `packages/router` | Best-execution reports: a cross against a live DEX route. |
| `packages/token-safety`, `packages/adapters` | Mint risk reports; settlement-adapter helpers. |
| `services/indexer`, `services/keeper`, `services/api` | Postgres indexer and reconciler, permissionless keeper, REST and WebSocket API. |
| `examples/ts-quickstart` | A full cross from a clean project using only the packed packages. |

## Develop

Toolchain (ADR-0001): Rust 1.96.1 (pinned in `rust-toolchain.toml`), Agave 4.0.2, Node 22, pnpm
10.32.1. Install Agave with `sh -c "$(curl -sSfL https://release.anza.xyz/v4.0.2/install)"`. The
program tests run on Linux (LiteSVM ships no Windows binary); on Windows, use WSL.

```sh
pnpm install --frozen-lockfile
pnpm -r typecheck
pnpm test                                   # package unit tests
cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace --release            # clearing-core, CPI crate
sh scripts/build-programs.sh                # programs -> target/deploy
sh tests/fixtures/fetch.sh                  # Meteora, Raydium and SAS binaries from mainnet (not redistributed)
DATABASE_URL=postgres://... pnpm --filter @opening-cross/core-tests test   # programs on LiteSVM; Postgres for the indexer/API tests
sh examples/ts-quickstart/run.sh            # clean-room install of the packed packages
```

CI runs exactly these commands on a fresh runner for every push.

Engineering rules: [`ENGINEERING_PRINCIPLES.md`](ENGINEERING_PRINCIPLES.md). Roadmap: [`docs/ROADMAP.md`](docs/ROADMAP.md). Decisions: [`docs/adr`](docs/adr).

## Licence

Apache-2.0.
