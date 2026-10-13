// The four stages of a cross and a worked example of its price, both computed from what the API serves and
// nothing else. Pure: the caller supplies the clock.
import type { BookResponse, CrossDetail } from '../../lib/types';
import { type Market, buyerPays, formatAtoms, formatPrice } from '../../lib/units';
import { clearBook } from './clearing';
import { explainNoPrint } from './no-print';
import type { OrderRecord } from './order-record';

export type Phase = 'upcoming' | 'open' | 'reveal' | 'awaiting-settlement' | 'settled';
export type StageKey = 'open' | 'close' | 'cleared' | 'finalized';
export type Stage = {
  key: StageKey;
  label: string;
  /** Unix seconds from the cross's window, or null when the API does not serve a time for this stage. */
  ts: bigint | null;
  status: 'done' | 'current' | 'upcoming';
  /** "Now" for the stage the cross is in, "Next" for the one an unopened cross waits on. */
  tag: 'Now' | 'Next' | null;
  note: string;
};

const isClearedOrLater = (c: Pick<CrossDetail, 'state'>) => c.state !== 'Live';

/** Which stage (0-3) the cross is in, by its state and clock. */
export function currentStage(c: Pick<CrossDetail, 'state' | 'disclosure'>, phase: Phase): number {
  if (c.state === 'Finalized') return 3;
  if (c.state === 'Cleared' || c.state === 'NoPrint') return 3;
  switch (phase) {
    case 'upcoming':
    case 'open':
      return 0;
    case 'reveal':
      return 1;
    default:
      return 2;
  }
}

export function stagesOf(c: CrossDetail, phase: Phase): Stage[] {
  const cur = currentStage(c, phase);
  const sealed = c.disclosure === 'sealed';
  const revealEnd = BigInt(c.window.revealEndTs);
  const finished = c.state === 'Finalized';
  const noPrint = isClearedOrLater(c) && !c.clearing;
  const status = (i: number): Stage['status'] => (i < cur || (i === cur && finished) ? 'done' : i === cur ? 'current' : 'upcoming');
  const tag = (i: number): Stage['tag'] => (i !== cur || finished ? null : phase === 'upcoming' ? 'Next' : 'Now');
  return [
    {
      key: 'open',
      label: 'Orders open',
      ts: BigInt(c.window.openTs),
      status: status(0),
      tag: tag(0),
      note: 'Anyone eligible can place or cancel an order. Nothing trades yet.',
    },
    {
      key: 'close',
      label: 'Call closes',
      ts: BigInt(c.window.closeTs),
      status: status(1),
      tag: tag(1),
      note: sealed ? `Orders stop. Sealed bids are revealed until ${utc(revealEnd)}; a bid not revealed in time does not trade.` : 'Orders stop. The book is final.',
    },
    {
      key: 'cleared',
      label: 'Cleared',
      ts: null,
      status: status(2),
      tag: tag(2),
      note:
        c.state === 'Live'
          ? 'Anyone can settle the cross. Settling finds the one price.'
          : c.clearing
            ? 'The one price was found on chain and recorded.'
            : `Settled with no print: ${explainNoPrint(c.noPrintReason)}. Nothing traded.`,
    },
    {
      key: 'finalized',
      label: noPrint ? 'Finalized / refunded' : 'Finalized / paid',
      ts: null,
      status: status(3),
      tag: tag(3),
      note: finished
        ? noPrint
          ? 'Every order was refunded in full.'
          : 'Fills, refunds and seller proceeds are settled.'
        : isClearedOrLater(c)
          ? noPrint
            ? 'Orders can claim their full refund.'
            : 'Orders can claim their fill and refund.'
          : 'Each order claims its fill and refund.',
    },
  ];
}

