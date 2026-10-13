import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SPECS, type Plan, analyse, assign, chiSquareSf, exposure, getSpec, headlineAllowed, newPlan, normalCdf, normalQuantile, registryHash, renderSpecs, rng, sampleRatio, sampleSize, specHash, validateRegistry, wilsonInterval } from '../src/index.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

describe('distribution functions against published values', () => {
  it('normal CDF and quantile', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 7);
    expect(normalCdf(1.96)).toBeCloseTo(0.9750021, 6);
    expect(normalCdf(-1.96)).toBeCloseTo(0.0249979, 6);
    expect(normalCdf(3)).toBeCloseTo(0.9986501, 6);
    expect(normalQuantile(0.975)).toBeCloseTo(1.959964, 5);
    expect(normalQuantile(0.8)).toBeCloseTo(0.841621, 5);
    expect(normalQuantile(0.995)).toBeCloseTo(2.575829, 5);
    expect(normalQuantile(0.001)).toBeCloseTo(-3.090232, 5);
    for (const p of [0.001, 0.02, 0.3, 0.5, 0.77, 0.9999]) expect(normalCdf(normalQuantile(p))).toBeCloseTo(p, 6);
    expect(() => normalQuantile(0)).toThrow(RangeError);
  });
  it('chi-square survival function', () => {
    expect(chiSquareSf(3.841459, 1)).toBeCloseTo(0.05, 5);
    expect(chiSquareSf(9.21034, 2)).toBeCloseTo(0.01, 5);
    expect(chiSquareSf(11.0705, 5)).toBeCloseTo(0.05, 4);
    expect(chiSquareSf(0, 3)).toBe(1);
    expect(chiSquareSf(200, 2)).toBeLessThan(1e-40);
  });
  it('Wilson interval', () => {
    const w = wilsonInterval(5, 10);
    expect(w.lo).toBeCloseTo(0.2366, 3);
    expect(w.hi).toBeCloseTo(0.7634, 3);
    expect(wilsonInterval(0, 0)).toEqual({ lo: 0, hi: 1 });
    expect(wilsonInterval(0, 20).lo).toBe(0);
  });
});

describe('sample size', () => {
  it('matches the textbook figures', () => {
    expect(sampleSize({ kind: 'proportion', baseline: 0.1, minimumDetectableEffect: 0.02 })).toBe(3841);
    expect(sampleSize({ kind: 'mean', baseline: 10, minimumDetectableEffect: 1 })).toBe(1570);
  });
  it('asks for more units when several variants share the false-positive budget, and refuses nonsense', () => {
    const one = sampleSize({ kind: 'proportion', baseline: 0.1, minimumDetectableEffect: 0.02 });
    const three = sampleSize({ kind: 'proportion', baseline: 0.1, minimumDetectableEffect: 0.02, comparisons: 3 });
    expect(three).toBeGreaterThan(one * 1.3);
    expect(() => sampleSize({ kind: 'proportion', baseline: 0.1, minimumDetectableEffect: 0 })).toThrow(/positive/);
    expect(() => sampleSize({ kind: 'proportion', baseline: 0.99, minimumDetectableEffect: 0.05 })).toThrow(/strictly between/);
    expect(() => sampleSize({ kind: 'mean', baseline: 0, minimumDetectableEffect: 1 })).toThrow(/standard deviation/);
  });
});

const plan2 = (over: Partial<Plan> = {}): Plan => ({ ...newPlan({ id: 'exp', salt: 'abc', variants: [{ name: 'control', weightBps: 5000 }, { name: 'b', weightBps: 5000 }], metric: { name: 'ok', kind: 'proportion' }, minimumDetectableEffect: 0.05, baseline: 0.2 }), ...over });

