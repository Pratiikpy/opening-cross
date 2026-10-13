# ADR-0312: The market-maker bot never invents a price, never runs on mainnet by accident, and keeps its own books apart

Status: accepted (2026-10-13) · Rows X6, Y7, W7, W9 · Code `services/marketmaker`, `packages/liquidity` · Evidence `W2A-X6-marketmaker.md`

## Decision

1. **The reference price comes from the operator or the market.** In order: a fair value the operator configured for the mint, the pair's last printed price, the indicative price. If none exists the bot does not quote. It never derives a price from its own quotes.
2. **Mainnet is refused unless explicitly allowed** with `MM_ALLOW_MAINNET=yes-i-understand-this-spends-real-money`; devnet is the default.
3. **Launches are excluded by default.** A house order should not be demand in someone else's price discovery. Reopen, recurring and tender crosses are quoted.
4. **Quotes are ladders snapped to the cross's grid** (buys floor, sells ceil) inside the operator's budgets, with a minimum time left; it leaves a cross that closes too soon.
5. **Sealed orders use salts derived from a master secret** (sha-256 of a domain string, the secret, the cross, the owner and the nonce), so a restart can reveal what it committed; without the secret file sealed crosses are skipped. Reveals and claims look the order up through the API, which carries the nonce.
6. **State is one JSON file; a dry run saves nothing.**
7. **The bot's own volume is reported apart.** Its wallet is expected in `OWN_WALLETS`, which `/v1/metrics/external-flow` excludes; the rebate pool for registered market makers gives the company's own wallets nothing.

## Alternatives rejected

- Quoting around the last trade of any kind: a thin market's last trade is not a price.
- A bot that creates crosses: that is the issuer's act, and a house-created cross would measure nothing about demand.

## Consequences

The bot adds no demand a user did not see: its orders are ordinary orders. Its wallet funding and the decision to run it with real value are HUMAN.
