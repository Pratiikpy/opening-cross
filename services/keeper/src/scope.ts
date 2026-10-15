// Which crosses a scoped keeper serves (KEEPER_CREATORS). A cross made by `spawn_next` has the series' own address as its creator (ADR-0456), not the series' authority,
// so a scope that names only issuers' wallets would find the series, spawn its crosses, and then never clear, claim, refund or finalize them: the crosses of a recurring
// series are served when the series' authority is in scope. The authorities' series are read from the same source the series duty reads (`discovery.series`), once a pass.
import type { Address } from '@solana/kit';

export type KeeperScope = {
  /** The creators named by the operator. */
  creators: readonly Address[];
  /** Reads the series of the named authorities again; call it at the start of a pass. A failed read keeps the last answer. */
  refresh: () => Promise<void>;
  /** Whether a cross made by `creator` is served: an operator-named creator, or a series of an operator-named authority. */
  accept: (cross: { creator: string }) => boolean;
  /** The series addresses currently in scope. */
  series: () => ReadonlySet<string>;
};

/** `null` when no creator is named: the keeper then serves every cross it discovers. */
export function keeperScope(creators: readonly Address[], seriesOfAuthorities: () => Promise<Address[]>, onError: (e: unknown) => void = () => undefined): KeeperScope | null {
  if (creators.length === 0) return null;
  const named = new Set<string>(creators);
  let series: ReadonlySet<string> = new Set();
  return {
    creators,
    refresh: async () => {
      try {
        series = new Set(await seriesOfAuthorities());
      } catch (e) {
        onError(e);
      }
    },
    accept: (cross) => named.has(cross.creator) || series.has(cross.creator),
    series: () => series,
  };
}
