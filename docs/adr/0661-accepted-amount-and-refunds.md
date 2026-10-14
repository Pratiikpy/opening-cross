# ADR-0661: The accepted amount stays a published rule; refunds are pushed by a keeper (B5)

Status: accepted (2026-10-14) · Reaffirms ADR-0451 and ADR-0457 after reviewing the alternative the founder may prefer

## Context

PRODUCT_FEATURES [B5]: "Minimum raise and automatic refunds; issuer chooses the accepted amount within published rules; refunds need no claim." `W2D-B5.md` built the minimum raise, the published hard cap and `push_refunds`, and narrowed "the issuer chooses the accepted amount" to "within a published rule, not after seeing demand", noting that the orchestrator may overrule.

## The accepted amount

A choice made after the book is visible lets an issuer withhold supply to raise a uniform price: with a supply schedule that clears at P for 1,000 tokens and at 1.4P for 600, choosing 600 after seeing the book moves every buyer's price up 40%. The published cap and minimum raise give the issuer its choice **before** bids, where it is a term of the sale and not a lever on the price.

A variant exists that removes the lever: the issuer may accept any amount between the minimum raise and the volume the full supply cleared, and the price stays the full-supply price P (it can sell less, never at a higher price). It is coherent, but it changes the clearing rule: inframarginal buyers would have to be rationed when the accepted amount is below their combined demand, and the rationing order is a new rule that must live in `clearing-core`, its WebAssembly build, the Python simulator and the TypeScript verifier, and be covered by new conformance vectors alongside the existing 525. Every one of those is a claim the product makes ("anyone can recompute this price") and a mistake in any is a mismatch a verifier would report against live crosses.

**Decision: not built.** The row keeps its narrowed wording. If the founder wants the variant, it is a mechanism change (workstream A) with its own ADR, vectors and a verifier release, not a program addition.

## Refunds

`push_refunds` is on chain, permissionless and tested: up to twelve refund-only orders per transaction go to their owners' own accounts, and the program refuses every wrong destination. A program cannot start a transaction, so "automatic" means a keeper sends it. The on-chain part is complete; the keeper that sends it, and the screens that show a pushed refund, are application layers (`docs/evidence/W3D-B5.md` lists them).
