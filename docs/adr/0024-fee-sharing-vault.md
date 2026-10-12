# ADR-0024: Fee-sharing vault for the fees a cross's market earns

Status: accepted (2026-10-13)

## Context

A cross opens liquidity on Meteora at P*. The pools earn trading fees in the quote token, and an issuer with a treasury, backers or a rewards pool needs to split them without a trusted middleman. FEATURE_STATUS row D7 listed fee-sharing routing as not built.

## Decision

Use Meteora's own Dynamic Fee Sharing program (`dfsdo2UqvwfN8DuUVrMRNfQe11VaiNoKcMqLHVvDPzh`). `packages/adapters/src/feeshare.ts` builds its three instructions directly, so the adapters package takes no new dependency: `buildCreateFeeShareVault` (the PDA variant, one to five recipients, share weights), `buildFundFeeShareVault` (anyone can fund) and `buildClaimFeeShare` (a recipient claims its part). The builder rejects an empty list, more than five recipients, duplicates and zero shares before anything is sent.

## Consequences

- Splitting is by share weight and exact: 1,000,000,000 funded atoms split 6000/3000/1000 paid 600,000,000, 300,000,000 and 100,000,000.
- Only the recipient at an index can claim that index.
- Not built: the bridge that pulls a DAMM v2 position's fees straight into the vault. It needs the position NFT account owned by the vault and a vault shareholder to sign; until it is built, fees reach the vault by `fundFee` after the position owner claims them. The row stays PARTIAL.
- Proven on the real program binary in LiteSVM; not on devnet (no SOL).
