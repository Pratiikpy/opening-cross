# ADR-0210: A weekend risk engine for lending against tokenized stocks

Date: 2026-10-12 · Status: accepted · Implements PRODUCT_FEATURES [K2]; the risk half of [K1] (ADR-0211)

## Context
A lender that accepts a tokenized stock as collateral faces a risk the stock's own exchange does not: the market is closed for 64 hours every weekend and longer around holidays, but the token trades and the loan stays open. The price the lender can trust (a guarded cross print at the reopen) arrives only at the end of the closure. If the stock gaps down over the weekend by more than the loan's margin, the debt exceeds the collateral before anyone can act. Fixed loan-to-value ratios ignore this; a spot-price liquidator makes the opposite error, liquidating borrowers on a wick that recovers. The specification asks for a "weekend risk engine: gap-aware LTV, fair value with confidence bands, band-tied liquidations".

## Decision
A pure, deterministic TypeScript package, `@opening-cross/risk`, with money in integers (micro-USD prices, basis-point ratios) and the statistics in plain floats that never touch an amount.

1. **Gap statistics.** From daily bars, every close-to-open return, classified by how long the market was shut (overnight, weekend, longer). Only derived statistics are published; prices are not (the data source's terms forbid redistribution).
2. **Gap-aware maximum LTV with a distribution-free guarantee.** After a gap `g`, a loan is safe if `LTV <= (1 + g)(1 - liquidation discount)`. The engine picks `g` as a rank of the asset's own sorted gap history so that, whatever the distribution, with 95% confidence at most a fraction `alpha` of future closures fall below it (`P(Binomial(n, alpha) >= rank) >= confidence`; stats.ts). `alpha` is the policy's per closure class (0.5% overnight, 1% weekend, 2% longer closures), the confidence 95%. The loan must survive the longer closure and the shorter ones inside it, so a weekend LTV is the lower of the overnight and weekend limits. When the history is too short to certify `alpha` at all (fewer than 299 weekend gaps for 1%), the engine says so, scales the worst observed loss by 1.5, and caps the LTV at 40%: an uncertified asset gets a low limit, not a guess. Volatility-scaled pooling of peers' gaps is available (`pooled`) and is labelled as an assumption.
3. **Fair value with a confidence band** from several references (a lender-eligible cross print, a verified oracle, a reference feed, the last close), each with an age limit. The mid is a trust-and-freshness weighted median; the half-width is the widest of the best source's floor, any stated confidence and twice the sources' spread, plus a widening while the market is closed. Sources that disagree by more than a limit make the value unusable rather than averaged. A value is `guarded` only if a guarded source (a cross print that passed the oracle guard, ADR-0152) lies inside the band.
4. **Band-tied decisions.** Lending is judged at the lower edge of the band (borrow only what survives the pessimistic price). Liquidation is judged at the upper edge: a position is liquidated only if it breaches the threshold even at the most favourable price in the band, only on a usable, guarded valuation no wider than the limit. A position the lower edge breaches but the upper edge does not is `atRisk`: the borrower is warned and nothing is seized. When the price is too uncertain to act on the answer is `wait`. `insolvent` is reported, not acted on, when even the favourable edge after the discount cannot cover the debt.
5. **A walk-forward backtest** that sets each loan's LTV from the history before it and replays the gap that followed, against fixed-LTV policies on the same events.

## Alternatives considered
- **A parametric model (normal, Student-t, EVT peaks-over-threshold).** Gives smoother numbers from less data, and fails silently when the assumed tail is wrong; stock gaps are heavy-tailed and clustered. The rank rule needs no assumption and states exactly when it cannot say anything. A fitted tail can be added as a second opinion; it should not be the guarantee.
- **Liquidate at the lower edge** (more protective of the lender). It turns every wide band, which is exactly when the price is least reliable, into a liquidation, punishing borrowers for uncertainty. The lender's protection comes from the conservative LTV at origination and the insolvency flag, not from seizing on noise.
- **Intraday data.** Better for wick analysis; the free sources do not offer 10 years of it, so the wick claim is not tested here.

## Consequences
- The engine is a library and a decision rule; it is not a lending program. ADR-0211 builds the market that uses it.
- The guarantee is per closure and per asset, conditional on the future resembling the past; a regime the history has not seen (a new kind of asset, a changed market structure) is outside it. The uncertified fallback exists for that reason, and the monitor of a live market should recompute from new gaps as they arrive.
- Tokenized stocks trade around the clock and their own weekend price can differ from the underlying's; this engine bounds the gap to the underlying's reopen, not the token's weekend path. NOT VERIFIED against on-chain stock-token weekend prices (no history exists in this repository).

## Evidence
`docs/evidence/K2-risk-engine.md`: 15 US equities, 10 years, 5,251 weekend and holiday-weekend events, walk-forward; 29 unit and property tests, including a coverage test of the tolerance bound against Laplace, Cauchy and logistic returns.
