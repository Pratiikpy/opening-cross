# W2D-B5: minimum raise, published cap, automatic refunds (B5)

Outcome: **BUILT-LOCAL**, wording differs. Design: ADR-0451 (guards, cap) and ADR-0457 (pushed refunds).

- Minimum raise in quote atoms (`BelowMinimumRaise`) and a published hard cap on the base the sell side delivers (`clear_with(.., Some(cap))`, `clearing-core`), both set before the first order. The cap matches the independent reference on price, volume and every fill for six caps (`rules-guards.test.ts`).
- "The issuer chooses the accepted amount within published rules" is implemented as a rule published before bids (the cap and the minimum raise), **not** as a choice made after seeing the book: a post-hoc choice would let an issuer withhold supply to raise the price (ADR-0451). The orchestrator may overrule this narrowing.
- `push_refunds` returns up to twelve refund-only orders in one transaction to their owners' own token accounts (`rules-refunds.test.ts`, 3 tests): all six orders of a no-print cross, the unfilled orders of a printed cross, and eleven refusals (wrong destination, wrong mint, other cross, repeated order, empty, not a multiple of three, thirteen, live cross, an order with a fill).
- `claim` and `push_refunds` share one settlement function (`orders::outcome`); the pre-existing claim tests pass unchanged.

FEATURE_STATUS.md row wanted: `| B5 minimum raise, automatic refunds | BUILT-LOCAL, wording differs | Minimum raise and a published hard cap fixed before the first order; `push_refunds` returns up to 12 refund-only orders per transaction to their owners' own accounts; 3 + 18 LiteSVM tests (`W2D-B5.md`, ADR-0451, ADR-0457) | The issuer's choice is the cap and minimum published in advance, not an amount picked after seeing demand (that would let it withhold supply); refunds are pushed by anyone (a keeper), not by the program itself; devnet proof pending funding; not audited |`
