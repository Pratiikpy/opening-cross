// Summaries of a sample of premiums. Every reported value is a premium that was actually quoted: quantiles are the
// element at index floor(n x q) of the sorted sample, never an interpolation between two quotes.
import type { Observation } from './types.js';

export function quantileExact(sorted: readonly bigint[], q: number): bigint | null {
  if (sorted.length === 0) return null;
  const i = Math.min(sorted.length - 1, Math.floor(sorted.length * q));
  return sorted[i] as bigint;
}

export interface Summary {
  readonly n: number;
  readonly medianBpsX100: bigint | null;
  readonly p10BpsX100: bigint | null;
  readonly p90BpsX100: bigint | null;
  readonly minBpsX100: bigint | null;
  readonly maxBpsX100: bigint | null;
  /** Median of |premium|: the typical distance from the reference, whichever way it goes. */
  readonly medianAbsBpsX100: bigint | null;
}

const ascending = (a: bigint, b: bigint): number => (a < b ? -1 : a > b ? 1 : 0);

export function summarise(premiums: readonly bigint[]): Summary {
  const s = [...premiums].sort(ascending);
  const abs = s.map((p) => (p < 0n ? -p : p)).sort(ascending);
  return {
    n: s.length,
    medianBpsX100: quantileExact(s, 0.5),
    p10BpsX100: quantileExact(s, 0.1),
    p90BpsX100: quantileExact(s, 0.9),
    minBpsX100: s[0] ?? null,
    maxBpsX100: s[s.length - 1] ?? null,
    medianAbsBpsX100: quantileExact(abs, 0.5),
  };
}

export interface Group {
  readonly session: Observation['session'];
  readonly sizeUsd: number;
  readonly leg: Observation['leg'];
  readonly summary: Summary;
  /** Observations that could not be priced, by reason: reported next to the numbers, never dropped. */
  readonly excluded: Readonly<Record<string, number>>;
}

/** Groups by session x size x leg; only status `ok` observations enter the summary, the rest are counted by reason. */
export function groupObservations(obs: readonly Observation[]): Group[] {
  const by = new Map<string, Observation[]>();
  for (const o of obs) {
    const k = `${o.session}|${o.sizeUsd}|${o.leg}`;
    by.set(k, [...(by.get(k) ?? []), o]);
  }
  return [...by.values()]
    .map((list) => {
      const first = list[0] as Observation;
      const excluded: Record<string, number> = {};
      for (const o of list) if (o.status !== 'ok') excluded[o.status] = (excluded[o.status] ?? 0) + 1;
      return {
        session: first.session,
        sizeUsd: first.sizeUsd,
        leg: first.leg,
        summary: summarise(list.filter((o) => o.status === 'ok' && o.premiumBpsX100 !== null).map((o) => o.premiumBpsX100 as bigint)),
        excluded,
      };
    })
    .sort((a, b) => a.session.localeCompare(b.session) || a.sizeUsd - b.sizeUsd || a.leg.localeCompare(b.leg));
}
