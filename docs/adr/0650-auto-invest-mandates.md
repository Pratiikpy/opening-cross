# ADR-0650: Auto-invest mandates are a program, `cross_mandate` (S4, J2)

Status: accepted (2026-10-14) · Supersedes the "not built" outcome of ADR-0414 for S4 and J2 · Builds on ADR-0450

## Context

An agent that invests for a person is only safe if its limits and the person's kill switch are enforced by the chain. `cross_core::commit_order` takes the order's owner as a signer and pays the escrow from the owner's token account, so an agent can act today only with the owner's own key. SPL delegation does not help: the delegate cannot sign as the order's owner. ADR-0414 recorded the program that would fix this; this ADR builds it.

## Decision

A new program, `cross_mandate`, and no change to `cross_core`, `cross_gate` or `cross_settle`.

- A `Mandate` (`["mandate", owner, id]`) names an owner and one agent and holds the limits. A **signer PDA** (`["mandate_signer", mandate]`, owned by the system program, no data) is the owner of every order the mandate places and of the **vault**, its associated token account for the quote mint. It has no data so it can pay the rent of an order account, which `commit_order` takes from its owner.
- **The budget is the vault.** The owner funds it; the agent can only commit orders from it. A refund, a no-print or an unfilled remainder pays the quote back into the same account, because `claim` pays the order's owner and the owner is the signer PDA.
- `place_order` (agent only) checks, in order: not revoked; before `expires_at`; escrow at most `max_per_order`; lifetime committed plus the escrow at most `total_cap`; the vault holds the escrow; the cross is quoted in the mandate's token and is on the allow list (a base mint already bound, a creator, or one named cross); the order can buy at most `max_share_bps` (at most 2,500) of the cross's declared supply; the signer PDA holds the order's rent. Then it calls `commit_order` as a buy, signing with the PDA. Sells are not available.
- **Share limit.** The reference supply is the cross's hard cap on delivered base (`max_matched`) when it has one, else its declared `total_supply`; a cross that declares neither is refused (`NoSupplyReference`), because a share of an unknown is not a limit. For an open cross the order's own quantity is measured. For a sealed cross the quantity is hidden, so the bound is the most the escrow could buy at the cross's lowest price, `floor(escrow * price_scale / min_price)`; this is an upper bound because `commit_order` and `reveal_order` refuse an order that costs more than its escrow. A sealed order with a limit price above the minimum therefore needs a smaller share than an open one. This is stricter, never looser.
- **Kill switch.** `revoke` (owner) is immediate and permanent. `withdraw` and `withdraw_lamports` (owner) work at any time, also after expiry and revocation. The owner and the agent can `cancel_order` and `reveal_order` (the commitment was fixed when the order was authorised); nobody else can.
- **Where the proceeds go.** The quote side returns to the vault. The base side lands in the signer PDA's token account and `sweep` (permissionless) moves all of it to the owner's own account; its destination is bound to the owner by a constraint, and the quote token is refused by `sweep`, so the agent has no instruction that moves a token anywhere but into a cross or to the owner.
- **Reading the cross.** The program declares `cross_core`'s interface from its IDL (the way `cross_settle` does) and reads the supply reference from the extension tail by byte offset (ADR-0450 guarantees the tail is never reordered and is versioned). A host test builds a real `CrossExt` and asserts the offsets, the cross body size and the order size against the `cross_core` crate, so a change to the tail fails that test and not a mandate. This keeps the binary at 368 KB instead of linking `cross_core`.

## What is not enforced, and said plainly

- `total_cap` counts every escrow ever committed, refunded or not; it is a ceiling on activity, not a balance. The vault balance is the hard budget.
- The share limit is a limit on one order. Several orders can together exceed it; `total_cap` and `max_per_order` bound that, and the cross's own caps apply on top.
- "Integrity-gated inputs" (an authenticity check on the base mint before an order) is an off-chain check in the agent and the API; the program offers the allow list instead, which the owner controls.
- Gated crosses (a `cross_gate` pass) and identity-limited crosses need the signer PDA to hold the pass or the applicant record; the program forwards the remaining accounts but does not create them.
- The agent chooses the price within the limits. A mandate does not make an agent's judgement good; it makes its worst case small and known.

## Consequences

- A new program id, `83EvNHUpKzguAUmyBHJgktVsVLzp3sCXYysgzmToLhs1` (keypair in `.keys/cross_mandate-program.json`), a client package `@opening-cross/cross-mandate-client`, 10 instructions, 8 events, 17 errors.
- No existing account changes, so nothing deployed is affected.
- The app layers add: SDK builders and a mandate page (create, fund, limits, expiry, an always-visible revoke), the indexer projection of the 8 events, an API read route, and an MCP tool for the agent side. The list is in `docs/evidence/W3D-S4.md`.
