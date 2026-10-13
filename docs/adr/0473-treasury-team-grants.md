# ADR-0473: milestone team tokens with a minimum lockup; earn-out and carve-out terms

Status: accepted (2026-10-13) · PRODUCT_FEATURES E4, A6

## Decision

The team escrows coins in the treasury's coin vault as a **grant**: a beneficiary, a total, a lockup end no earlier than `now + min_lockup_secs` (set when the treasury is extended), an expiry, and up to four milestones, each a share in basis points. Nothing is released before the lockup ends. A milestone is either a **carve-out** (released after the lockup with no further condition: the part of founder compensation that is not contingent) or an **earn-out** (released only against a live SAS attestation at `sha256("oc-milestone" ‖ grant ‖ index)` under the grant's credential and schema: a milestone someone independent signs off). Anyone may crank a release; the coins go to the beneficiary. Whatever has not been released at the expiry is burned by `expire_grant`, which raises the value of every other coin. A liquidation forfeits all unvested grants at once and excludes them from the redemption snapshot, so that no holder's share is stranded behind coins nobody can redeem. These two templates, a carve-out and an earn-out with a burn, are the "founder-fair terms" of A6: the founders' fixed share is explicit and early, the contingent share is earned or destroyed, and neither can be adjusted after creation.

## Limits

- The attester of an earn-out milestone is trusted for the milestone, as in ADR-0472.
- The minimum lockup is a parameter the team sets at extension; holders must read it. Setting it to zero is allowed and visible.
- Grants are of coins the team already holds; there is no mint (the coin's supply is fixed).
- Proved on LiteSVM (`treasury-grants.test.ts`, 4 grant tests). Devnet proof pending.