function utc(ts: bigint): string {
  return new Date(Number(ts) * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}
export { utc as formatUtc };

export type WorkedExample = {
  /** `result` is a real, recorded outcome; `projection` is what the book would do if the call closed now. */
  kind: 'result' | 'projection' | 'no-print' | 'none';
  text: string;
};

type LevelView = BookResponse['levels'][number];

const sumBuys = (levels: LevelView[], from: (l: LevelView) => boolean) => levels.reduce((s, l) => (from(l) ? s + BigInt(l.buy) : s), 0n);

/**
 * "A bid at X filled Y at P*", worked out from the cross's real clearing (or, while it is live, from the
 * indicative one). `orders` is the indexer's record; when exactly one recorded order matches the bid it
 * describes, its recorded fill and refund are used instead of the computed ones.
 */
export function workedExample(c: CrossDetail, book: BookResponse | null, m: Market, orders: readonly OrderRecord[] | null = null): WorkedExample {
  const none = (text: string): WorkedExample => ({ kind: 'none', text });
  if (c.state !== 'Live' && !c.clearing) {
    return {
      kind: 'no-print',
      text: `This cross did not print: ${explainNoPrint(c.noPrintReason)}. Nothing traded, so there is no price; every order is refunded in full.`,
    };
  }
  if (!book) return none('Loading the book…');
  if (c.disclosure === 'sealed' && c.state === 'Live') return none('Bids are sealed, so there is no example until they are revealed and the cross is settled.');

  const live = c.state === 'Live';
  const clearing = c.clearing ? { price: BigInt(c.clearing.price), matched: BigInt(c.clearing.matched), rationed: c.clearing.rationed === 'none' ? null : c.clearing.rationed } : null;
  const indicative = book.indicative ? { price: BigInt(book.indicative.price), matched: BigInt(book.indicative.matched) } : null;
  const at = clearing ?? indicative;
  if (!at) return none('There are no crossing orders yet, so there is no price to work an example from.');
  const px = formatPrice(at.price, m);
  const levels = [...book.levels];
  const unit = 10n ** BigInt(m.baseDecimals);
  const qty = (v: bigint) => `${formatAtoms(v, m.baseDecimals)} token${v === unit ? '' : 's'}`;
  const quote = (v: bigint) => formatAtoms(v, m.quoteDecimals);
  const kind = live ? 'projection' : 'result';

  // The best-priced bid that beat the one price: it shows what everyone who trades gets.
  const above = levels.filter((l) => BigInt(l.buy) > 0n && BigInt(l.price) > at.price).sort((a, b) => (BigInt(b.price) > BigInt(a.price) ? 1 : -1))[0];
  if (above) {
    const limit = BigInt(above.price);
    const q = BigInt(above.buy);
    const reserved = buyerPays(q, limit, BigInt(c.grid.priceScale));
    // One bid at this price: the indexer's record of it can confirm the numbers.
    const recorded = above.buyOrders === 1 && orders ? orders.filter((o) => o.side === 'buy' && o.status === 'claimed' && o.fill !== null && BigInt(o.escrow) === reserved) : [];
    const one = recorded.length === 1 ? recorded[0]! : null;
    const filled = one ? BigInt(one.fill!) : q;
    const paid = one && one.quote_out !== null ? reserved - BigInt(one.quote_out) : buyerPays(filled, at.price, BigInt(c.grid.priceScale));
    const who = above.buyOrders === 1 ? `A bid for ${qty(q)} with a limit of ${formatPrice(limit, m)}` : `The ${above.buyOrders} bids at a limit of ${formatPrice(limit, m)} (${qty(q)} in all)`;
    const verb = live ? 'would be filled' : above.buyOrders === 1 ? 'was filled' : 'were filled';
    const full = filled === q ? 'in full' : `for ${qty(filled)}`;
    return {
      kind,
      text: `${who} ${verb} ${full} at ${px}. ${above.buyOrders === 1 ? 'It' : 'Together they'} ${live ? 'would pay' : 'paid'} ${quote(paid)} instead of the ${quote(reserved)} put in escrow, so ${quote(reserved - paid)} ${live ? 'would come' : 'came'} back. Every other order that trades gets the same ${px}.`,
    };
  }

  // No bid above the price: the bids at the price itself.
  const atBuy = levels.find((l) => BigInt(l.price) === at.price);
  if (atBuy && BigInt(atBuy.buy) > 0n) {
    const q = BigInt(atBuy.buy);
    const rationedBuy = clearing ? clearing.rationed === 'buy' : indicative ? (clearBook(levels, c.grid)?.rationed ?? null) === 'buy' : false;
    if (rationedBuy) {
      const room = at.matched - sumBuys(levels, (l) => BigInt(l.price) > at.price);
      const pct = room > 0n && q > 0n ? Number((room * 1000n) / q) / 10 : 0;
      return {
        kind,
        text: `Bids at ${px} (${qty(q)} in all) are the last to trade, and more was asked for than is on offer. ${live ? 'They would share' : 'They shared'} the ${qty(room)} left, so each ${live ? 'would be' : 'was'} filled for about ${pct}% of its size, all at ${px}.`,
      };
    }
    return { kind, text: `Bids at ${px} (${qty(q)} in all) ${live ? 'would be' : 'were'} filled in full at ${px}, their own limit, with nothing to refund.` };
  }
  return none(`${qty(at.matched)} ${live ? 'would trade' : 'traded'} at ${px}.`);
}
