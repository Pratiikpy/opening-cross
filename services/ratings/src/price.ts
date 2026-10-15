// Where a token's price at a past moment comes from. The outcome of a rated cross is the price of its token some time after the cross against the price the cross cleared at, so the
// source has to answer "what did one base token cost, in the cross's own quote asset, at time t". GeckoTerminal's public API serves hourly bars for the last 180 days for any pool it
// indexes; a token with no pool in the cross's quote asset, no bar at that hour, or a moment beyond 180 days ago is UNRESOLVED with the reason, never estimated.
export interface PricePoint {
  /** Quote tokens per base token, in human units. */
  price: number;
  /** Start of the hourly bar the price is the open of. */
  barStart: number;
  /** A reference a reader can open: the pool and the bar. */
  source: string;
}
export type PriceAnswer = { ok: true; point: PricePoint } | { ok: false; why: string };

export interface PriceSource {
  priceAt(baseMint: string, quoteMint: string, tSecs: number): Promise<PriceAnswer>;
}

export interface GeckoOptions {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Least time between requests; the public limit is 30 a minute. Default 2300 ms. */
  minIntervalMs?: number;
  base?: string;
}

const RETENTION_SECS = 175 * 86_400;

export class GeckoPriceSource implements PriceSource {
  private readonly f: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private last = 0;
  private readonly pools = new Map<string, string | null>();
  constructor(private readonly o: GeckoOptions = {}) {
    this.f = o.fetch ?? fetch;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = o.now ?? Date.now;
  }

  private async get(path: string): Promise<{ status: number; body: unknown }> {
    for (let attempt = 0; attempt < 6; attempt++) {
      const wait = this.last + (this.o.minIntervalMs ?? 2_300) - this.now();
      if (wait > 0) await this.sleep(wait);
      this.last = this.now();
      let res: Response;
      try {
        res = await this.f(`${this.o.base ?? 'https://api.geckoterminal.com/api/v2'}${path}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
      } catch (e) {
        if (attempt === 5) throw e;
        await this.sleep(2_000 * (attempt + 1));
        continue;
      }
      if (res.status === 429 && attempt < 5) {
        await this.sleep(15_000 + attempt * 5_000);
        continue;
      }
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        /* handled by the caller from the status */
      }
      return { status: res.status, body };
    }
    return { status: 429, body: null };
  }

  /** The deepest pool of the base token whose quote token is `quoteMint`, or null. */
  private async pool(baseMint: string, quoteMint: string): Promise<string | null> {
    const k = `${baseMint}|${quoteMint}`;
    if (this.pools.has(k)) return this.pools.get(k)!;
    const r = await this.get(`/networks/solana/tokens/${baseMint}/pools?page=1`);
    if (r.status !== 200) return null;
    type P = { attributes: { address: string; reserve_in_usd: string }; relationships?: { quote_token?: { data?: { id?: string } }; base_token?: { data?: { id?: string } } } };
    const rows = ((r.body as { data?: P[] })?.data ?? []).filter((p) => p.relationships?.quote_token?.data?.id === `solana_${quoteMint}` && p.relationships?.base_token?.data?.id === `solana_${baseMint}`);
    rows.sort((a, b) => Number(b.attributes.reserve_in_usd) - Number(a.attributes.reserve_in_usd));
    const best = rows[0]?.attributes.address ?? null;
    this.pools.set(k, best);
    return best;
  }

  async priceAt(baseMint: string, quoteMint: string, t: number): Promise<PriceAnswer> {
    if (this.now() / 1000 - t > RETENTION_SECS) return { ok: false, why: 'the moment is more than 175 days ago, beyond what the public price API serves' };
    if (t > this.now() / 1000) return { ok: false, why: 'the moment has not happened yet' };
    const pool = await this.pool(baseMint, quoteMint);
    if (!pool) return { ok: false, why: 'no pool pairs this token with the cross\'s quote asset on the price source' };
    const r = await this.get(`/networks/solana/pools/${pool}/ohlcv/hour?aggregate=1&limit=3&currency=token&before_timestamp=${Math.ceil(t / 3600) * 3600 + 3600}`);
    if (r.status !== 200) return { ok: false, why: `the price source answered HTTP ${r.status}` };
    const list = (r.body as { data?: { attributes?: { ohlcv_list?: number[][] } } })?.data?.attributes?.ohlcv_list ?? [];
    const bar = list.find((b) => b[0]! <= t && t < b[0]! + 3600);
    if (!bar) return { ok: false, why: 'the pool had no trade in the hour of that moment' };
    const open = bar[1]!;
    if (!(open > 0) || !Number.isFinite(open)) return { ok: false, why: 'the bar has no usable price' };
    return { ok: true, point: { price: open, barStart: bar[0]!, source: `geckoterminal:${pool}:${bar[0]}` } };
  }
}
