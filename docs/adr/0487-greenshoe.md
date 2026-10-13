# ADR-0487: Greenshoe as program-owned DLMM limit orders (D4, VM8, X18)

Status: accepted (2026-10-13) · Builds on ADR-0481, ADR-0483

## Context

PRODUCT_FEATURES [D4] wants a fraction of a launch's proceeds to stand as bids under the clearing price for a week, so early sellers have a floor and the issuer cannot quietly pull it. DLMM 0.12 has real limit orders (`place_limit_order`, `cancel_limit_order`), so the bids can be on-chain orders instead of liquidity the issuer could withdraw.

## Decision

A `Greenshoe` PDA per cross (`["greenshoe", cross]`) holds a quote vault, a base account and the state of three levels at 0.90, 0.85 and 0.80 of P*.

- `create_greenshoe`: the cross's creator commits a budget, at least 10% of what buyers paid (`Cross.buyer_paid`), to a vault the program owns. The cross must be finalized and the DLMM pair must be a pair of the cross's two mints that is enabled. The week runs from `start_ts` (not in the past) for seven days.
- `deploy_greenshoe_bid`: permissionless. A level is placed once, in the bin nearest its target price (within half a bin step) and strictly below the active bin, for at most a third of the budget (rounded up), at most `period_cap` quote per rolling `period_secs`, only inside the week. The order is a DLMM limit order owned by the greenshoe PDA, so there is no instruction by which the issuer can cancel it early.
- `settle_greenshoe_level`: permissionless, after the week: cancels the level (unspent quote returns to the vault, the base the bid bought lands in the program's base account, running the mint's transfer hook) and closes the order.
- `finish_greenshoe`: permissionless once every placed level is settled: burns all base the bids bought and returns the unspent quote to an account owned by `Cross.proceeds_to`.

## What is and is not enforced

Enforced by the program: the floor of 10%, the levels, the bins, the rate limit, the week, and the two exits (cancel at expiry, burn plus refund). Not enforceable on chain, and therefore keeper policy or other mechanisms: which counterparties sell into the bids (insiders are kept out by their own lockups, B12 and VM7, not here); a TWAP trigger (the bids rest below the market by construction, and the per-period cap bounds how fast the budget is committed); "batch-only" execution (DLMM fills each swap against the orders as it crosses them). Bought tokens are burned, not locked.

## Consequences

- Proven on the real DLMM binary: a 2,500,000,000 base sale through three bids paid 2,564,922,416 quote, the program burned 2,497,343,746 base, returned 435,077,584 quote, and the vault ended empty; the figures add up to the 3,000,000,000 budget.
- Bin arrays holding the bids must exist before placement (`initialize_bin_array`), and DLMM needs them as remaining accounts; the adapter appends them.
- `cross_settle` grows by about 220 KB with the four instructions and the DLMM limit-order types.
