# W2A-R12: metric specifications and an A/B experiment library (`packages/metrics`)

Date: 2026-10-13. Code: `packages/metrics` (stats, ab, specs, docs generator, simulation); tests: 25, `tsc` clean. Generated document: `docs/metrics/METRIC_SPECS.md`. Decision: ADR-0307. Unit economics: the existing `packages/fees` model (`pnpm --filter @opening-cross/fees model`), registered here as a proposed metric.

## Metric specifications

`src/specs.ts` is a versioned registry of what each reported number means: 12 metrics (fill rate, price improvement, refund share, close-to-finalized time, largest-buyer concentration, external-flow share, print rate, promise coverage, organic-volume bounds, conflicted-volume share, verified protocol-fee revenue, unit economics). Each states its definition, formula, unit, what one observation is, the minimum sample before a headline is shown, where it is computed (function, file and route) and its caveats, and has a content hash; the registry has one. Tests: the registry is well formed; a changed definition changes the hash; the checked-in `docs/metrics/METRIC_SPECS.md` equals what the registry renders (it cannot drift); and every cited route and function exists in the source it names. Of the 12, 11 are served by existing routes (including routes of the W2A groups); `unit-economics` is a model and says so.

## A/B library

`src/ab.ts`: assignment is a pure function of (experiment, salt, unit), so a user keeps one variant everywhere and an assignment can be recomputed from the log; the plan fixes the metric, the minimum detectable effect, alpha and power and computes the sample **before** any data is seen; `analyse` refuses a decision until every arm has the planned sample (it returns the estimate, marked "too early"); a sample ratio check runs first and an SRM verdict outranks any effect; several variants share the false-positive budget (Bonferroni, and the plan is sized for it); a unit seen twice counts once. The statistics (normal CDF and quantile, chi-square tail, Wilson interval) are written out with no dependency and tested against published values (for example the 3,841-per-arm sample for 10% to 12% at 80% power, and 1,570 per arm for a mean with sd 10 and a 1.0 effect).

## Does the analysis do what it claims? A simulation with known truth

`pnpm --filter @opening-cross/metrics simulate` (seeded; 3,000 experiments each, 1,094 units per arm, baseline 20%, minimum effect 5 points):

| Truth | "difference" called | Nominal |
|---|---|---|
| no change (A/A) | 5.47% | 5% false positives |
| +5 points (the minimum effect) | 79.4% | 80% power |
| +10 points | 100% | |
| no change, but arm B has 4% extra units | 4.7% | 5% |
| no change, but arm B has 10% extra units | 4.67% | 5% |

False positives and power match their nominal values within sampling error (3,000 trials: about 0.4 points). The two lopsided cases show a limit: the sample ratio check did **not** fire at 10% extra units with about 1,100 units per arm (chi-square about 5.2, p about 0.02, above the 0.001 line it uses so that it does not cry wolf on every experiment). It does fire for a 52/48 split at 20,000 units (tested). A small experiment cannot detect a modest imbalance, and the library says so only through its threshold; read it as a check for gross breakage.

## Not covered

No live experiment has been run: there is no traffic to experiment on, and no assignment is wired into any page. No sequential or Bayesian analysis (deliberately: fixed horizon only). Mean metrics use a normal approximation, adequate at the planned sizes and not for tiny or heavy-tailed samples. The metric registry describes numbers; it does not recompute them from raw rows, so "reproducible" means the definition is fixed and versioned and the computing function is named, not that the library re-derives the figure.
