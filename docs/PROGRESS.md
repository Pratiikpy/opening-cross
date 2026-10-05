# Progress log

Newest first. Every entry names what was done, the evidence, what is not verified, and what is next.

## 2026-10-05
- **M0.1 done.** Repository `Pratiikpy/opening-cross` (private until first public release), allowlist `.gitignore`, gitleaks commit guard (tested: blocks staged key files and tokens), CI with typecheck, tests and secret scan — first run green (37282531078).
- **M0.2 in progress.** Toolchain pinned in ADR-0001 from live registry reads (Anchor 1.0.2 forced by Arcium 0.15.0).
- **DP14 done.** `@opening-cross/token-safety` classifies issuer powers per mint; live read of nine mainnet stock tokens in `docs/evidence/DP14.md`.
- Not verified: Backpack exchange weekend policy (part of DP10).
- Next: `clearing-core` (C1), then DBC devnet proofs DP1–DP4.
- **C1 done.** `clearing-core` (ADR-0003): max volume → min imbalance → reference → lowest price, interior gap ticks included, O(1) per-order fills. 10,000-case match against an exhaustive reference plus conservation, order-independence and solvency properties.
- **cross_hook deployed to devnet** (`2pE7gApapcdmbk6713VbrWNjEg1iFFrd15SLt1pQwWqr`, deploy tx `5i1Xo8GwT3WuU4ugKAFgrGkHkCR8RUg3ve6z6sUCtd74GHdrtFp25TFQXVRnsADwM5GSBdMZ5QYnuQoKMgcxEsys`): allowlist passes and non-weakening locks enforced in every transfer. Codama client in `packages/cross-hook-client`.
- **DP1, DP2, DP4, DP5, DP6 done** on devnet against Meteora's deployed DBC and DAMM v2 (`docs/evidence/DP-dbc-hook.md`, 16/16 PASS). Findings: the DBC SDK cannot resolve owner-seeded hook accounts (worked around; upstream fix to propose); DBC strips the hook at graduation, so post-graduation gating/locks need Token ACL or escrow vesting.
- Next: DP3 (atomic settlement measured inside our own program), DP8 Token ACL, then `cross_core`.
