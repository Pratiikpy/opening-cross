# Premium monitor: first live measurement (ADR-0017)

Run: 2026-10-11T16:09:23.000Z · mainnet quotes (Jupiter lite API), reference Hyperliquid HIP-3 `xyz` oracle, issuer clock from `api.xstocks.fi`
Tool `packages/premium/tools/measure.ts` · raw observations [`data/premium-live-2026-10-11.json`](data/premium-live-2026-10-11.json)

Session at the time of the run: **closed** for every asset (Sunday, issuer clock `currentPeriod: closed`). This is a single round of 54 quotes over 9 tokens, at 100, 1,000 and 10,000 USD, buy and sell. It shows the instrument working against live data. It is **not** a distribution over time or across sessions.

Premium = (executable price per share − reference) / reference, signed; positive means above the reference. The per-share price divides the quote by shares (token atoms × the mint's Scaled UI Amount multiplier). Buys are rounded up and sells down.

| Token | Underlying | Reference (USD) | Multiplier | Buy $100 | Sell $100 | Buy $1k | Sell $1k | Buy $10k | Sell $10k |
|---|---|---|---|---|---|---|---|---|---|
| AAPLx | AAPL | 336.03 | 1.00326901254 | 0.22% | 0.00% | 0.28% | -0.03% | 0.38% | -0.29% |
| AMZNx | AMZN | 262.77 | 1 | 0.09% | -0.08% | 0.11% | -0.08% | 0.22% | -0.31% |
| COINx | COIN | 182.05 | 1 | 0.25% | -0.05% | 0.31% | -0.09% | 0.37% | -0.44% |
| GOOGLx | GOOGL | 351.62 | 1.00237725006 | 0.12% | 0.07% | 0.13% | 0.02% | 0.13% | 0.00% |
| HOODx | HOOD | 109.84 | 1 | 0.33% | 0.27% | 0.38% | 0.27% | 0.45% | -0.02% |
| METAx | META | 719.92 | 1.002851543327 | 0.14% | 0.07% | 0.15% | 0.07% | 0.18% | -0.15% |
| MSTRx | MSTR | 156.69 | 1 | 0.47% | 0.43% | 0.52% | 0.43% | 0.54% | 0.40% |
| NVDAx | NVDA | 230.72 | 1.001701196801 | 0.14% | 0.13% | 0.14% | 0.12% | 0.17% | 0.09% |
| TSLAx | TSLA | 382.97 | 1 | 0.09% | 0.01% | -0.03% | 0.00% | 0.39% | -0.01% |

| Leg and size | n | p10 | median | p90 |
|---|---|---|---|---|
| buy $100 | 9 | 0.09% | 0.14% | 0.47% |
| sell $100 | 9 | -0.08% | 0.07% | 0.43% |
| buy $1000 | 9 | -0.03% | 0.15% | 0.52% |
| sell $1000 | 9 | -0.09% | 0.02% | 0.43% |
| buy $10000 | 9 | 0.13% | 0.37% | 0.54% |
| sell $10000 | 9 | -0.44% | -0.02% | 0.40% |

## What this does and does not show

- Every token had a Jupiter route at every size: nothing was excluded (`dropped: []`, every observation `ok`).
- The Scaled UI Amount multiplier is not 1 for 4 of 9 tokens (AAPLx 1.00326901254, GOOGLx 1.00237725006, METAx 1.002851543327, NVDAx 1.001701196801). Without it every per-share price, and so every premium, would be off by that amount.
- Sessions other than `closed` are NOT MEASURED. The reference is a perpetual venue's oracle, so a closed-session premium compares the token with a perp, not with the cash market.
- One round, one reference, one quote API. Quotes are not fills. SPY is absent because its ticker maps to more than one listed xStock; the universe builder leaves such tickers out rather than guess.
