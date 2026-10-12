// What a person's order is and does, in numbers and in words. Pure: the caller supplies the clock, and every amount is a
// bigint. This is the one place the ticket, the CLI and the docs get the grid rule, the escrow, the fee and the
// "what if the cross fails" story from, so they cannot disagree.
import type { CrossDetail, OwnerOrder, Side } from './types.js';
import { type Market, buyerPays, feeOf, formatAtoms, formatPrice, parseAtoms, parsePrice, sellerReceives } from './units.js';

export type Phase = 'upcoming' | 'open' | 'reveal' | 'awaiting-settlement' | 'settled';

export function phaseOf(c: Pick<CrossDetail, 'state' | 'window' | 'disclosure'>, now: bigint): Phase {
  if (c.state !== 'Live') return 'settled';
  if (now < BigInt(c.window.openTs)) return 'upcoming';
  if (now < BigInt(c.window.closeTs)) return 'open';
  if (c.disclosure === 'sealed' && now < BigInt(c.window.revealEndTs)) return 'reveal';
  return 'awaiting-settlement';
}

export function marketOf(c: Pick<CrossDetail, 'grid' | 'decimals'>): Market {
  return { priceScale: BigInt(c.grid.priceScale), baseDecimals: c.decimals.base, quoteDecimals: c.decimals.quote };
}

/** Checks a typed per-token price against the cross's grid; returns the on-chain price or a sentence saying what to enter. */
export function priceOnGrid(text: string, c: Pick<CrossDetail, 'grid'>, m: Market): bigint | string {
  const p = parsePrice(text, m);
  const min = BigInt(c.grid.minPrice);
  const tick = BigInt(c.grid.tick);
  const max = min + BigInt(c.grid.ticks - 1) * tick;
  const range = `between ${formatPrice(min, m)} and ${formatPrice(max, m)}, in steps of ${formatPrice(tick, m)}`;
  if (p === null) return `Enter a price ${range}.`;
  if (p < min || p > max) return `The price must be ${range}.`;
  if ((p - min) % tick !== 0n) {
    const below = min + ((p - min) / tick) * tick;
    return `Prices move in steps of ${formatPrice(tick, m)}. Try ${formatPrice(below, m)} or ${formatPrice(below + tick, m)}.`;
  }
  return p;
}

/** Checks a typed token amount; returns atoms or a sentence. */
export function quantityOf(text: string, m: Market): bigint | string {
  const q = parseAtoms(text, m.baseDecimals);
  if (q === null || q === 0n) return `Enter an amount of tokens, up to ${m.baseDecimals} decimal places.`;
  if (q > 0xffff_ffff_ffff_ffffn) return 'That amount is larger than a token account can hold.';
  return q;
}

export type OrderInput = { side: Side; priceText: string; quantityText: string };

export type OrderValidation =
  | { ok: true; price: bigint; quantity: bigint }
  | { ok: false; priceError: string | null; quantityError: string | null };

/** Validates what was typed. Empty fields are not errors yet: they are simply not ready (`ok: false` with both messages null). */
export function validateOrderInput(c: Pick<CrossDetail, 'grid'>, m: Market, input: OrderInput): OrderValidation {
  const price = input.priceText.trim() ? priceOnGrid(input.priceText, c, m) : null;
  const quantity = input.quantityText.trim() ? quantityOf(input.quantityText, m) : null;
  if (typeof price === 'bigint' && typeof quantity === 'bigint') return { ok: true, price, quantity };
  return { ok: false, priceError: typeof price === 'string' ? price : null, quantityError: typeof quantity === 'string' ? quantity : null };
}

export type OrderPreview = {
  side: Side;
  price: bigint;
  quantity: bigint;
  /** Held in the cross's vault when the order is placed: quote atoms for a buy, base atoms for a sell. */
  escrow: bigint;
  escrowAsset: 'quote' | 'base';
  /** Buys: the most that can leave the wallet for this order (the escrow). Null for sells. */
  maxPay: bigint | null;
  /** Sells: the least the seller receives if the whole order fills at its own limit, before and after fees. Null for buys. */
  minReceiveGross: bigint | null;
  minReceiveNet: bigint | null;
  /** Buyers pay no fee; sellers pay this share of their proceeds. */
  feeBps: number;
  sealed: boolean;
  requiresPass: boolean;
  /** The sentences a ticket shows, in order: what you pay, the most you can pay, fees, what if the cross fails, how to get your money back. */
  lines: { label: string; text: string }[];
};

