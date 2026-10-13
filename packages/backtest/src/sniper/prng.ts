/**
 * Seeded, dependency-free PRNG for the sniper model.
 *
 * xoshiro128** (Blackman and Vigna) seeded through splitmix32. A generator is
 * addressed by (seed, ...stream) so every random source in a run (launch draw,
 * population draw, mechanism, post-launch noise) has its own independent stream
 * and a run is reproducible from the single integer seed. This mirrors the
 * original model, which seeds numpy with [seed, k] sub-streams (research/scripts/sim/sim.py:525-528).
 */

function splitmix32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x9e3779b9) | 0;
    let t = a ^ (a >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t = t ^ (t >>> 15);
    t = Math.imul(t, 0x735a2d97);
    return (t ^ (t >>> 15)) >>> 0;
  };
}

function mixParts(parts: readonly number[]): number {
  let h = 0x811c9dc5 | 0;
  for (const p of parts) {
    let k = Math.imul(p | 0, 0xcc9e2d51);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, 0x1b873593);
    h ^= k;
    h = (h << 13) | (h >>> 19);
    h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  }
  h ^= parts.length;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h | 0;
}

export class Rng {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;
  private spare: number | null = null;

  constructor(seed: number, ...stream: number[]) {
    const sm = splitmix32(mixParts([seed, ...stream]));
    this.s0 = sm();
    this.s1 = sm();
    this.s2 = sm();
    this.s3 = sm();
    if ((this.s0 | this.s1 | this.s2 | this.s3) === 0) this.s0 = 1;
  }

  /** Uniform in [0, 1) with 32 bits of resolution. */
  random(): number {
    const s1x5 = Math.imul(this.s1, 5);
    const r = Math.imul((s1x5 << 7) | (s1x5 >>> 25), 9) >>> 0;
    const t = this.s1 << 9;
    this.s2 ^= this.s0;
    this.s3 ^= this.s1;
    this.s1 ^= this.s2;
    this.s0 ^= this.s3;
    this.s2 ^= t;
    this.s3 = (this.s3 << 11) | (this.s3 >>> 21);
    return r / 4294967296;
  }

  uniform(lo: number, hi: number): number {
    return lo + (hi - lo) * this.random();
  }

  /** Integer in [lo, hi) . */
  integers(lo: number, hi: number): number {
    return lo + Math.floor(this.random() * (hi - lo));
  }

  /** Standard normal by Box-Muller, with the spare variate cached. */
  stdNormal(): number {
    if (this.spare !== null) {
      const s = this.spare;
      this.spare = null;
      return s;
    }
    const u1 = 1 - this.random(); // (0, 1]
    const u2 = this.random();
    const r = Math.sqrt(-2 * Math.log(u1));
    this.spare = r * Math.sin(2 * Math.PI * u2);
    return r * Math.cos(2 * Math.PI * u2);
  }

  normal(mu = 0, sigma = 1): number {
    return mu + sigma * this.stdNormal();
  }

  /** exp(N(log(median), sigma)): lognormal parametrised by its median. */
  lognormalMedian(median: number, sigma: number): number {
    return Math.exp(Math.log(median) + sigma * this.stdNormal());
  }

  exponential(scale: number): number {
    return -scale * Math.log(1 - this.random());
  }

  /**
   * Exact Poisson. Knuth's multiplication method on chunks of lambda <= 20, summed
   * (a sum of independent Poissons is Poisson), so it stays exact for lambda in the thousands.
   */
  poisson(lambda: number): number {
    if (lambda <= 0) return 0;
    let remaining = lambda;
    let total = 0;
    while (remaining > 0) {
      const lam = Math.min(remaining, 20);
      remaining -= lam;
      const limit = Math.exp(-lam);
      let k = 0;
      let p = 1;
      do {
        k++;
        p *= this.random();
      } while (p > limit);
      total += k - 1;
    }
    return total;
  }

  /** In-place Fisher-Yates shuffle. */
  shuffle<T>(a: T[]): T[] {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this.random() * (i + 1));
      const t = a[i]!;
      a[i] = a[j]!;
      a[j] = t;
    }
    return a;
  }
}
