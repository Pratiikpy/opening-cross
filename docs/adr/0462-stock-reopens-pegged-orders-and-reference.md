# ADR-0462: A stock's reopen: the weekly calendar, pegged-to-open orders, unlocks, tenders, and a composite reference

Status: accepted (2026-10-13). Implements PRODUCT_FEATURES X1, V2, C2 (weekly generator, unlock logic), Z3 (pegged-to-open orders), C6 (composite reference), V7 (unlock and block-sale crosses) and the mechanism of V4 (tender). Builds on ADR-0455, ADR-0456 and ADR-0459.

## Decision

Nothing here needs a new program. A reopen is a cross; what was missing was the schedule, the order a holder places for "the open", and the glue.

- **The weekly calendar.** `weeklyReopenSessions` (in `@opening-cross/cross-core-client`, `src/stocks.ts`) generates the sessions of a `cross_calendar` for a US equity: 09:30 to 16:00 New York time converted to UTC with the daylight-saving change, trading days only, in `weekly` mode the first session of each trading week (the open a weekly reopen cross closes at) or in `daily` mode every session. The holiday rule set is computed (fixed dates with Saturday-to-Friday and Sunday-to-Monday observance, Monday holidays, Good Friday from the Gregorian Easter, Thanksgiving) and checked in unit tests against the 2026 dates; a caller can pass an explicit holiday list instead. **The default rule set is NOT VERIFIED against the exchange's published calendar, and early closes are not modelled.** The calendar holds 64 sessions, so 64 weeks. The calendar's admin applies updates behind its seven-day timelock; the generator only produces the list.
- **The scheduler** is the series of ADR-0456 on that calendar: it spawns the next reopen at the next session start by itself.
- **Pegged to open (Z3).** There is no special order type. In a uniform-price call a buy at the top of the grid fills at the clearing price whatever it is, a sell at the bottom likewise, and a buyer pays only the clearing price, so the excess escrow comes back at the claim. `peggedOrder` computes the order for a grid, and with `slippageBps` limits the exposure to a share of a reference price instead (rounded in the safe direction, on the grid). On chain it is an ordinary limit order, so every guard still applies.
- **Unlock (X1, V7).** A locked fill vests and is released (ADR-0454); the holder then sells it in the next reopen. `rules-stocks.test.ts` runs the whole line: an insider's fill, the cliff, the release, a sell into a reopen of the same mint, the buyer's fill.
- **Halt and resume** (ADR-0455) cover the week where the asset was halted: the scheduled reopen refuses to print, the authority's resume cross prints and feeds lenders, the next reopen prints.
- **Tender (V4), mechanism only.** An issuer's single bid and gated holders' offers in an escrow cross of kind `Tender` already clear to the cheapest offers first, with the rest returned (`rules-stocks.test.ts`). Which offer periods and exemptions apply, who may be offered and what must be filed is counsel's (HUMAN_TASKS H2, HS4); the program enforces the allowlist and the order window and decides none of it.
- **Composite reference (C6).** `compositeReference` combines a quote's mid (if the spread is tight), the last trade (if fresh) and the last valuation (if fresh) as a weighted mean over the sources that qualify, never outside their range, `null` when none does. It produces the number a creator passes as a cross's `reference_price` or anchor; the chain never trusts it alone (the anchor guard of ADR-0451 and the oracle guard of ADR-0459 check the print).

## Not covered

A lender's use of the print feed; a venue signer for halts; early closes; the exchange calendar's authoritative source; a tokenizer's own corporate-action announcements (ADR-0459 guards the multiplier, not the announcement); settlement against a tokenizer's mint and redemption. The Genesis-style composition on devnet is not run.

## Evidence

`packages/cross-core-client/test/stocks.test.ts` (11 tests: holidays, New York offsets, sessions, pegged orders, the reference); `tests/core/test/rules-stocks.test.ts` (3 tests: a halted stock reopens through a cross, an unlock sold in the open, a tender).
