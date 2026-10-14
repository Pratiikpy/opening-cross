# ADR-0754: Pushed refunds, a lock sold in a reopen, a pegged order, holder proposals and the dashboard

Status: accepted (2026-10-14).

## Decision

Pushed refunds (B5): a settled cross page offers any connected wallet to send refund-only orders back to their owners, twelve to a transaction. Only orders that cannot have a fill are offered: every open order of a cross that did not print, a buy strictly under the clearing price, a sell strictly over it, and a sealed bid that was never revealed. An order at the price itself, or one that lost a draw or a lottery, is left to `claim`. The nonce of an order is on its account, not in the index, so the page asks `GET /v1/orders` for the twelve it is about to send.

A lock sold in a reopen (V7): the locked-fills section lists, for each locked token, the escrow crosses of that token that are open or about to open, with links; the sell order is placed on the cross page where every rule of the cross is checked.

A pegged order (Z3): on the order ticket, "Take whatever the open prints" sets the limit to the top of the grid for a buy and the bottom for a sell, which is the order `peggedOrder` builds, and the note says that the escrow is held for the top price and only the clearing price is paid. The phone app has the same button.

Holder treasury: beyond voting, any wallet may add quote tokens to the pot and pay an attested revenue round; the authority or a holder of the configured share opens a proposal, with the description hashed in the browser and only the hash recorded.

The dashboard (O1): `/dashboard` draws every section of `GET /v1/dashboard` beside its source route. A failed section is marked failed with the reason and shows nothing in its place; a stale one says how old; a missing value reads "no data" and never zero; the five programs show who can replace each.

## Not covered

Refund-only orders that depend on a draw or a lottery. The keeper's `refunds` duty (W3E) covers the same ground without a person. Creating a grant stays on the team's console. R11, the operations console, has no screen: it needs its Postgres-backed service and issued tokens (H34).
