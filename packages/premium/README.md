# @opening-cross/premium

Measures how far the price you can actually trade a Solana stock token at sits from an independent reference, by order size and market session.

- **Executable price:** a real Jupiter quote at $100, $1,000 and $10,000, buy and sell, converted to a price per share using the mint's Scaled UI Amount multiplier (read from the chain).
- **Reference:** Hyperliquid HIP-3 oracle and mark prices for the same stock (free, 24/7).
- **Session:** the issuer's own trading clock (`regular`, `pre`, `post`, `overnight`, `closed`); sessions are never mixed.
- **Exact:** prices in micro-USD and premiums in basis points × 100, all `bigint`; a buy rounds up and a sell rounds down so the premium is never flattered.
- **Honest about gaps:** every attempt is recorded, and the ones that could not be priced (no route, issuer halted, no reference, no multiplier) are counted beside the numbers.

```sh
TICKERS=TSLA,NVDA pnpm --filter @opening-cross/premium exec tsx tools/measure.ts
```

Method and the first live round: [ADR-0017](../../docs/adr/0017-premium-monitor.md), [premium-live.md](../../docs/evidence/premium-live.md). A quote is not a fill, and a closed-session premium compares the token with a perpetual, not with the cash market. Requires Node 22 or later. Part of [Opening Cross](https://github.com/Pratiikpy/opening-cross); Apache-2.0.
