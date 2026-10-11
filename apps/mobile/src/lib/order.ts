// Turning what a person typed into a place-order request, with every check the web order ticket makes.
import type { CrossDetail } from './types';
import { type Market, buyerPays, formatAtoms, formatPrice, parseAtoms, parsePrice } from './units';

export type Side = 'buy' | 'sell';

export const marketOf = (c: CrossDetail): Market => ({ priceScale: BigInt(c.grid.priceScale), baseDecimals: c.decimals.base, quoteDecimals: c.decimals.quote });

/** Checks a typed price against the cross grid; returns the on-chain price or a message. */
export function onGrid(text: string, c: CrossDetail, m: Market): bigint | string {
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

export type Draft = { side: Side; priceText: string; qtyText: string };

export type Checked =
  | { ok: false; priceError: string | null; qtyError: string | null }
  | { ok: true; price: bigint; quantity: bigint; escrow: bigint; escrowText: string };

export function check(d: Draft, c: CrossDetail): Checked {
  const m = marketOf(c);
  const price = d.priceText ? onGrid(d.priceText, c, m) : null;
  const qty = d.qtyText ? parseAtoms(d.qtyText, m.baseDecimals) : null;
  const priceError = typeof price === 'string' ? price : null;
  const qtyError = d.qtyText && (qty === null || qty === 0n) ? `Enter an amount of tokens, up to ${m.baseDecimals} decimal places.` : null;
  if (typeof price !== 'bigint' || qty === null || qty === 0n) return { ok: false, priceError, qtyError };
  const escrow = d.side === 'buy' ? buyerPays(qty, price, m.priceScale) : qty;
  return { ok: true, price, quantity: qty, escrow, escrowText: formatAtoms(escrow, d.side === 'buy' ? m.quoteDecimals : m.baseDecimals) };
}

/** The body POSTed to /v1/tx/place-order. Integers go as decimal strings, as the API requires. */
export function placeOrderBody(c: CrossDetail, owner: string, d: Draft & { price: bigint; quantity: bigint }, nonce: string, salt?: string) {
  return { cross: c.address, owner, side: d.side, price: String(d.price), quantity: String(d.quantity), nonce, ...(salt ? { salt } : {}) };
}

/** Which actions a cross offers now, from its state and clock. */
export type Phase = 'upcoming' | 'open' | 'reveal' | 'awaiting-settlement' | 'settled';

export function phaseOf(c: CrossDetail, now: bigint): Phase {
  if (c.state !== 'Live') return 'settled';
  if (now < BigInt(c.window.openTs)) return 'upcoming';
  if (now < BigInt(c.window.closeTs)) return 'open';
  if (c.disclosure === 'sealed' && now < BigInt(c.window.revealEndTs)) return 'reveal';
  return 'awaiting-settlement';
}
