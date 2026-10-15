# ADR-0024: Fee-sharing vault for the fees a cross's market earns

Status: accepted (2026-10-13)

## Context

A cross opens liquidity on Meteora at P*. The pools earn trading fees in the quote token, and an issuer with a treasury, backers or a rewards pool needs to split them without a trusted middleman. FEATURE_STATUS row D7 listed fee-sharing routing as not built.

## Decision

Use Meteora's own Dynamic Fee Sharing program (`dfsdo2UqvwfN8DuUVrMRNfQe11VaiNoKcMqLHVvDPzh`). `packages/adapters/src/feeshare.ts` builds its three instructions directly, so the adapters package takes no new dependency: `buildCreateFeeShareVault` (the PDA variant, two to five recipients, share weights), `buildFundFeeShareVault` (anyone can fund) and `buildClaimFeeShare` (a recipient claims its part). The builder rejects fewer than two recipients, more than five, duplicates and zero shares before anything is sent. (It first allowed one recipient; the real program refuses a vault with fewer than two, `ExceededUser`, which ADR-0912 found by running the binary and corrected.)

## Consequences

- Splitting is by share weight and exact: 1,000,000,000 funded atoms split 6000/3000/1000 paid 600,000,000, 300,000,000 and 100,000,000.
- Only the recipient at an index can claim that index.
- The DAMM v2 bridge is built: `buildTransferDammPositionToFeeVault` hands the position NFT's token account to the vault (one-way), and `buildFundFeeShareFromDammFees` pulls the position's fees into the vault through `fund_by_claiming_fee`. A vault recipient must sign, the vault must be the PDA variant, and the vault token must be the pool's token B.
- Not built: the DBC creator and partner trading-fee bridges. The row stays PARTIAL.
- Proven on the real program binary in LiteSVM; not on devnet (no SOL).
