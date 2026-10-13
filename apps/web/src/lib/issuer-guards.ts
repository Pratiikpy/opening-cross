// What the issuer's guards mean, in words, and how three product rules map onto parameters the program already enforces:
//
//  - B5 minimum raise. The program has `min_matched`, a minimum number of tokens that must trade. A raise target in quote tokens is
//    turned into tokens at a price the issuer chooses, and the range of accepted outcomes (nothing below the minimum, at most the
//    supply on offer) is shown before anything is signed.
//  - B13 minimum float. Float is tokens sold over total supply after the cross. Total supply is known when the cross is created
//    (the mint authority passes to the cross, so nothing else can be minted), so "float at least f" is exactly "at least m tokens
//    trade", and `min_matched` enforces it on chain.
//  - B13 maximum fully diluted value. The cross cannot clear above the highest price on its grid, so a value ceiling is a ceiling
//    on the grid's top price, taking the largest supply the cross could leave behind.
//
// Everything is integers. Nothing here chooses a number for the issuer.
import { formatAtoms } from './units';

export type SupplyMode = 'mint' | 'escrow';

/** Tokens (base atoms) that must trade so that the raise at `price` is at least `raiseQuote` quote atoms; rounds up. */
export function minMatchedFromRaise(raiseQuote: bigint, price: bigint, priceScale: bigint): bigint {
  if (price <= 0n || raiseQuote <= 0n) return 0n;
  return (raiseQuote * priceScale + price - 1n) / price;
}

/**
 * Tokens that must trade so the float is at least `floatBps` (basis points of total supply after the cross).
 * Mint mode: total = existing + matched, so matched >= f * existing / (10000 - f). Escrow mode: total = existing.
 * Returns null when no number of tokens can reach the float (floatBps >= 10000 in mint mode).
 */
export function minMatchedForFloat(floatBps: number, existingSupply: bigint, mode: SupplyMode): bigint | null {
  if (!Number.isInteger(floatBps) || floatBps <= 0) return 0n;
  const f = BigInt(floatBps);
  if (mode === 'escrow') return f > 10_000n ? null : (f * existingSupply + 9_999n) / 10_000n;
  if (f >= 10_000n) return null;
  return (f * existingSupply + (10_000n - f) - 1n) / (10_000n - f);
}

/** The largest top-of-grid price (price units) that keeps fully diluted value at or under `fdvCap` quote atoms whatever the cross sells. */
export function maxTopPriceForFdv(fdvCap: bigint, existingSupply: bigint, maxSold: bigint, mode: SupplyMode, priceScale: bigint): bigint | null {
  const total = mode === 'mint' ? existingSupply + maxSold : existingSupply;
  if (total <= 0n || fdvCap <= 0n) return null;
  return (fdvCap * priceScale) / total;
}

/** How many price levels (2 to 256) fit under a top price, or null when even two levels do not. */
export function ticksUnder(minPrice: bigint, tick: bigint, topPrice: bigint): number | null {
  if (tick <= 0n || topPrice < minPrice + tick) return null;
  const n = Number((topPrice - minPrice) / tick) + 1;
  return Math.min(n, 256);
}

/** Fully diluted value at `price` for a total supply, in quote atoms (floor). */
export const fdvAt = (price: bigint, totalSupply: bigint, priceScale: bigint): bigint => (price * totalSupply) / priceScale;

export type Severity = 'ok' | 'info' | 'warn' | 'block';
export type GuardNote = { id: string; severity: Severity; title: string; text: string };

export type GuardContext = {
  supplyMode: SupplyMode;
  baseDecimals: number | null;
  /** Total tokens on offer in mint mode (the schedule), or null when unknown. */
  offered: bigint | null;
  minMatched: bigint | null; // null = the field is not a valid number
  maxImbalanceBps: number | null;
  oracleEnabled: boolean;
};

const tokens = (atoms: bigint, d: number | null) => (d === null ? `${atoms} atoms` : `${formatAtoms(atoms, d)} tokens`);

