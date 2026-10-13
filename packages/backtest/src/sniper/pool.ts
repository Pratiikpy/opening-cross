/**
 * Constant-product pools, bonding curves with virtual reserves, and a small router.
 * A port of research/scripts/sim/amm.py (all amounts are USD quote and whole tokens).
 *
 * A bonding curve is a constant-product pool whose reserves include virtual amounts: buying
 * stops when the real token inventory is exhausted (graduation); selling stops when the real
 * quote reserve is exhausted. This is how pump.fun and a single-segment Meteora DBC curve work.
 */

export interface PoolOpts {
  xv?: number;
  yv?: number;
  lpFrac?: number;
  issuerFrac?: number;
  feeFn?: ((t: number) => number) | null;
  onSoldout?: ((p: Pool) => Pool[]) | null;
}

export class Pool {
  x: number; // quote reserve including virtual
  y: number; // token reserve including virtual
  readonly xv: number; // virtual quote: x never falls below it
  readonly yv: number; // virtual token floor: y never falls below it
  readonly fee: number;
  readonly feeFn: ((t: number) => number) | null;
  readonly lpFrac: number; // share of the fee compounded into the reserves
  readonly issuerFrac: number; // share of the fee paid to issuer / creator
  readonly name: string;
  onSoldout: ((p: Pool) => Pool[]) | null;
  soldout = false;
  feeIssuer = 0;
  feeOther = 0;
  vol = 0;

  constructor(x: number, y: number, fee: number, name: string, o: PoolOpts = {}) {
    this.x = x;
    this.y = y;
    this.fee = fee;
    this.name = name;
    this.xv = o.xv ?? 0;
    this.yv = o.yv ?? 0;
    this.lpFrac = o.lpFrac ?? 0;
    this.issuerFrac = o.issuerFrac ?? 0;
    this.feeFn = o.feeFn ?? null;
    this.onSoldout = o.onSoldout ?? null;
  }

  price(): number {
    return this.x / this.y;
  }
  realQuote(): number {
    return this.x - this.xv;
  }
  feeAt(t: number, override: number | null = null): number {
    if (override !== null) return override;
    if (this.feeFn) return this.feeFn(t);
    return this.fee;
  }

  /** Gross quote needed so that the post-trade marginal price reaches pTarget / (1 - fee). */
  usdToPrice(pTarget: number, fee: number): number {
    const k = this.x * this.y;
    const xNew = Math.sqrt(Math.max(pTarget * (1 - fee), 0) * k);
    const net = xNew - this.x;
    if (net <= 0) return 0;
    return net / (1 - fee);
  }

  /** Quote (before fee) to move the price up by pct, limited to the remaining inventory. */
  depthUp(pct = 0.02): number {
    if (this.soldout) return 0;
    const k = this.x * this.y;
    let xNew = Math.sqrt(this.price() * (1 + pct) * k);
    const yNew = k / xNew;
    if (yNew < this.yv) xNew = k / this.yv;
    return Math.max(xNew - this.x, 0);
  }

  private bookFee(amt: number): void {
    this.feeIssuer += amt * this.issuerFrac;
    this.feeOther += amt * (1 - this.issuerFrac - this.lpFrac);
  }

  /** Spend up to `usd` (gross, fee included). Returns [tokensOut, usdSpent]. */
  buy(usd: number, t: number, feeOverride: number | null = null): [number, number] {
    if (usd <= 0 || this.soldout) return [0, 0];
    const f = this.feeAt(t, feeOverride);
    let net = usd * (1 - f);
    const k = this.x * this.y;
    let yNew = k / (this.x + net);
    let hit = false;
    if (yNew <= this.yv) {
      yNew = this.yv;
      net = k / yNew - this.x;
      usd = net / (1 - f);
      hit = true;
    }
    const out = this.y - yNew;
    const feeAmt = usd - net;
    this.x += net + feeAmt * this.lpFrac;
    this.y = yNew;
    this.bookFee(feeAmt);
    this.vol += usd;
    if (hit && this.yv > 0) this.soldout = true;
    return [out, usd];
  }

  /** Sell tokens. Returns [usdReceived, tokensSold]. */
  sell(tokens: number, t: number, feeOverride: number | null = null): [number, number] {
    if (tokens <= 0) return [0, 0];
    const f = this.feeAt(t, feeOverride);
    const k = this.x * this.y;
    let xNew = k / (this.y + tokens);
    if (xNew < this.xv) {
      xNew = this.xv;
      tokens = k / xNew - this.y;
      if (tokens <= 0) return [0, 0];
    }
    const gross = this.x - xNew;
    const feeAmt = gross * f;
    this.x = xNew + feeAmt * this.lpFrac;
    this.y += tokens;
    if (this.soldout && this.onSoldout === null && this.yv > 0 && this.y > this.yv) this.soldout = false;
    this.bookFee(feeAmt);
    this.vol += gross;
    return [gross - feeAmt, tokens];
  }
}

