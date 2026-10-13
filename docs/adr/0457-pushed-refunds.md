# ADR-0457: Pushed refunds

Status: accepted (2026-10-13). Implements the "refunds need no claim" half of PRODUCT_FEATURES B5. Builds on ADR-0005.

## Context

`claim` is permissionless: anyone may crank an order and funds always go to its owner. That is "no action by the user" already, but it is one transaction per order. A cross that does not print leaves every order owed a refund, and a keeper wants to return them in bulk.

## Decision

`push_refunds` refunds up to twelve orders in one transaction. Remaining accounts come in groups of three: the order, its owner (which receives the order's rent) and the owner's own token account for the escrowed mint. The program checks that each order belongs to the cross, that the owner account is the order's owner, that the destination is the owner's token account for the right mint (quote for buys, base for sells), and that the order's outcome is **a refund only**: it recomputes the order's settlement with the same function `claim` uses (`orders::outcome`) and refuses an order that has a fill (`NotRefundOnly`). A fill needs the mint, the lock vault or the fee accounts that `claim` handles, and a refund must never be able to settle part of a fill. It works on a cross that did not print (every order) and on a printed cross for the orders that were not filled: never revealed, left out by the draw, or priced out. The call is atomic: one bad group fails the whole transaction and moves nothing. It emits the same `OrderClaimed` event per order, with a zero fill.

`claim` was refactored to share `outcome` with `push_refunds`, so the two cannot disagree about what an order is owed. The pre-existing suite passes unchanged.

A keeper chooses only which orders to push. The destination account is checked against the order's owner, so it cannot redirect funds.

## Evidence

`tests/core/test/rules-refunds.test.ts`: a no-print cross of six orders (three sells, three buys) refunded in one transaction, the cross then finalizes with empty vaults; a printed cross refunds its priced-out and unrevealed orders and leaves the filled to claim; the wrong token account, the wrong mint, an order of another cross, a repeated order, no orders, a count that is not a multiple of three, thirteen orders, and a live cross are all refused and move nothing.
