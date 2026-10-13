// What a person's order is doing, in words, and what they can do about it. Pure: the caller supplies the clock.
import type { CrossDetail, OwnerOrder } from './types';

export type OrderState = { status: string; next: string | null };

export function describeOrder(o: Pick<OwnerOrder, 'status' | 'sealed'>, c: Pick<CrossDetail, 'state' | 'window'>, now: bigint): OrderState {
  if (o.status === 'cancelled') return { status: 'Cancelled', next: null };
  if (o.status === 'claimed') return { status: 'Settled', next: null };
  if (c.state === 'NoPrint') return { status: 'The cross did not print', next: 'Claim your full refund in the claim center above, or on the cross page.' };
  if (c.state === 'Cleared' || c.state === 'Finalized') return { status: 'Cleared', next: 'Claim your fill and refund in the claim center above, or on the cross page.' };
  if (now < BigInt(c.window.closeTs)) {
    return { status: o.sealed && o.status === 'committed' ? 'Sealed, cross open' : 'In the book, cross open', next: 'You can cancel until the call closes.' };
  }
  if (o.sealed && o.status === 'committed' && now < BigInt(c.window.revealEndTs)) {
    return { status: 'Closed, waiting for your reveal', next: 'Reveal your bid on the cross page before the reveal window ends.' };
  }
  return { status: 'Closed, waiting for settlement', next: 'Anyone can settle the cross; your result appears here afterwards.' };
}
