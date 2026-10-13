// GET /v1/crosses/summary: every cross with its bid disclosure and supply mode in the row, so the crosses page filters
// without reading each cross from chain. Pure mapping to the shapes the list already uses.
import type { CrossSummary } from './api';
import type { CrossTraits, Disclosure, SupplyMode } from './cross-list';

export type SummaryRow = {
  address: string;
  state: CrossSummary['state'];
  disclosure: Disclosure;
  supplyMode: SupplyMode;
  orders: number;
  openTs: string;
  closeTs: string;
  revealEndTs: string;
  creator: string;
  baseMint: string;
  quoteMint: string;
  clearingPrice: string | null;
  matched: string | null;
};

export type SummaryResponse = { count: number; crosses: SummaryRow[] };

const STATES = ['Live', 'Cleared', 'NoPrint', 'Finalized'];
const DISCLOSURES = ['open', 'sealed'];
const SUPPLY = ['escrow', 'mint', 'deferred-mint'];

/** A row this page cannot show faithfully (an unknown state or enum) makes the whole summary unusable, so the caller falls back to the per-cross reads. */
export function isSummaryResponse(v: unknown): v is SummaryResponse {
  const r = v as SummaryResponse | null;
  return (
    !!r &&
    Array.isArray(r.crosses) &&
    r.crosses.every(
      (c) => typeof c.address === 'string' && STATES.includes(c.state) && DISCLOSURES.includes(c.disclosure) && SUPPLY.includes(c.supplyMode) && typeof c.orders === 'number' && typeof c.closeTs === 'string',
    )
  );
}

export function fromSummary(rows: readonly SummaryRow[]): { crosses: CrossSummary[]; traits: Record<string, CrossTraits> } {
  const traits: Record<string, CrossTraits> = {};
  const crosses = rows.map((r): CrossSummary => {
    traits[r.address] = { disclosure: r.disclosure, supplyMode: r.supplyMode };
    return {
      address: r.address,
      state: r.state,
      creator: r.creator,
      base_mint: r.baseMint,
      quote_mint: r.quoteMint,
      open_ts: r.openTs,
      close_ts: r.closeTs,
      reveal_end_ts: r.revealEndTs,
      clearing_price: r.clearingPrice,
      matched: r.matched,
      orders_committed: r.orders,
    };
  });
  return { crosses, traits };
}
