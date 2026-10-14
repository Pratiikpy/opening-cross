// Pushed refunds (B5): which orders of a settled cross are certain to be refund-only, so that anyone can send them back to their owners in
// batches of twelve. Pure. The program refuses any order that has a fill (`NotRefundOnly`) and pays only to the owner's own token account, so a
// mistake here can only make a transaction fail, never move money to the wrong place. An order that is refund-only for a reason the book does
// not show (it lost a lottery or fell outside the counted ending window) is left out: its owner, or a keeper, refunds it through `claim`.
import type { OrderRecord } from '@/components/cross/order-record';

export const PUSH_MAX = 12;

type CrossFacts = { state: 'Live' | 'Cleared' | 'NoPrint' | 'Finalized'; clearing: { price: string } | null };

/** True when the order, still open on chain, cannot have a fill: the cross did not print, or its limit was strictly outside the clearing price, or it was sealed and never revealed. */
export function refundOnly(cross: CrossFacts, o: Pick<OrderRecord, 'side' | 'price' | 'status' | 'fill'>): boolean {
  if (o.status === 'claimed' || o.status === 'cancelled') return false;
  if (o.fill !== null && BigInt(o.fill) > 0n) return false;
  if (cross.state === 'NoPrint') return true;
  if (cross.state === 'Live' || !cross.clearing) return false;
  if (o.price === null) return true;
  const price = BigInt(o.price);
  const clearing = BigInt(cross.clearing.price);
  return o.side === 'buy' ? price < clearing : price > clearing;
}

export function refundCandidates(cross: CrossFacts, orders: readonly OrderRecord[] | null): OrderRecord[] {
  return orders ? orders.filter((o) => refundOnly(cross, o)) : [];
}

/** The next batch to send and how many remain after it. */
export function nextBatch<T>(list: readonly T[]): { batch: T[]; after: number } {
  const batch = list.slice(0, PUSH_MAX);
  return { batch, after: list.length - batch.length };
}

export function refundSentence(count: number): string {
  if (count === 0) return 'Every order of this cross whose refund can be read from the book has been paid out.';
  const sends = Math.ceil(count / PUSH_MAX);
  return `${count} order${count === 1 ? ' is' : 's are'} refund-only and still waiting. Anyone can send ${count === 1 ? 'it' : 'them'} back: ${sends} transaction${sends === 1 ? '' : 's'} of up to ${PUSH_MAX} orders.`;
}
