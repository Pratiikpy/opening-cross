// One scheduled round of the premium monitor, as a plain function of its dependencies so a test can drive the real
// code with fake sources and the process only wires in the live ones.
import type { Book } from '@opening-cross/authenticity';
import {
  type IssuerState,
  type MeasuredAsset,
  type MintFacts,
  type Observation,
  type QuoteFn,
  type Reference,
  type UniverseEntry,
  candidates,
  collectRound,
  routable,
} from '@opening-cross/premium';

export interface RoundDeps {
  readonly book: Book;
  readonly quote: QuoteFn;
  readonly fetchReferences: () => Promise<Reference[]>;
  readonly fetchIssuer: () => Promise<IssuerState[]>;
  readonly readFacts: (mints: readonly string[], nowSeconds: bigint) => Promise<Map<string, MintFacts>>;
  readonly now: () => number;
  readonly sizesUsd: readonly number[];
  readonly paceMs: number;
}

export interface Universe {
  readonly entries: readonly UniverseEntry[];
  readonly builtAt: number;
  readonly dropped: readonly { ticker: string; reason: string }[];
}

/** Candidates with an oracle reference, then those Jupiter can route. Rebuilt rarely: it costs one quote per candidate. */
export async function buildUniverse(d: RoundDeps, only?: readonly string[]): Promise<Universe> {
  const refs = (await d.fetchReferences()).filter((r) => r.kind === 'hip3_oracle');
  const wanted = candidates(d.book, refs).filter((e) => !only || only.includes(e.ticker));
  const { kept, dropped } = await routable(d.quote, wanted, d.paceMs);
  return { entries: kept, builtAt: d.now(), dropped: dropped.map((x) => ({ ticker: x.entry.ticker, reason: x.reason })) };
}

export async function measureRound(d: RoundDeps, universe: Universe): Promise<Observation[]> {
  const now = d.now();
  const [refs, states] = await Promise.all([d.fetchReferences(), d.fetchIssuer()]);
  const oracle = refs.filter((r) => r.kind === 'hip3_oracle');
  const facts = await d.readFacts(universe.entries.map((e) => e.mint), BigInt(now));
  const assets: MeasuredAsset[] = universe.entries
    .filter((e) => facts.has(e.mint))
    .map((e) => ({ ...e, decimals: facts.get(e.mint)!.decimals, multiplierE12: facts.get(e.mint)!.multiplierE12 }));
  return collectRound(assets, {
    quote: d.quote,
    now,
    sizesUsd: d.sizesUsd,
    referenceKind: 'hip3_oracle',
    references: new Map(oracle.map((r) => [r.ticker, r])),
    issuer: new Map(states.map((s) => [s.ticker, s])),
    paceMs: d.paceMs,
  });
}
