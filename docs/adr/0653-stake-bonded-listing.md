# ADR-0653: Stake-bonded listing is a program, `cross_listing` (L1)

Status: accepted (2026-10-14)

## Context

[L1] "White-label infrastructure: partner fees, stake-bonded permissionless listing". Partner fees exist (`claim_partner_fee`, ADR-0481). Permissionless listing on a venue needs a price on failing to deliver what a listing promised, and that price must be enforced by the chain: a bond held in a vault, taken only on a fault the chain itself can prove.

## Decision

A new program, `cross_listing`. A **venue** (`["venue", creator, id]`) is created with terms that never change: the bond token, the bond a listing sets aside (`min_bond`), a release delay of at least a day, and the owner of the account that receives slashed bonds. A **lister** opens a bond account and vault on the venue, deposits, and lists a cross **it created** that is still taking orders; the listing sets aside `min_bond`.

- The bond is the lister's: `withdraw_bond` takes back only what no open listing has set aside.
- **Release** (permissionless): once the cross is finalized, or did not print for a market reason, and the delay after its close has passed, the set-aside bond is free again.
- **Slash** (permissionless): the one fault the cross account proves without a judge is `NoPrintReason::SettlementExpired` — a deferred-mint cross whose settlement adapter did not bind a mint by the deadline. Only `cross_core` writes that. The set-aside bond goes to the venue's slash account. Buyers are not paid from the bond: they are refunded in full by the cross itself; the bond is the price of the failure, paid by the one who promised the settlement.
- A listing is released or slashed exactly once. A release of a faulted cross and a slash of an honest one are both refused.

## What this does not claim

- It does not judge a listing's quality, legality or honesty. The other no-print reasons (below minimum volume, oracle divergence, halted) are market or issuer-state outcomes, not faults, and release the bond.
- The venue's slash recipient is chosen by the venue's creator once, in the open. A venue that sets it to its own wallet profits from slashes; the conditions for a slash are objective, so it cannot create one.
- Insider challenges have their own bond inside `cross_core` (ADR-0454) and are not duplicated.

## Consequences

- Program id `6VsT7X4G7qjRaredx4Y9q6asGkySiXGVpNr4RrdbxSSi`, client `@opening-cross/cross-listing-client`, 7 instructions, 6 events, 15 errors.
- The issuer wizard and the API add: venue pages, a "list on this venue" step that shows the bond, and the listing state on a cross (`docs/evidence/W3D-L1.md`).
