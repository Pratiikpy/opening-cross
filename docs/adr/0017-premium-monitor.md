# ADR-0017: Executable premium monitor for stock tokens

Status: accepted (2026-10-11)

## Context

A stock token trades at a premium or discount to the share it represents, and the gap changes with order size and with whether the underlying market is open. A reopen cross exists to settle exactly this: the first print after a closed market. Showing that a cross cleared "fairly" needs a measured, independent comparison, not the cross's own price against itself.

## Decision

A package, `@opening-cross/premium`, measuring the **executable** price on Solana against an independent reference:

- **Executable price:** a real Jupiter quote (USDC to token for a buy, token to USDC for a sell) at $100, $1,000 and $10,000 notional. A quoted price at size includes spread and price impact, which is what a person pays. The sell is sized by notional at the reference price.
- **Shares, not tokens:** xStocks carry a Scaled UI Amount multiplier (live on 2026-10-11: `NVDAx` 1.001701196801, `TSLAx` 1). Per-share price divides by shares = atoms × multiplier / 10^decimals, read from the mint on chain.
- **Exact arithmetic:** micro-USD per share and a premium in basis points × 100, all `bigint`. A buy rounds the price up and a sell rounds it down, so the measured premium is never flattered. The premium is signed: positive is above the reference.
- **Reference:** Hyperliquid HIP-3 `xyz` oracle and mark prices (free, permissionless, 24/7). The response has no update time, so a value is stamped with the time it was read. Further references (an exchange equity stream, a licensed feed) plug into the same `Reference` shape; the Binance equity stream is reachable but its redistribution terms are NOT VERIFIED (HUMAN H15), and Pyth Pro equities are NOT entitled with our key (H11).
- **Session:** the issuer's own trading clock on each asset (`trading.currentPeriod`: market, extended, overnight, closed; "extended" split into pre and post by New York hour) and its halt flag. No holiday calendar is maintained here; when the issuer clock is missing or unrecognised nothing is measured under a guessed session.
- **Statistics:** quantiles by index ⌊n·q⌋ of the sorted sample, so every reported value is a premium that was actually quoted; grouped by session × size × leg. Attempts that could not be priced (no route, no reference, halted, quote failed) are kept with their reason and counted beside the numbers.
- **Universe:** genuine xStocks from the authenticity registry (ADR-0016) whose ticker has a reference; a ticker listed twice is left out rather than guessed; each candidate must route on Jupiter.

## Consequences

- The measurement is as independent as the reference. HIP-3 prices come from a perpetual venue, whose mark can itself drift from the share price outside US hours; a closed-session premium therefore measures token against perp, and is reported under `closed`, never mixed with regular hours.
- It measures quotes, not fills; the first live run is in `docs/evidence/premium-live.md`.

## Verification

`packages/premium`: 21 unit tests (exact rounding both ways, multiplier handling, sign, quantiles, every exclusion path, session mapping, parsers on live fixtures). A live round over mainnet quotes and the live oracle is recorded in the evidence file with the raw observations.