/** The explanation shown beside each guard, with a warning where the guard as set would defeat the cross. */
export function guardNotes(c: GuardContext): GuardNote[] {
  const out: GuardNote[] = [];

  if (c.minMatched === null) {
    out.push({ id: 'min-volume', severity: 'block', title: 'Minimum volume', text: 'This is not a valid number of tokens.' });
  } else if (c.minMatched === 0n) {
    out.push({ id: 'min-volume', severity: 'warn', title: 'Minimum volume: none', text: 'With no minimum, a cross prints even if a single token trades. A thin sale sets a price from a handful of orders. A minimum makes the cross print only when enough demand shows up; below it nobody is charged, no tokens are created, and every bidder is refunded.' });
  } else if (c.offered !== null && c.minMatched > c.offered) {
    out.push({ id: 'min-volume', severity: 'block', title: 'Minimum volume is above your supply', text: `You offer ${tokens(c.offered, c.baseDecimals)} in total, so a minimum of ${tokens(c.minMatched, c.baseDecimals)} can never be reached. The cross would never print.` });
  } else {
    out.push({ id: 'min-volume', severity: 'ok', title: `Minimum volume: ${tokens(c.minMatched, c.baseDecimals)}`, text: 'If fewer tokens than this would trade, the cross does not print: everyone is refunded in full and nothing is created. This is enforced by the program, not by this page.' });
  }

  if (c.maxImbalanceBps === null) {
    out.push({ id: 'imbalance', severity: 'info', title: 'Maximum imbalance: none', text: 'At the clearing price, the tokens wanted and the tokens offered are rarely equal. The difference is the imbalance. With no limit, a cross prints however lopsided it is, and the side with more is rationed pro rata at the margin.' });
  } else {
    const x = c.maxImbalanceBps / 10_000;
    const hi = (1 + x) * 100;
    const lo = (1 / (1 + x)) * 100;
    const strict = c.maxImbalanceBps < 10_000;
    out.push({
      id: 'imbalance',
      severity: strict ? 'warn' : 'info',
      title: `Maximum imbalance: ${(c.maxImbalanceBps / 100).toFixed(2).replace(/\.00$/, '')}%`,
      text: `The cross prints only if demand at the clearing price is between ${lo.toFixed(0)}% and ${hi.toFixed(0)}% of the supply at it. Unmet demand counts as imbalance: a sale that draws more than ${hi.toFixed(0)}% of its supply does not print, and every bidder is refunded.${strict ? ' A tight limit can stop an oversubscribed sale, which is usually the outcome an issuer wants. Use the simulator to see where yours falls.' : ''}`,
    });
  }

  out.push(
    c.oracleEnabled
      ? { id: 'oracle', severity: 'warn', title: 'Oracle guard: on', text: 'The cross will not print if its price differs from a Pyth price by more than your limit, or if no fresh verified price is supplied. Someone must post a Pyth price update in the same transaction that clears the cross. If nobody does, the cross cannot clear at all and stays open. Check that a keeper you control will do this before you turn it on.' }
      : { id: 'oracle', severity: 'info', title: 'Oracle guard: off', text: 'An oracle guard fits a token that already trades somewhere with a reliable price: the cross then refuses to print far from it. A new token has no reference price, so leave it off.' },
  );
  return out;
}

export type OracleDraft = { enabled: boolean; feedId: string; maxDivergencePct: string; maxStalenessSecs: number };
export type OracleBody = { feedId: string; maxDivergenceBps: number; maxStalenessSecs: number };

/** The create-cross `oracle` object, or the reasons it is not valid. A disabled guard yields `null`. */
export function checkOracle(o: OracleDraft): { ok: true; body: OracleBody | null } | { ok: false; errors: Record<string, string> } {
  if (!o.enabled) return { ok: true, body: null };
  const errors: Record<string, string> = {};
  const feed = o.feedId.trim().toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{64}$/.test(feed)) errors.feedId = 'A Pyth feed id is 64 hexadecimal characters (32 bytes).';
  const pct = Number(o.maxDivergencePct);
  let bps = 0;
  if (o.maxDivergencePct.trim() === '' || !Number.isFinite(pct) || pct <= 0 || pct > 100 || Math.round(pct * 100) !== pct * 100) errors.maxDivergencePct = 'Enter a percentage above 0 and up to 100 with at most two decimals.';
  else bps = Math.round(pct * 100);
  if (!Number.isInteger(o.maxStalenessSecs) || o.maxStalenessSecs < 1 || o.maxStalenessSecs > 86_400) errors.maxStalenessSecs = 'Enter a whole number of seconds from 1 to 86,400.';
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, body: { feedId: feed, maxDivergenceBps: bps, maxStalenessSecs: o.maxStalenessSecs } };
}