describe('assignment', () => {
  it('is a pure function of experiment, salt and unit, and follows the weights', () => {
    const p = plan2({ variants: [{ name: 'control', weightBps: 7000 }, { name: 'b', weightBps: 3000 }] });
    expect(assign(p, 'user-1')).toBe(assign(p, 'user-1'));
    const counts = { control: 0, b: 0 } as Record<string, number>;
    for (let i = 0; i < 20_000; i++) counts[assign(p, `u${i}`)]! += 1;
    expect(counts.b! / 20_000).toBeGreaterThan(0.29);
    expect(counts.b! / 20_000).toBeLessThan(0.31);
    expect(sampleRatio(p, counts).mismatch).toBe(false);
  });
  it('splits the same users differently in a different experiment or with a different salt', () => {
    const a = plan2();
    const b = plan2({ id: 'other' });
    const c = plan2({ salt: 'xyz' });
    let sameB = 0;
    let sameC = 0;
    for (let i = 0; i < 2000; i++) {
      if (assign(a, `u${i}`) === assign(b, `u${i}`)) sameB += 1;
      if (assign(a, `u${i}`) === assign(c, `u${i}`)) sameC += 1;
    }
    expect(sameB).toBeGreaterThan(900);
    expect(sameB).toBeLessThan(1100); // independent splits agree about half the time
    expect(sameC).toBeLessThan(1100);
  });
  it('refuses bad variant lists', () => {
    expect(() => assign({ id: 'e', salt: 's', variants: [{ name: 'a', weightBps: 10_000 }] }, 'u')).toThrow(/at least two/);
    expect(() => assign({ id: 'e', salt: 's', variants: [{ name: 'a', weightBps: 5000 }, { name: 'a', weightBps: 5000 }] }, 'u')).toThrow(/distinct/);
    expect(() => assign({ id: 'e', salt: 's', variants: [{ name: 'a', weightBps: 5000 }, { name: 'b', weightBps: 4000 }] }, 'u')).toThrow(/sum to 10,000/);
    expect(() => assign({ id: 'e', salt: 's', variants: [{ name: 'a', weightBps: 0 }, { name: 'b', weightBps: 10_000 }] }, 'u')).toThrow(/positive/);
  });
  it('an exposure record has a stable id, so logging it twice is harmless', () => {
    const p = plan2();
    const e1 = exposure(p, 'u1', 100);
    expect(exposure(p, 'u1', 999).id).toBe(e1.id);
    expect(exposure(p, 'u2', 100).id).not.toBe(e1.id);
    expect(e1.variant).toBe(assign(p, 'u1'));
  });
});

describe('sample ratio mismatch', () => {
  it('stays quiet for a fair split and sounds for a skewed one', () => {
    const p = plan2();
    expect(sampleRatio(p, { control: 1000, b: 1020 }).mismatch).toBe(false);
    const bad = sampleRatio(p, { control: 10_400, b: 9_600 });
    expect(bad.mismatch).toBe(true);
    expect(bad.pValue).toBeLessThan(1e-4);
    expect(bad.expected).toEqual({ control: 10_000, b: 10_000 });
    expect(sampleRatio(p, {}).pValue).toBe(1);
  });
  it('handles three arms with unequal weights', () => {
    const p = plan2({ variants: [{ name: 'c', weightBps: 5000 }, { name: 'x', weightBps: 2500 }, { name: 'y', weightBps: 2500 }] });
    expect(sampleRatio(p, { c: 5000, x: 2500, y: 2500 })).toMatchObject({ chi2: 0, df: 2, mismatch: false });
    expect(sampleRatio(p, { c: 5000, x: 3000, y: 2000 }).mismatch).toBe(true);
  });
});

function observations(p: Plan, n: number, rates: Record<string, number>, seed: number) {
  const r = rng(seed);
  const out = [];
  for (const v of p.variants) for (let i = 0; i < n; i++) out.push({ unit: `${v.name}-${i}`, variant: v.name, value: r() < rates[v.name]! ? 1 : 0 });
  return out;
}

