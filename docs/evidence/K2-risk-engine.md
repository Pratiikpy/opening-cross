# K2: the weekend risk engine, measured

Design: [ADR-0210](../adr/0210-weekend-risk-engine.md). Code: `packages/risk`. Derived results: `packages/risk/data/backtest-2026-10-12.json`. Reproduce: `pnpm --filter @opening-cross/risk history` (downloads), then `pnpm --filter @opening-cross/risk backtest`.

## Data

Daily bars, 10 years to 2026-10-12, for 15 US-listed names: SPY, QQQ, AAPL, MSFT, GOOGL, AMZN, META, NVDA, TSLA, NFLX, AMD, JPM, MSTR (2,513 sessions each) and COIN (1,381, listed April 2021), HOOD (1,307, July 2021). Source: Yahoo Finance's public chart endpoint, prices split-adjusted, dividends not adjusted. The bars are cached outside the repository and are not redistributed (the source's terms); only derived statistics are committed. A close-to-open return is `open / previous close - 1`; the closure class is the calendar days between the sessions (1 overnight, up to 3 weekend, more than 3 a holiday weekend). Weekend gaps per name: 480 (262 for COIN, 249 for HOOD). Holiday weekends: 69 (39 and 37).

Worst weekend gap seen: MSTR -27.4%, COIN -21.3%, JPM -18.0%, NVDA -14.7%, TSLA -14.1%, AAPL -13.0%, SPY -10.4%. Worst overnight gap: NFLX -29.7%, COIN -24.9%, META -24.5%.

## Walk-forward result

Each loan's LTV is set from the gaps before it only (at least 100 earlier gaps of its closure class), opened at the previous close, and the following gap is applied. Bad debt means the collateral after the gap, sold at a 5% liquidation discount, does not cover the debt. 5,251 weekend and holiday-weekend events across the 15 names.

| Policy | Bad-debt events | Mean LTV |
|---|---|---|
| Engine, default policy (cap 80%, assumed loss at least 10%, buffer 1%) | 0 | 57.3% (the first years of every history are uncertified and held at 40%) |
| Fixed 50% / 60% | 0 / 0 | 50% / 60% |
| Fixed 70% | 2 (0.04%), worst 1.4% of the debt | 70% |
| Fixed 80% | 5 (0.10%), worst 13.8% of the debt | 80% |

On the 2,353 events where the history certified the bound (the comparison that matters, because the engine and fixed policies then lend similar amounts): engine mean LTV 78.7%, 0 bad debt; fixed 70%, 1 bad debt; fixed 80%, 1 bad debt (13.8% of that debt).

Does the guarantee hold? With the cap lifted to 95% and the assumed minimum loss and buffer removed, so that the model alone sets the LTV (certified events only): mean LTV 82.2%, **1 bad-debt event in 2,353 (0.04%)**, worst 1.1% of the debt. The certified claim is that the probability of bad debt per weekend is at most 1% with 95% confidence; 0.04% is well inside it. For scale, a fixed 90% on the same events had 25 bad-debt events (1.06%), worst 23.3% of the debt: the 1% level is about where 90% sits, and the engine stays far from it because the certified rank is conservative by construction.

## What the engine says today

Weekend LTV from full history: 80% (the cap) for SPY, QQQ, AAPL, MSFT, GOOGL, AMZN, META, NVDA, TSLA, NFLX, AMD, JPM, with the second-worst of 480 weekend gaps and the fifth-worst of 1,963 overnight gaps as the certified bound; **MSTR 68.8%** (its weekend tail is 26.6%); **COIN and HOOD 40.0%, uncertified**: 262 and 249 weekend gaps are fewer than the 299 needed to certify 1%, so the engine does not claim a bound and applies its stressed fallback.

## Reading it honestly

- On this sample the engine is not more capital-efficient than a fixed 80%: large-cap US equity weekend gaps were small enough that 80% would have produced 1 bad-debt event in 2,353. Its value here is the part a fixed number cannot do: it declines to certify a short history (COIN, HOOD), lowers the limit for a heavy tail (MSTR), shows the evidence behind every number (the rank, the sample size, the loss covered), and moves with new gaps.
- The 10% minimum assumed loss and the 80% cap are policy, not data, and bind for most names; the model-only run shows what the data alone would allow.
- The backtest is a single history of one market regime. It includes March 2020 but no other equity-market structure, and it covers 15 names that are liquid and widely held; names with less history or thinner trading are outside it.
- Not measured: wick (intraday) liquidations avoided by the band rule, because 10 years of intraday data is not freely available; the rule's behaviour is covered by property tests (20,000 random positions: no liquidation ever happens on an unusable, unguarded or too-wide valuation, and every liquidation breaches the threshold at the favourable edge in exact integers).
- Not verified: tokenized stocks' own weekend prices against the underlying's reopen; the lender-eligible print feed as a live input; a real lending market using this engine.

## Tests

29 tests in `packages/risk/test`: order statistics against exact binomial values (summed independently in Python); the minimum sample sizes (598 for 0.5%, 299 for 1% at 95%); the stated confidence is reached by the chosen rank and not by the next one; **coverage of the tolerance bound against Laplace, Cauchy (infinite variance) and logistic returns in 1,500 independent histories each, at three sample sizes: at least 93% of histories (the bound promises 95%, the test allows for sampling error)**; maximum LTV arithmetic, caps, the stressed fallback and monotonicity; gap classification and refusal of bad data; fair-value filtering, disagreement and band behaviour; and the liquidation rule's branches and the property above.
