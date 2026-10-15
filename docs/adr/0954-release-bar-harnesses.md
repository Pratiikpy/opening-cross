# ADR-0954: Each release bar is a measurement with four honest states, and a bar without a feature says so

Date: 2026-10-16 · Status: accepted · Implements PRODUCT_FEATURES [V-A]

## Context
The release-blocking bars (bot label, OVS, AI summaries, agents, ratings, simulator, reproducibility) were prose. FEATURE_STATUS said the bot, OVS, AI, agent and simulator bars "cannot be measured: the features do not exist", which was true for some and no longer true for others.

## Decision
`packages/integrity/src/bars` holds the statistics (AUC by rank sum with tied ranks, expected calibration error, precision and false-positive rate, interval coverage, MAPE, a seeded paired bootstrap for the difference of two AUCs) tested against values worked out by hand, and one function per bar returning PASS, FAIL or PENDING with the numbers and the reason. PENDING is never a pass: it carries what would settle it. A bar that compares two things (OVS against raw volume) passes only if the difference's interval excludes zero as well as the point estimate meeting the threshold. `scripts/release-bars.ts` runs every bar that has data and prints the report; it exits 1 only on FAIL.

Which bars have a feature behind them, as of this ADR:
- **Reproducibility** (clearing): built and measured. 525 of 525 published clearing vectors reproduce in the TypeScript verifier and, independently, in the compiled Rust rule. The metrics specifications and the fairness report are not covered by this check.
- **AI summaries**: built (ADR-0952). The gate is measured on a labelled corpus and on 200 injection cases against an obedient scripted model; the real model is NOT RUN (needs H38). Status PENDING.
- **OVS** (F2), **ratings** (V5), **agents** (J2/S4): built; no data (no mainnet crosses, no outcomes, no mandate orders). PENDING with the sample needed. The data path exists end to end: `services/ratings bars-input` exports the observations from the database and the survival log.
- **Bot label and bot model**: no feature. The conflict flags and the organic-volume interval are not bot labels. `auc`, `ece`, `precision` and `falsePositiveRate` are ready for one.
- **Simulator**: no feature. The issuer simulator (A8) clears a book it is given; it does not forecast a live auction with an interval. `coverage` and `mape` are ready.

## Alternatives considered
- **Report the gate's numbers as the AI bar's pass.** The bar is about the product's summaries; a gate that is perfect on a corpus says nothing about how often the model needs it. PENDING is the true state.
- **Fit the OVS and rating thresholds to the first data.** The bars are release gates fixed in advance; they are not tuned to pass.

## Consequences
- A public claim about the organic-volume score, the rating or the AI notes needs its bar PASS first; today none of those three may be called validated.
- PASS on a bar can still be wrong if the labels are: OVS survival is defined as a price and 5,000 USD of liquidity at day 30, a definition that is ours and is written in the code.

## Evidence
`docs/evidence/W5-1F.md` (the report as run) and `packages/integrity/test/bars.test.ts` (15 tests: statistics by hand, each bar in each state).
