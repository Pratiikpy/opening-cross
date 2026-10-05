# ADR-0001: Toolchain pins

Date: 2026-10-05 · Status: accepted

## Context
Arcium is the only private-order backend we plan to use, and it pins Anchor exactly. Versions were read from crates.io and npm on 2026-10-05.

## Decision
- Anchor **1.0.2** (Rust and CLI). `arcium-anchor 0.15.0` depends on `anchor-lang =1.0.2`; Meteora DBC and DAMM v2 also build with 1.0.2. Anchor 1.2.0 is newer but would exclude Arcium.
- Arcium crates and `@arcium-hq/client` **0.15.0**.
- Agave / `cargo build-sbf` **4.0.x** (platform-tools v1.53), Rust **1.96.1** host toolchain.
- TypeScript clients on **@solana/kit 8.4.0** with Codama-generated program clients (`codama 1.11.0`); `@solana-program/token-2022 0.19.0`. No `@solana/web3.js` v1 in new code.
- Node **22**, pnpm **10.32.1**, TypeScript **7.0.2**, Vitest **5.0.3**.
- Testing: LiteSVM **0.17.0**, Mollusk **0.15.1**.

## Consequences
Upgrading Anchor waits for an Arcium release that supports it. Every upgrade is a new ADR.
