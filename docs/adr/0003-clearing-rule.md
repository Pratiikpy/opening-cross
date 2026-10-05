# ADR-0003: Clearing rule, rationing and rounding

Date: 2026-10-05 · Status: accepted · Resolves open decision VM6 (kth vs (k+1)th price)

## Context
Every cross — launch, reopen, unlock, tender, recurring — is a single-price call auction over limit orders. Launches have one seller (the issuer's pre-committed elastic supply schedule, expressed as limit sells at ascending prices); reopens have many sellers. The rule must be deterministic, independent of order arrival, recomputable by anyone from chain data, and cheap enough that each order's fill can be computed on chain at claim time without sorting a million orders.

## Decision

**Orders.** Limit orders only: `(side, limit_price, quantity)`. Prices are integers on the cross's tick grid; quantities are base-token atoms.

**Price.** For each candidate price `p` — every order limit price, the reference price when one is supplied, and inside each gap between consecutive order prices the one grid tick that can win there (`D` and `S` are constant across a gap, so that is the tick nearest the reference, or the lowest tick when there is no reference):
- `D(p)` = buy quantity with limit ≥ p, `D⁺(p)` = buy quantity with limit > p
- `S(p)` = sell quantity with limit ≤ p, `S⁻(p)` = sell quantity with limit < p
- matched volume `V(p) = min(D(p), S(p))`; `p` is feasible only if `V(p) ≥ max(D⁺(p), S⁻(p))` (every strictly better order fits).

Choose, among feasible prices with `V > 0`:
1. maximum matched volume;
2. then minimum imbalance `|D(p) − S(p)|`;
3. then, if a reference price is supplied (reopens: the pre-halt or oracle price), the price closest to it;
4. then the **lowest** price.

Rule 4 settles VM6 in favour of the buyer-side (k+1)th-price convention: when several prices clear the same volume, bidders pay the lowest. It keeps truthful bidding a dominant strategy for single-unit retail demand and makes the issuer's revenue come from demand, not from tie-breaking. If no feasible price has `V > 0`, the cross does not print and every order is refunded.

**Fills.** Orders strictly better than `P*` fill in full; orders worse than `P*` do not fill. Orders exactly at `P*` on the side with excess quantity are rationed pro-rata against the remaining volume `R` over the marginal quantity `Q`:
- rationed buys get `floor(q·R/Q)`;
- rationed sells get `ceil(q·R/Q)` (never more than `q`, since `R ≤ Q`).

Each fill is computed from the order alone plus the published clearing summary, so `claim` is O(1) on chain and needs no allocation tree. Pro-rata is by size; size never buys priority at the margin beyond its proportional share, and nothing depends on arrival time.

**Dust.** Rounding leaves the sell side short of or over the buy side by at most one atom per marginal order. That difference, `dust`, is published in the summary and absorbed by the cross's dust bond (`cross_core` policy): for a launch the issuer simply keeps it unsold; for multi-seller crosses the bond buys it at `P*`. In both directions the bond is the buyer of the difference, so the invariant is always `Σ buy fills + dust = Σ sell fills`, with `dust ≤ number of marginal orders` atoms.

**Payment rounding.** Buyers pay `ceil(fill · P* / price_scale)`; sellers receive `floor(fill · P* / price_scale)`. Rounding always favours the vault, so the vault can never owe more than it holds.

**Print guards** (minimum matched volume, maximum imbalance in bps, oracle divergence) are evaluated on the summary after clearing; a guarded cross does not print.

## Consequences
- `clearing-core` exposes `clear(levels, reference) -> Option<Clearing>` over per-price aggregates (on chain these come from shard accumulators) and `fill(order, &clearing)` per order.
- The rule is the standard opening-auction rule used by major equity exchanges (maximum volume, minimum imbalance, reference price), with a deterministic final tie-break, so it is familiar to market makers and auditors.
