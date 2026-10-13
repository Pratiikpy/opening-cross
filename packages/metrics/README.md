# @opening-cross/metrics

A versioned registry of metric specifications and an A/B experiment library.

- **Specifications** (`src/specs.ts`, rendered to `docs/metrics/METRIC_SPECS.md` by `pnpm --filter @opening-cross/metrics docs`): 12 metrics, each with a definition, formula, unit, what one observation is, a minimum sample before a headline, where it is computed, caveats, and a content hash. A test fails if the document differs from the registry or a cited route or function does not exist.
- **Experiments** (`src/ab.ts`): `newPlan` fixes the metric, minimum detectable effect, alpha, power and sample before any data; `assign(plan, unit)` is a pure function so a user keeps one variant; `analyse` refuses to decide before the planned sample (it returns "too early" with the estimate), checks the sample ratio first, and shares the false-positive budget across variants.

```ts
const plan = newPlan({ id: 'cta', salt: 'x9f2', variants: [{ name: 'control', weightBps: 5000 }, { name: 'b', weightBps: 5000 }], metric: { name: 'orders', kind: 'proportion' }, minimumDetectableEffect: 0.02, baseline: 0.1 });
plan.plannedPerVariant;                  // 3841
assign(plan, 'wallet-address');          // 'control' | 'b', the same every time
analyse(plan, observations).verdict;     // too-early | sample-ratio-mismatch | no-detectable-difference | difference
```

`pnpm --filter @opening-cross/metrics simulate` checks the analysis against known truth: 5.47% false positives with no change (nominal 5%) and 79.4% power at the minimum effect (nominal 80%). Evidence: `docs/evidence/W2A-R12-metrics.md`; decision: `docs/adr/0307-metric-specs-and-experiments.md`.