describe('analysis', () => {
  const p = plan2();
  it('plans a sample and refuses to decide before it', () => {
    expect(p.plannedPerVariant).toBe(sampleSize({ kind: 'proportion', baseline: 0.2, minimumDetectableEffect: 0.05, alpha: 0.05, power: 0.8 }));
    const early = analyse(p, observations(p, Math.floor(p.plannedPerVariant / 4), { control: 0.2, b: 0.4 }, 1));
    expect(early.verdict.status).toBe('too-early');
    expect((early.verdict as { progress: number }).progress).toBeCloseTo(0.25, 1);
    expect(early.planReached).toBe(false);
    expect(early.comparisons[0]!.significant).toBe(true); // a large effect shows even early, and still is not a decision
    expect(early.verdict.message).toMatch(/inflates false positives/);
  });
  it('finds a real effect at the planned sample and reports its interval', () => {
    const a = analyse(p, observations(p, p.plannedPerVariant + 200, { control: 0.2, b: 0.27 }, 2));
    expect(a.verdict.status).toBe('difference');
    expect(a.comparisons[0]!.difference).toBeGreaterThan(0.04);
    expect(a.comparisons[0]!.interval.lo).toBeGreaterThan(0);
    expect(a.perVariant.control!.wilson).toBeDefined();
  });
  it('says no difference was detected, and what that does not show', () => {
    const a = analyse(p, observations(p, p.plannedPerVariant + 200, { control: 0.2, b: 0.2 }, 3));
    expect(a.verdict.status).toBe('no-detectable-difference');
    expect(a.verdict.message).toMatch(/not shown/);
  });
  it('reports a sample ratio mismatch before any effect', () => {
    const obs = [...observations(p, 200, { control: 0.2, b: 0.2 }, 4).filter((o) => o.variant === 'control'), ...observations(p, 100, { control: 0.2, b: 0.2 }, 5).filter((o) => o.variant === 'b')]; // 200 against 100 on a 50/50 plan
    const a = analyse(p, obs);
    expect(a.verdict.status).toBe('sample-ratio-mismatch');
    expect(a.verdict.message).toMatch(/Fix this first/);
  });
  it('counts a unit once, and refuses unknown variants and non-binary values', () => {
    const dup = [{ unit: 'u', variant: 'control', value: 1 }, { unit: 'u', variant: 'b', value: 0 }];
    expect(analyse(p, dup).perVariant.control!.n).toBe(1);
    expect(analyse(p, dup).perVariant.b!.n).toBe(0);
    expect(() => analyse(p, [{ unit: 'u', variant: 'zzz', value: 1 }])).toThrow(/unknown variant/);
    expect(() => analyse(p, [{ unit: 'u', variant: 'b', value: 0.5 }])).toThrow(/0 or 1/);
    expect(() => analyse(p, [{ unit: 'u', variant: 'b', value: NaN }])).toThrow();
  });
  it('analyses a mean metric', () => {
    const mp = newPlan({ id: 'm', salt: 's', variants: [{ name: 'control', weightBps: 5000 }, { name: 'b', weightBps: 5000 }], metric: { name: 'seconds', kind: 'mean' }, minimumDetectableEffect: 1, baseline: 10 });
    const r = rng(9);
    const gauss = () => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
    const obs = [];
    for (let i = 0; i < mp.plannedPerVariant + 100; i++) {
      obs.push({ unit: `c${i}`, variant: 'control', value: 50 + 10 * gauss() });
      obs.push({ unit: `b${i}`, variant: 'b', value: 52 + 10 * gauss() });
    }
    const a = analyse(mp, obs);
    expect(a.verdict.status).toBe('difference');
    expect(a.comparisons[0]!.difference).toBeGreaterThan(1.3);
  });
  it('shares the false-positive budget across variants', () => {
    const three = newPlan({ id: 't', salt: 's', variants: [{ name: 'c', weightBps: 4000 }, { name: 'x', weightBps: 3000 }, { name: 'y', weightBps: 3000 }], metric: { name: 'ok', kind: 'proportion' }, minimumDetectableEffect: 0.05, baseline: 0.2 });
    expect(three.plannedPerVariant).toBeGreaterThan(p.plannedPerVariant);
    const obs = [];
    const r = rng(5);
    for (const [v, n] of [['c', 4 * 900], ['x', 3 * 900], ['y', 3 * 900]] as const) for (let i = 0; i < n; i++) obs.push({ unit: `${v}${i}`, variant: v, value: r() < 0.2 ? 1 : 0 });
    const a = analyse({ ...three, plannedPerVariant: 1 }, obs);
    expect(a.comparisons).toHaveLength(2);
  });
});

