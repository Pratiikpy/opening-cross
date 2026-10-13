# ADR-0401: Portfolio value: only from prices a cross cleared at

Status: accepted (2026-10-13)

Rows Y9, M6

## Context

A portfolio wants a value and a profit or loss. This product has no market price: a token's only price is the price its last cross cleared at.

## Decision

A holding is marked at the clearing price of the latest printed cross of that token and labelled with the cross and its day. A "result" is shown only against the average price the wallet paid through crosses, in the same quote token, and only for the tokens it bought that way and still holds; tokens that arrived another way are said to have no cost. Amounts in different quote tokens are never added. "Sell in the next cross versus sell now" shows the next cross of the token and, on request, the router's comparison; on devnet there is no secondary market, and the page says so rather than inventing a "now" price. Rights and distributions are read from the treasury behind a token, where one exists: the rights cards, the exact pro-rata redemption the program would pay (snapshot vault times coins over snapshot supply, rounded down) and the redemptions this wallet already received.

Balances are read through the API (`GET /v1/balances/:owner`) so a page does not fill the browser with rate-limited requests to the public cluster; a balance that could not be read is shown as such, never as zero.

## Verification

`apps/web/test/holder-value.test.ts` (15 tests of the arithmetic, including mixed quote tokens and partial holdings) and a browser run on a wallet with ten real fills (docs/evidence/W2C-Y9.md).
