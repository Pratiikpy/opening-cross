# ADR-0314: A maker's quote must be backed by an order on chain; intents and registrations are signed; rebates are accounting

Status: accepted (2026-10-13) · Rows W7, W9, X6, Y7 · Code `packages/liquidity`, `services/api/src/routes/liquidity.ts`, `services/api/src/routes/execute.ts` · Evidence `W2A-X6-marketmaker.md`, `W2A-Z1-router-execute.md`

## Decision

1. **A signed quote counts only while the order it points at rests on chain as quoted.** `checkBacking` reads the order account: owner, side, price, quantity and escrow must match, so a quote cannot promise liquidity that is not escrowed.
2. **Registrations, quotes and intents are Ed25519-signed documents by the wallet they concern**, with the same shape as ADR-0318 (a hash of the canonical body is the id; the signature covers a domain string and the id; the signer is the wallet named in the body), implemented inside `packages/liquidity` with a domain of its own per document kind. A quote may live at most a stated number of seconds. An intent delegates nothing: `cross_core` cannot let a third party place an order for a wallet, so `POST /v1/intents/:id/execute` matches the intent to the pair's live crosses and returns a transaction the owner still signs; the intent gives a router a signed, expiring instruction to act on.
3. **Maker status is measured, not claimed.** The registry computes each maker's resting size, share of volume and tightness from the orders table.
4. **The rebate pool is accounting.** 25% of reopen protocol fees to registered makers is computed from finalized crosses (floored, the remainder undistributed) and stated as a figure; the program has no rebate instruction. The company's own wallets (`OWN_WALLETS`) get none.
5. **Sealed liquidity commits a curve** (`commitCurve`) and reveals orders against that commitment (`checkRevealedOrders`), so a maker cannot reveal a different ladder.

## Alternatives rejected

- Quotes as promises without backing: unfalsifiable; the first failure ends trust.
- Paying rebates from the API: the money moves only if someone with the fee wallet moves it; the figure is what the API can honestly publish.

## Consequences

An empty JSON body to an intent route returned 500 in the first version; the execute route now has a lenient parser in its own scope. The rebate share needs a program to be enforced (HD1 decides the number).