describe('the analysis is calibrated: simulated experiments with known truth', () => {
  const p = newPlan({ id: 'sim', salt: 's', variants: [{ name: 'control', weightBps: 5000 }, { name: 'b', weightBps: 5000 }], metric: { name: 'ok', kind: 'proportion' }, minimumDetectableEffect: 0.05, baseline: 0.2 });
  const run = (trueDelta: number, trials: number, seed: number) => {
    const r = rng(seed);
    let positives = 0;
    let srm = 0;
    for (let t = 0; t < trials; t++) {
      const obs = [];
      for (const v of p.variants) {
        const rate = v.name === 'b' ? 0.2 + trueDelta : 0.2;
        for (let i = 0; i < p.plannedPerVariant; i++) obs.push({ unit: `${t}-${v.name}-${i}`, variant: v.name, value: r() < rate ? 1 : 0 });
      }
      const a = analyse(p, obs);
      if (a.verdict.status === 'difference') positives += 1;
      if (a.verdict.status === 'sample-ratio-mismatch') srm += 1;
    }
    return { positives: positives / trials, srm };
  };
  it('has a false-positive rate near 5% when nothing changed', () => {
    const { positives, srm } = run(0, 1200, 11);
    expect(positives).toBeGreaterThan(0.035);
    expect(positives).toBeLessThan(0.068);
    expect(srm).toBe(0);
  });
  it('detects the minimum effect about as often as planned', () => {
    const { positives } = run(0.05, 800, 12);
    expect(positives).toBeGreaterThan(0.75);
    expect(positives).toBeLessThan(0.86);
  });
});

describe('metric specs', () => {
  it('form a well-formed registry with stable hashes', () => {
    expect(validateRegistry()).toEqual([]);
    expect(new Set(SPECS.map((s) => `${s.id}@${s.version}`)).size).toBe(SPECS.length);
    const a = registryHash();
    expect(registryHash()).toBe(a);
    const changed = SPECS.map((s, i) => (i === 0 ? { ...s, definition: s.definition + ' (edited)' } : s));
    expect(registryHash(changed)).not.toBe(a);
    expect(specHash(SPECS[0]!)).toMatch(/^[0-9a-f]{64}$/);
  });
  it('are found by id and version, and gate headlines on their minimum sample', () => {
    expect(getSpec('fill-rate').version).toBe(1);
    expect(getSpec('fill-rate', 1).id).toBe('fill-rate');
    expect(() => getSpec('fill-rate', 9)).toThrow(/no metric spec/);
    expect(headlineAllowed(getSpec('fill-rate'), 29)).toBe(false);
    expect(headlineAllowed(getSpec('fill-rate'), 30)).toBe(true);
  });
  it('catch a malformed registry', () => {
    const bad = [{ ...SPECS[0]!, caveats: [] }, { ...SPECS[0]! }];
    const problems = validateRegistry(bad);
    expect(problems.join(' ')).toMatch(/appears twice/);
    expect(problems.join(' ')).toMatch(/at least one caveat/);
  });
  it('the generated document is the checked-in one', () => {
    const path = join(ROOT, 'docs', 'metrics', 'METRIC_SPECS.md');
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf8').replace(/\r\n/g, '\n')).toBe(renderSpecs() + '\n');
  });
  it('point at routes and functions that exist', () => {
    const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => (f === 'node_modules' ? [] : statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : f.endsWith('.ts') ? [join(dir, f)] : []));
    const apiSources = files(join(ROOT, 'services', 'api', 'src')).map((f) => readFileSync(f, 'utf8')).join('\n');
    for (const s of SPECS) {
      const src = readFileSync(join(ROOT, s.source.file), 'utf8');
      expect(new RegExp(`(function ${s.source.function}\\b|const ${s.source.function}\\b|export function ${s.source.function}\\b)`).test(src) || src.includes(s.source.function), `${s.id}: ${s.source.function} in ${s.source.file}`).toBe(true);
      if (s.source.route) {
        const route = s.source.route;
        expect(apiSources.includes(`'${route}'`) || apiSources.includes(`\`${route}\``), `${s.id}: route ${route}`).toBe(true);
      }
    }
  });
});
