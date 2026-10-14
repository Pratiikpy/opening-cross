// V7: a vested lock release is sold through an ordinary escrow cross of the same token (a reopen, a recurring cross): the released tokens are in the
// holder's wallet and a sell order in any open cross of that token takes them out. This finds those crosses; the order itself is placed on the cross
// page, where every rule of the cross (ending period, limits, classes) is checked before the wallet is asked.
export type SaleCross = { address: string; state: 'Live' | 'Cleared' | 'NoPrint' | 'Finalized'; supplyMode: 'escrow' | 'mint' | 'deferred-mint'; baseMint: string; openTs: string; closeTs: string; creator: string };

export type SaleVenue = { address: string; opensAt: number; closesAt: number; phase: 'open' | 'upcoming' };

/** Escrow crosses of `baseMint` that can still take a sell order: open now, or opening later. A cross that mints its token takes no sell orders. */
export function saleVenues(crosses: readonly SaleCross[], baseMint: string, now: number): SaleVenue[] {
  return crosses
    .filter((c) => c.baseMint === baseMint && c.state === 'Live' && c.supplyMode === 'escrow' && Number(c.closeTs) > now)
    .map((c): SaleVenue => ({ address: c.address, opensAt: Number(c.openTs), closesAt: Number(c.closeTs), phase: Number(c.openTs) <= now ? 'open' : 'upcoming' }))
    .sort((a, b) => a.closesAt - b.closesAt);
}

export function saleSentence(v: readonly SaleVenue[]): string {
  if (v.length === 0) return 'No cross of this token is taking orders or about to. A reopen is an ordinary cross: its issuer opens one, or a recurring series spawns it on its schedule.';
  const open = v.filter((x) => x.phase === 'open').length;
  return `${open > 0 ? `${open} cross${open === 1 ? ' is' : 'es are'} taking orders now` : 'No cross is taking orders yet'}${v.length > open ? `${open > 0 ? ' and' : ','} ${v.length - open} more ${v.length - open === 1 ? 'opens' : 'open'} later` : ''}. Place a sell order in one to sell the tokens you have released.`;
}
