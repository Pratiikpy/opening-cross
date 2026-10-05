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
- **cross_hook → cross_gate.** Same program ID; now also an sRFC-37 Token ACL gate. Redeployed (`3wG7BGYn…EWUZA`). DBC regression 16/16 PASS.
- **DP8 done** (`docs/evidence/DP8-token-acl.md`, 11/11 PASS): permissionless thaw for pass holders, refusal for others, frozen-destination transfer blocked, freeze after revocation, gate refuses direct calls. Spec/implementation mismatch found and followed to the implementation: Token ACL derives meta-list PDAs with underscores, the sRFC-37 text shows hyphens. ADR-0004 records the gating architecture.
- **cross_core built** (ADR-0005): protocol config with guardian pause that never blocks claims/refunds; escrow and mint supply modes; sealed commit-reveal and open books; sharded per-tick aggregation; permissionless merge, clear (clearing-core), claim and finalize; fee snapshot paid by the sell side; dust bond; gated crosses via cross_gate passes; mint authority revoked after allocation (returned on no-print).
- **TypeScript SDK** `@opening-cross/sdk` (addresses, commitments, builders) and Codama clients from committed IDLs (`packages/codegen`).
- **Tests** `tests/core` on LiteSVM (WSL/CI): 46/46 — mint launch, sealed reopen with a non-revealer, no-print, guards, 15 attack cases, 25 randomized end-to-end runs (200-run stress 200/200) against an independent TypeScript implementation of ADR-0003 with exact conservation of every atom.
- **Compute:** bid placement cut from 46k to 20–21k CU (client-supplied order bump, stored vault bumps, side-specific accounts, no instruction-name logs).
- Next: deploy cross_core to devnet and run the same flows there; Meteora DBC continuation adapter (A1).
- **Devnet run of cross_core** found a real bug: `finalize` failed when one wallet was issuer, integrator and fee recipient. Fixed (aliasing allowed on payout accounts, base ≠ quote enforced), regression tests added — 48/48. Anchor macro crates were silently resolving to 1.2.0; pinned back to 1.0.2 per ADR-0001. Devnet re-deploy of the fix waits on H10 (devnet SOL top-up).
- Machine: disk was full (121 MB free) and a power loss interrupted the session; build cache cleared, 36 GB free now.
- **A1 Meteora DBC continuation built** (ADR-0006): `cross_core` deferred-mint launches (bind by registered settler, abandon after deadline → full refunds); `programs/cross_settle` opens a DBC transfer-hook config and pool at exactly P\* (on-chain floor-sqrt check), installs cross_gate in open mode, moves mint authority to the cross and binds; `packages/dbc-adapter` builds the config from the issuer's curve design and both instructions. LiteSVM against the real mainnet DBC binary (dumped, not committed — licence): 54/54, DBC pool sqrt price = P\* exactly, tampered price and non-creator refused. DP3 done: 141k + 64k CU.
- Devnet deploy of cross_core v2 and cross_settle waits on H10 (devnet SOL).
