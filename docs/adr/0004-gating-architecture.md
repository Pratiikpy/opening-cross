# ADR-0004: Gating and lockups across a token's life

Date: 2026-10-05 · Status: accepted · Evidence: `docs/evidence/DP-dbc-hook.md`, `DP-dbc-hook-findings.md`, `DP8-token-acl.md`

## Context
Some assets may only be held by verified wallets, and team or allocation lockups must hold for their full term. Devnet proofs established:
- Meteora DBC lets a transfer hook run on every curve swap, but **removes the hook when the curve completes**.
- DBC-created mints have **no freeze authority and no Default Account State extension**, and both can only be set at mint creation, so Token ACL can never be attached to them.
- Token ACL (sRFC-37) gates mints we create: accounts start frozen, owners thaw permissionlessly if the gate program agrees, and anyone can freeze an account whose owner lost eligibility.
- Meteora DAMM v2 rejects mints with Default Account State unless Meteora has issued a Token Badge for the mint (`cp-amm/src/utils/token.rs`).

## Decision
One program, `cross_gate`, holds the passes and locks for a mint and enforces them in both mechanisms: as the mint's transfer hook and as its Token ACL gate. Which mechanism applies depends on the asset class:

| Asset | Mint created by | Enforcement | Graduation venue |
|---|---|---|---|
| Open ownership coin | DBC | Hook during the curve (locks only) | DBC → DAMM v2 |
| Gated asset (identity required for life) | Opening Cross | Token ACL + `cross_gate` gate, plus hook for locks | DAMM v2 only with a Meteora Token Badge; otherwise crosses only |
| Tokenized stock (third-party issuer) | Issuer | Issuer's own controls; our `token-safety` checks | Existing venues |

Lockups that must outlive a DBC curve are held in escrow by the cross program and released on schedule, never left to the hook.

## Consequences
- Product copy may only promise a lock "during the curve" for hooked DBC tokens; post-graduation locks are escrow-backed.
- Gated assets reaching Meteora pools depend on Meteora issuing a Token Badge per mint (human task H9).
- The pass is the single source of eligibility; SAS-credential checks (C5) issue and revoke passes.
