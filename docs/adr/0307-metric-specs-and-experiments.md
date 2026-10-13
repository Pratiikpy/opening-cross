# ADR-0307: Metrics are specified once and versioned; experiments are planned before data

Status: accepted (2026-10-13) · Row R12 · Code `packages/metrics` · Evidence `W2A-R12-metrics.md`

## Decision

1. **A metric is a versioned specification** (definition, formula, unit, what one observation is, minimum sample, where it is computed, caveats) with a content hash; the registry has one. A changed definition changes the hash and requires a new version; a test fails if the generated document `docs/metrics/METRIC_SPECS.md` differs from the registry, and if a cited route or function does not exist.
2. **Below its minimum sample a metric is shown with its sample size and no headline.**
3. **An experiment's metric, minimum detectable effect, alpha, power and sample are fixed before data.** `analyse` returns "too early" with the estimate until every arm reaches the planned sample; it does not call a result early. Several variants share the false-positive budget.
4. **A sample-ratio check runs first** and outranks any effect, at p < 0.001 so that it does not fire on every experiment.
5. **Assignment is a pure function of (experiment, salt, unit)**, so a user keeps one variant on every surface and an assignment can be recomputed from the log. An exposure record has a stable id.
6. **The analysis is checked against known truth.** A seeded simulation shows 5.47% false positives with no change (nominal 5%) and 79.4% power at the minimum effect (nominal 80%).

## Alternatives rejected

- Peeking and stopping at the first significant result: inflates false positives; the library makes it a labelled non-decision.
- A third-party experiment platform: needs an account and sends user identifiers out.

## Consequences

A small experiment cannot detect a modest sample imbalance; the check is for gross breakage. No experiment runs yet; no page is wired to it.
