// How the A/B analysis behaves when the truth is known: the false-positive rate with no real change, the power at the minimum
// detectable effect, and how often a broken split is caught or falsely reported. Seeded, so the numbers repeat.
//   pnpm exec tsx scripts/simulate.ts [trials]
import { analyse, newPlan, rng, type Plan } from '../src/index.js';

const trials = Number(process.argv[2] ?? 3000);
const plan: Plan = newPlan({ id: 'sim', salt: 's', variants: [{ name: 'control', weightBps: 5000 }, { name: 'b', weightBps: 5000 }], metric: { name: 'ok', kind: 'proportion' }, minimumDetectableEffect: 0.05, baseline: 0.2 });

function trial(r: () => number, delta: number, bSkew = 0) {
  const obs = [];
  for (const v of plan.variants) {
    const rate = v.name === 'b' ? 0.2 + delta : 0.2;
    const n = Math.round(plan.plannedPerVariant * (v.name === 'b' ? 1 + bSkew : 1));
    for (let i = 0; i < n; i++) obs.push({ unit: `${v.name}-${i}`, variant: v.name, value: r() < rate ? 1 : 0 });
  }
  return analyse(plan, obs).verdict.status;
}
const share = (seed: number, delta: number, skew = 0) => {
  const r = rng(seed);
  const tally: Record<string, number> = {};
  for (let t = 0; t < trials; t++) {
    const s = trial(r, delta, skew);
    tally[s] = (tally[s] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(tally).map(([k, v]) => [k, +(v / trials).toFixed(4)]));
};
console.log(JSON.stringify({ trials, plannedPerVariant: plan.plannedPerVariant, nominal: { alpha: 0.05, power: 0.8 } }));
console.log('no real change (A/A)        ', JSON.stringify(share(1, 0)));
console.log('true effect = minimum, +5pp ', JSON.stringify(share(2, 0.05)));
console.log('true effect 2x minimum      ', JSON.stringify(share(3, 0.1)));
console.log('a 4% extra in arm b, no effect', JSON.stringify(share(4, 0, 0.04)));
console.log('a 10% extra in arm b, no effect', JSON.stringify(share(5, 0, 0.1)));
