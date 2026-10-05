# DP10 — Reopen-cross novelty search (2026-10-05)

Question: does any venue already reopen tokenized stocks with a uniform-price call auction (a
"reopen cross") after weekends, halts or thin periods? Searched on 2026-10-05: web search and
GitHub, plus the venues' own pages.

## Findings

| Venue | What it does around closed or thin markets | Auction? | Source |
|---|---|---|---|
| Kraken / Backed **xStocks** | Continuous 24/7 onchain trading as Token-2022 tokens. When the underlying market is closed, the oracle price may freeze while the token keeps trading. | No | kraken.com/xstocks; Jupiter xStocks docs (jupiter-support.mintlify.app) |
| **OKX** unified tokenized stocks | Continuous 24/7; outside US hours, pricing is "last close plus a market estimate". | No | okx.com listing notices |
| **Ondo** (Ondo Stocks) | Mint and redeem 24/5, and 24/7 since July 2026 for six tickers; secondary trading P2P 24/7. | No | ondo.finance/blog/real-24-7-trading-for-tokenized-stocks |
| **Backpack** Securities | 24/7 trading of tokenized US equities since 10 July 2026; weekend sessions, then routing back to US exchanges on Sunday 8pm ET. | No | support.backpack.exchange (stock trading hours) |
| **Jupiter** | Aggregates continuous pools (Raydium, Meteora, …) for xStocks. | No | Jupiter xStocks docs |
| **Uncross** (Uncross-Org/uncross) | **Periodic call auction for tokenized US equities on Solana devnet.** One price at max volume, then min imbalance, then the nearest fresh Pyth price, then the middle of the range. Schedules 10 xStocks fixtures; built for the Solana Foundation "Stocklana" hackathon, September 2026. No licence file. | **Yes** | github.com/Uncross-Org/uncross (created 2026-09-15, last push 2026-10-04) |

Measured market context, from Uncross's README (their measurement, not ours): on 16 September,
Jupiter found no route to buy IBMx at $10,000, $100 or $1 against a $1,666 pool. Weekend
tokenized-stock DEX volume reached billions per weekend in 2026 (cryptobriefing.com). The thin
weekend market is real.

## Conclusion

**A uniform-price call auction for tokenized stocks on Solana is not novel by itself.** Uncross
already runs one on devnet, with the same first two tie-break rules as ADR-0003 and a Pyth-based
third rule. Opening Bell must not claim to be the first or only call auction for tokenized
stocks. As of this search, no copy on the site or in the docs makes that claim (checked with
`grep -ri "first\|only"` over `apps/web/src` and `README.md`).

What Opening Cross does that the search found nowhere else, including Uncross:

- **Launches as well as reopens.** Deferred or minting supply schedules, then graduation to
  Meteora DBC, DAMM v2 and DLMM, or Raydium CPMM pools opened at exactly P* (ADR-0006 to 0009).
- **Sealed bids** (commit–reveal), with an escrow-backed refund for unrevealed bids.
- **Eligibility gating** through `cross_gate`: allowlist, Solana Attestation Service, Merkle
  passes, transfer-hook locks.
- **Oracle guard as a print condition**, not only a tie-break. A reopen whose P* diverges from a
  fresh, fully verified Pyth price does not print.
- **An exchange calendar** behind a 7-day timelock, so reopens close at session starts.
- **Independent verification**: a second implementation, a published fairness-proof schema, and
  525 conformance vectors the program itself passes.
- **Integrator surface**: a Rust CPI crate, a REST/WebSocket API, permissionless keepers and a
  best-execution router against a live Jupiter route.

Positioning for submissions: "the open protocol for opening and reopening markets on Solana:
launches and reopens, sealed or open, gated or public, verified independently". Uncross is to be
cited as related work, not hidden.