/** Everything a person must know before signing, per ENGINEERING_PRINCIPLES 4.4. */
export function previewOrder(c: CrossDetail, m: Market, side: Side, price: bigint, quantity: bigint): OrderPreview {
  const sealed = c.disclosure === 'sealed';
  const feeBps = c.fees.protocolBps + c.fees.integratorBps;
  const escrow = side === 'buy' ? buyerPays(quantity, price, m.priceScale) : quantity;
  const gross = sellerReceives(quantity, price, m.priceScale);
  const net = gross - feeOf(gross, feeBps);
  const quote = (a: bigint) => formatAtoms(a, m.quoteDecimals);
  const base = (a: bigint) => formatAtoms(a, m.baseDecimals);
  const lines: { label: string; text: string }[] = [];
  if (side === 'buy') {
    lines.push({ label: 'Held in escrow', text: `${quote(escrow)} of the quote token leaves your wallet now and stays in the cross's vault.` });
    lines.push({ label: 'Most you can pay', text: `${quote(escrow)}. Everyone who is filled pays the same clearing price, which is never above your limit of ${formatPrice(price, m)}; what you do not spend comes back to you.` });
    lines.push({ label: 'Fees', text: 'None for buyers. Fees are taken from sellers’ proceeds only.' });
  } else {
    lines.push({ label: 'Held in escrow', text: `${base(escrow)} tokens leave your wallet now and stay in the cross's vault.` });
    lines.push({ label: 'Least you receive', text: `At least ${quote(net)} if all of it fills at your limit of ${formatPrice(price, m)} (${quote(gross)} less the fee). The clearing price can only be higher; unfilled tokens come back.` });
    lines.push({ label: 'Fees', text: feeBps === 0 ? 'None on this cross.' : `${feeBps / 100}% of your proceeds for what is filled (${c.fees.protocolBps / 100}% protocol, ${c.fees.integratorBps / 100}% integrator). Nothing on cancels or refunds.` });
  }
  lines.push({
    label: 'If the cross does not print',
    text: 'If too little crosses or the book is too one-sided, nothing trades: every order is refunded in full with no fee.',
  });
  lines.push({
    label: 'Getting your money back',
    text: sealed
      ? 'You can cancel until the call closes. A bid that is not revealed in time does not trade and is refunded in full. After settlement, claim your fill and refund; anyone may send the claim, the proceeds always go to you.'
      : 'You can cancel until the call closes. After settlement, claim your fill and refund; anyone may send the claim, the proceeds always go to you.',
  });
  if (sealed) lines.push({ label: 'Sealed', text: 'Your price and amount stay hidden until you reveal them after the close. Keep the backup: without it the bid cannot be revealed.' });
  return {
    side,
    price,
    quantity,
    escrow,
    escrowAsset: side === 'buy' ? 'quote' : 'base',
    maxPay: side === 'buy' ? escrow : null,
    minReceiveGross: side === 'sell' ? gross : null,
    minReceiveNet: side === 'sell' ? net : null,
    feeBps,
    sealed,
    requiresPass: c.gateMint !== null,
    lines,
  };
}

export type OrderState = { status: string; next: string | null };

/** What an order is doing, in words, and what its owner can do about it. */
export function describeOrder(o: Pick<OwnerOrder, 'status' | 'sealed'>, c: Pick<CrossDetail, 'state' | 'window'>, now: bigint): OrderState {
  if (o.status === 'cancelled') return { status: 'Cancelled', next: null };
  if (o.status === 'claimed') return { status: 'Settled', next: null };
  if (c.state === 'NoPrint') return { status: 'The cross did not print', next: 'Claim your full refund.' };
  if (c.state === 'Cleared' || c.state === 'Finalized') return { status: 'Cleared', next: 'Claim your fill and refund.' };
  if (now < BigInt(c.window.closeTs)) {
    return { status: o.sealed && o.status === 'committed' ? 'Sealed, cross open' : 'In the book, cross open', next: 'You can cancel until the call closes.' };
  }
  if (o.sealed && o.status === 'committed' && now < BigInt(c.window.revealEndTs)) {
    return { status: 'Closed, waiting for your reveal', next: 'Reveal your bid before the reveal window ends.' };
  }
  return { status: 'Closed, waiting for settlement', next: 'Anyone can settle the cross; your result appears here afterwards.' };
}
