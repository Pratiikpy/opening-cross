// Settled crosses from the public API: one request for the list, then the fairness proof (grid, guards, merged book, the
// program's record) and the cross detail (kind, supply mode, fees, window) of each. The proof carries the merged book that the
// program cleared, so the replay starts from exactly that, not from a reconstruction of the order log.
import { NoPrintReason } from '@opening-cross/cross-core-client';
import type { HistoricalCross, Order, Outcome, Unreplayable } from './types.js';

export type HistoryResult = { crosses: HistoricalCross[]; skipped: Unreplayable[] };

type Proof = {
  state: string;
  params: { minPrice: string; tick: string; ticks: number; priceScale: string; referencePrice: string | null; minMatched: string; maxImbalanceBps: number | null; oracleGuard: boolean };
  book: { price: string; buy: string; sell: string }[];
  onchain: { printed: boolean; price: string | null; matched: string | null; rationed: string | null; noPrintReason: number | null };
  rules?: unknown;
};
type Detail = { kind: string; supplyMode: string; disclosure: 'open' | 'sealed'; baseMint: string | null; quoteMint: string; window: { closeTs: string }; fees: { protocolBps: number; integratorBps: number } };

export function crossFrom(address: string, proof: Proof, d: Detail): HistoricalCross | Unreplayable {
  if (proof.state === 'Live') return { address, reason: 'the cross has not settled' };
  if (proof.rules) return { address, reason: 'it uses extended allocation rules (classes, insider limits or a lottery) that this replay does not model' };
  if (d.baseMint === null) return { address, reason: 'it has no base mint bound' };
  const book: Order[] = [];
  for (const l of proof.book) {
    if (BigInt(l.buy) > 0n) book.push({ side: 'buy', price: BigInt(l.price), quantity: BigInt(l.buy) });
    if (BigInt(l.sell) > 0n) book.push({ side: 'sell', price: BigInt(l.price), quantity: BigInt(l.sell) });
  }
  const o = proof.onchain;
  const reason = o.noPrintReason === null ? 'NoCross' : (NoPrintReason[o.noPrintReason] ?? `Unknown${o.noPrintReason}`);
  const recorded: Outcome = o.printed
    ? { printed: true, price: BigInt(o.price!), matched: BigInt(o.matched!), rationed: o.rationed === 'buy' || o.rationed === 'sell' ? o.rationed : null }
    : { printed: false, reason };
  return {
    address,
    baseMint: d.baseMint,
    quoteMint: d.quoteMint,
    closeTs: BigInt(d.window.closeTs),
    kind: d.kind,
    supplyMode: d.supplyMode,
    disclosure: d.disclosure,
    grid: { min: BigInt(proof.params.minPrice), tick: BigInt(proof.params.tick), ticks: proof.params.ticks, priceScale: BigInt(proof.params.priceScale) },
    referencePrice: proof.params.referencePrice === null ? null : BigInt(proof.params.referencePrice),
    minMatched: BigInt(proof.params.minMatched),
    maxImbalanceBps: proof.params.maxImbalanceBps === null ? null : BigInt(proof.params.maxImbalanceBps),
    feeBps: d.fees.protocolBps + d.fees.integratorBps,
    book,
    recorded,
    oracleGuard: proof.params.oracleGuard,
  };
}

export const isUnreplayable = (x: HistoricalCross | Unreplayable): x is Unreplayable => !('grid' in x);

/** The two responses a replay needs for one cross. A finalized cross never changes, so they can be kept and reused. */
export type RawCross = { proof: Proof; detail: Detail };
export type ApiHistoryOptions = {
  fetch?: typeof fetch;
  concurrency?: number;
  attempts?: number;
  sleep?: (ms: number) => Promise<void>;
  onProgress?: (done: number, total: number) => void;
  /** Responses already read, keyed by cross address; filled in as new ones are read. Only finalized crosses are ever stored. */
  cache?: Record<string, RawCross>;
};

export async function loadFromApi(baseUrl: string, o: ApiHistoryOptions & { limit?: number } = {}): Promise<HistoryResult> {
  const f = o.fetch ?? fetch;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const base = baseUrl.replace(/\/$/, '');
  async function get<T>(path: string): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      const res = await f(`${base}${path}`, { headers: { accept: 'application/json' } });
      if (res.ok) return (await res.json()) as T;
      if ((res.status === 429 || res.status >= 500) && attempt < (o.attempts ?? 6)) {
        await sleep(Math.min(8_000, 500 * 2 ** attempt));
        continue;
      }
      throw new Error(`${path} answered HTTP ${res.status}`);
    }
  }
  const list = await get<{ crosses: { address: string; state: string }[] }>(`/v1/crosses/summary?limit=${o.limit ?? 1000}`);
  const settled = list.crosses.filter((c) => c.state !== 'Live');
  const out: (HistoricalCross | Unreplayable)[] = new Array(settled.length);
  let next = 0;
  let done = 0;
  await Promise.all(
    Array.from({ length: Math.min(o.concurrency ?? 3, settled.length) }, async () => {
      for (let i = next++; i < settled.length; i = next++) {
        const address = settled[i]!.address;
        try {
          const hit = o.cache?.[address];
          const [proof, detail] = hit ? [hit.proof, hit.detail] : await Promise.all([get<Proof>(`/v1/crosses/${address}/proof`), get<Detail>(`/v1/crosses/${address}`)]);
          if (o.cache && !hit && settled[i]!.state === 'Finalized') o.cache[address] = { proof, detail };
          out[i] = crossFrom(address, proof, detail);
        } catch (e) {
          out[i] = { address, reason: `could not be read: ${e instanceof Error ? e.message : String(e)}` };
        }
        o.onProgress?.(++done, settled.length);
      }
    }),
  );
  const crosses = out.filter((x): x is HistoricalCross => !isUnreplayable(x)).sort((a, b) => (a.closeTs < b.closeTs ? -1 : a.closeTs > b.closeTs ? 1 : a.address < b.address ? -1 : 1));
  return { crosses, skipped: out.filter(isUnreplayable) };
}
