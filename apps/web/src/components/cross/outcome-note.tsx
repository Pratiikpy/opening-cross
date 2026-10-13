'use client';

import { explainOutcome } from '@/lib/holder-rules';
import type { CrossDetail, OwnerOrder } from '@/lib/types';
import type { Market } from '@/lib/units';

/** What a settled order did, in words: filled, partly filled, or refunded in full, and what the data supports saying about why. */
export function OutcomeNote({ o, clearing, market, maxMatched }: { o: { side: OwnerOrder['side']; escrow: string; fill?: string | null; quote_out?: string | null; base_out?: string | null }; clearing: CrossDetail['clearing']; market: Market; maxMatched?: string | null }) {
  const out = explainOutcome(
    {
      side: o.side,
      escrow: BigInt(o.escrow),
      fill: BigInt(o.fill ?? '0'),
      quoteOut: BigInt(o.quote_out ?? '0'),
      baseOut: BigInt(o.base_out ?? '0'),
      crossPrinted: clearing !== null,
      ...(maxMatched ? { maxMatched: BigInt(maxMatched) } : {}),
      ...(clearing ? { matched: BigInt(clearing.matched), rationed: clearing.rationed } : {}),
    },
    market,
  );
  return (
    <div className="mt-2 rounded-lg bg-surface p-3 text-xs" data-testid="outcome">
      <p className="font-medium">{out.headline}</p>
      {out.lines.map((l) => (
        <p key={l} className="mt-1 text-muted">
          {l}
        </p>
      ))}
    </div>
  );
}