/** Constant-product curve from price p0 to p1 selling `sold` tokens (amm.py is used by sim.py:187-194). */
export function cpCurve(
  p0: number,
  p1: number,
  sold: number,
  fee: number,
  name: string,
  o: Omit<PoolOpts, "xv" | "yv"> = {},
): Pool {
  const r = Math.sqrt(p1 / p0);
  const y1 = sold / (r - 1);
  const y0 = y1 * r;
  const k = p0 * y0 * y0;
  const x0 = k / y0;
  return new Pool(x0, y0, fee, name, { ...o, xv: x0, yv: y1 });
}

/** Exponential anti-sniper fee scheduler from `cliff` to `base` over nPeriods one-second periods (sim.py:197-204). */
export function expFeeFn(cliff: number, base: number, nPeriods: number, period = 1): (t: number) => number {
  const r = 1 - Math.pow(base / cliff, 1 / nPeriods);
  return (t: number) => {
    if (t < 0) return cliff;
    return Math.max(base, cliff * Math.pow(1 - r, Math.floor(t / period)));
  };
}

export class Market {
  pools: Pool[];
  retired: Pool[] = [];

  constructor(pools: Pool[]) {
    this.pools = [...pools];
  }

  live(): Pool[] {
    return this.pools.filter((p) => !p.soldout);
  }

  private liveOrAll(): Pool[] {
    const l = this.live();
    return l.length > 0 ? l : this.pools;
  }

  /** Reference price: the deepest live pool's price. */
  price(): number {
    const lp = this.liveOrAll();
    let best = lp[0]!;
    let bestQ = best.realQuote() + 1e-9;
    for (const p of lp) {
      const q = p.realQuote() + 1e-9;
      if (q > bestQ) {
        best = p;
        bestQ = q;
      }
    }
    return best.price();
  }

  depthUp(pct = 0.02): number {
    return this.pools.reduce((s, p) => s + p.depthUp(pct), 0);
  }

  realQuote(): number {
    return this.pools.reduce((s, p) => s + Math.max(p.realQuote(), 0), 0);
  }

  private maybeGraduate(): void {
    let changed = true;
    while (changed) {
      changed = false;
      for (const p of [...this.pools]) {
        if (p.soldout && p.onSoldout !== null) {
          const cb = p.onSoldout;
          p.onSoldout = null;
          const created = cb(p);
          this.pools = this.pools.filter((q) => q !== p);
          this.retired.push(p);
          this.pools.push(...created);
          changed = true;
        }
      }
    }
  }

  /** Buy with up to `usd`, never paying a marginal price (fee included) above `limit`. Returns [tokens, spent]. */
  buy(usd: number, t: number, feeOverride: number | null = null, limit: number | null = null): [number, number] {
    let tokens = 0;
    let spent = 0;
    let remaining = usd;
    for (let iter = 0; iter < 40; iter++) {
      if (remaining < 1e-6) break;
      this.maybeGraduate();
      const live = this.live();
      if (live.length === 0) break;
      let pool = live[0]!;
      let bestKey = pool.price() / (1 - pool.feeAt(t, feeOverride));
      for (const p of live) {
        const key = p.price() / (1 - p.feeAt(t, feeOverride));
        if (key < bestKey) {
          pool = p;
          bestKey = key;
        }
      }
      const f = pool.feeAt(t, feeOverride);
      if (f >= 0.999) break;
      let chunk = live.length === 1 ? remaining : Math.max(remaining / 4, Math.min(remaining, 50));
      if (limit !== null) {
        if (pool.price() / (1 - f) >= limit) break;
        chunk = Math.min(chunk, pool.usdToPrice(limit, f));
        if (chunk < 1e-6) break;
      }
      const [out, used] = pool.buy(chunk, t, feeOverride);
      tokens += out;
      spent += used;
      remaining -= used;
      if (used < 1e-9 && !pool.soldout) break;
    }
    this.maybeGraduate();
    return [tokens, spent];
  }

  /** Sell tokens across the pools. Returns [usdReceived, tokensSold]. */
  sell(tokens: number, t: number): [number, number] {
    let usd = 0;
    let remaining = tokens;
    for (let iter = 0; iter < 40; iter++) {
      if (remaining < 1e-9) break;
      const cand = this.pools.filter((p) => p.realQuote() > 1e-6);
      if (cand.length === 0) break;
      let pool = cand[0]!;
      let bestKey = pool.price() * (1 - pool.feeAt(t));
      for (const p of cand) {
        const key = p.price() * (1 - p.feeAt(t));
        if (key > bestKey) {
          pool = p;
          bestKey = key;
        }
      }
      const chunk = cand.length === 1 ? remaining : remaining / 2 + 1e-9;
      const [got, sold] = pool.sell(Math.min(chunk, remaining), t);
      usd += got;
      remaining -= sold;
      if (sold <= 1e-12) break;
    }
    return [usd, tokens - remaining];
  }

  allPools(): Pool[] {
    return [...this.pools, ...this.retired];
  }
  feesIssuer(): number {
    return this.allPools().reduce((s, p) => s + p.feeIssuer, 0);
  }
  feesOther(): number {
    return this.allPools().reduce((s, p) => s + p.feeOther, 0);
  }
  volume(): number {
    return this.allPools().reduce((s, p) => s + p.vol, 0);
  }
}
