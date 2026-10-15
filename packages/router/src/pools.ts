// Meteora pools as a venue of the router (ROADMAP Z1, ADR-0921).
//
// Until now the router priced two venues, the next cross and a live Jupiter route, and listed Meteora pools as excluded. This module prices a
// DAMM v2 pool or a DLMM pair directly, from the pool's own accounts, and merges the result into the ranking the router already produces.
//
// The router package does not read or decode pools. A pool arrives as a `PoolRef`: its two mints, whether it is open, and an engine that answers
// "what do I get for selling this much of token A (or B)". `@opening-cross/adapters` builds that engine from account bytes (`dammEngine`,
// `dlmmEngine` in `health.ts`); here the engine is only called. Keeping the account layouts out of this package keeps its dependencies as they are,
// and lets the same ranking take a pool from any other source.
//
// Everything here is pure: no network, no clock, no signing.
import type { Address } from '@solana/kit';
import type { Intent } from './index.js';

export type PoolVenue = 'meteora-damm-v2' | 'meteora-dlmm';

/** What a pool answers: structurally the `PoolEngine` of `@opening-cross/adapters`. `aToB` means selling token A for token B. */
export type PoolEngineLike = {
  swap(aToB: boolean, amountIn: bigint): { consumed: bigint; out: bigint; fee: bigint; partial: boolean };
  /** The largest sell of one token that stays within `maxSlippageBps` of the mid price. */
  depth(aToB: boolean, maxSlippageBps: bigint): { maxIn: bigint; out: bigint };
  /** Price of one atom of token A in atoms of token B, Q64.64. */
  midQ64: bigint;
  reserveA: bigint;
  reserveB: bigint;
};

export type PoolRef = {
  venue: PoolVenue;
  pool: Address;
  tokenA: Address;
  tokenB: Address;
  /** False when the pool cannot be swapped in now; `reason` says why and is shown as is. */
  open: boolean;
  reason: string | null;
  engine: PoolEngineLike;
};

/** How a wallet executes a quote: sell `amountIn` of one pool token, expecting at least `expectedOut` of the other (before slippage tolerance). */
export type PoolRoute = { pool: Address; aToB: boolean; inputMint: Address; outputMint: Address; amountIn: bigint; expectedOut: bigint };

export type PoolVenueQuote =
  | { venue: PoolVenue; pool: Address; available: false; reason: string }
  | {
      venue: PoolVenue;
      pool: Address;
      available: true;
      side: 'buy' | 'sell';
      /** Quote atoms paid (buy) or received (sell). */
      quote: bigint;
      /** Base atoms received (buy) or sold (sell). */
      base: bigint;
      /** Quote atoms per one whole base token, rounded against the trader as the cross rounds. */
      pricePerBase: bigint;
      /** The pool's own mid price in the same unit. */
      midPricePerBase: bigint;
      /** How much less than the mid price would have given this trade gets, fee included, in basis points rounded up (the definition of `engineSlippageBps`); zero when it gets no less. */
      slippageBps: bigint;
      /** Pool fee in the token it was taken in (see `engine.swap`). */
      fee: bigint;
      /** True when the pool could not supply the whole amount asked for. */
      partial: boolean;
      executableNow: true;
      route: PoolRoute;
    };

const Q64 = 1n << 64n;
const U64_MAX = (1n << 64n) - 1n;
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

function orientation(ref: PoolRef, base: Address, quote: Address): { baseIsA: boolean } | string {
  if (ref.tokenA === base && ref.tokenB === quote) return { baseIsA: true };
  if (ref.tokenB === base && ref.tokenA === quote) return { baseIsA: false };
  return 'the pool does not trade this pair';
}

/** Smallest input in [1, U64_MAX] for which `ok` holds, given `ok` is monotone (false, then true) and false at zero; null if even U64_MAX fails. `guess` only sets where the search starts. */
function smallestInput(ok: (amountIn: bigint) => boolean, guess: bigint): bigint | null {
  let lo = 0n;
  let hi = guess < 1n ? 1n : guess > U64_MAX ? U64_MAX : guess;
  while (!ok(hi)) {
    if (hi >= U64_MAX) return null;
    lo = hi;
    hi = hi * 2n > U64_MAX ? U64_MAX : hi * 2n;
  }
  while (hi - lo > 1n) {
    const m = (lo + hi) / 2n;
    if (ok(m)) hi = m;
    else lo = m;
  }
  return hi;
}

/**
 * When a pool cannot supply the whole amount, the partial quote is the most it gives within this much of its mid price, in basis points. A
 * constant-product pool never runs out of tokens, it only asks an ever higher price for them, so "all it can give" needs a bound to mean
 * anything; 10% is the bound, and the quote says it is partial.
 */
export const PARTIAL_FILL_SLIPPAGE_BPS = 1_000n;

/**
 * Prices one order against one pool.
 *
 * A sell of `intent.quantity` base atoms is an exact-input swap. A buy of `intent.quantity` base atoms asks for the smallest amount of quote that
 * returns at least that much base, found by search on the pool's own exact-input quote, so the number is what the pool would really do. When the
 * pool cannot supply the whole amount the quote is partial: the most base it can give, and what that costs.
 *
 * `limitPrice` is not used: pools have no limit, the caller compares `pricePerBase` with its own.
 */
export function quotePool(ref: PoolRef, base: Address, quote: Address, baseDecimals: number, intent: Pick<Intent, 'side' | 'quantity'>): PoolVenueQuote {
  const fail = (reason: string): PoolVenueQuote => ({ venue: ref.venue, pool: ref.pool, available: false, reason });
  const o = orientation(ref, base, quote);
  if (typeof o === 'string') return fail(o);
  if (!ref.open) return fail(ref.reason ?? 'the pool is not open for swaps');
  if (intent.quantity <= 0n) return fail('the amount must be at least 1 base atom');
  const e = ref.engine;
  if (e.midQ64 <= 0n) return fail('the pool has no price');
  const unit = 10n ** BigInt(baseDecimals);
  const buy = intent.side === 'buy';
  // Selling base is selling the pool token that is the base: aToB when base is A. Buying base is selling quote.
  const aToB = buy ? !o.baseIsA : o.baseIsA;
  const midPerAtom = o.baseIsA ? e.midQ64 : (Q64 * Q64) / e.midQ64; // quote atoms per base atom, Q64.64
  const midPricePerBase = (midPerAtom * unit) / Q64;
  let amountIn: bigint;
  let out: bigint;
  let fee: bigint;
  let partial = false;
  if (!buy) {
    amountIn = intent.quantity;
    const r = e.swap(aToB, amountIn);
    if (r.partial || r.consumed < amountIn) {
      // Sell as much as the pool takes within the partial-fill bound.
      amountIn = e.depth(aToB, PARTIAL_FILL_SLIPPAGE_BPS).maxIn;
      if (amountIn === 0n) return fail('the pool has no liquidity to buy this token');
      partial = true;
    }
    const f = e.swap(aToB, amountIn);
    out = f.out;
    fee = f.fee;
    if (out === 0n) return fail('the amount is too small for the pool to return anything');
    return finish();
  }
  // Buy: quote in, base out. Guess the cost from the mid price so the search starts close.
  const guess = ceilDiv(intent.quantity * midPerAtom, Q64);
  const enough = (x: bigint) => {
    const s = e.swap(aToB, x);
    return !s.partial && s.consumed >= x && s.out >= intent.quantity;
  };
  const exact = smallestInput(enough, guess);
  if (exact !== null) {
    amountIn = exact;
    const f = e.swap(aToB, amountIn);
    out = f.out;
    fee = f.fee;
    return finish();
  }
  // The pool cannot supply the whole amount: the most it gives within the partial-fill bound.
  amountIn = e.depth(aToB, PARTIAL_FILL_SLIPPAGE_BPS).maxIn;
  if (amountIn === 0n) return fail('the pool has no liquidity to sell this token');
  const f = e.swap(aToB, amountIn);
  out = f.out;
  fee = f.fee;
  partial = true;
  if (out === 0n) return fail('the amount is too small for the pool to return anything');
  return finish();

  function finish(): PoolVenueQuote {
    const baseAtoms = buy ? (partial ? out : intent.quantity) : amountIn;
    const quoteAtoms = buy ? amountIn : out;
    // Rounded against the trader, as the cross rounds: buyers up, sellers down.
    const pricePerBase = buy ? ceilDiv(quoteAtoms * unit, baseAtoms) : (quoteAtoms * unit) / baseAtoms;
    // The shortfall against what the pool's mid price would have given for the same input, as a share of that ideal amount, rounded up. This is the
    // definition `engineSlippageBps` uses for depth, computed here from the same amounts, so a quote and the depth it was found within agree.
    const ideal = aToB ? (amountIn * e.midQ64) / Q64 : (amountIn * Q64) / e.midQ64;
    const slippage = ideal > out ? ceilDiv((ideal - out) * 10_000n, ideal) : 0n;
    const inputMint = aToB ? ref.tokenA : ref.tokenB;
    const outputMint = aToB ? ref.tokenB : ref.tokenA;
    return {
      venue: ref.venue,
      pool: ref.pool,
      available: true,
      side: intent.side,
      quote: quoteAtoms,
      base: baseAtoms,
      pricePerBase,
      midPricePerBase,
      slippageBps: slippage,
      fee,
      partial,
      executableNow: true,
      route: { pool: ref.pool, aToB, inputMint, outputMint, amountIn, expectedOut: out },
    };
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------------------------------------------------

/** A ranked venue row as `GET /v1/router/quote` serialises it: amounts are decimal strings. Only the fields the merge reads are named. */
export type RankedRow = { rank: number; venue: string; baseAtoms: string; pricePerBase: string; fill: 'full' | 'partial'; cross?: string; [k: string]: unknown };
export type ExcludedRow = { venue: string; cross?: string; pool?: string; reason: string };
export type SerializedRanking = {
  venues: RankedRow[];
  excluded: ExcludedRow[];
  best: { venue: string; cross?: string; pool?: string } | null;
  caveats: string[];
  [k: string]: unknown;
};

/** The sentence the ranking carries in place of a Meteora price (kept in `services/api/src/venues.ts`); the merge removes the entry that starts with it. */
export const METEORA_NOT_PRICED_PREFIX = 'The router does not price Meteora pools directly.';

/**
 * Adds priced pools to a ranking and orders it again by the router's own rule: venues that fill the whole amount first; among those the better
 * price for the side; partial fills after, larger first. Ties break on the venue key so the order does not depend on the order of arrival.
 * A pool that cannot be priced is listed under `excluded` with its reason. The old "Meteora is not priced" entry is dropped: it is no longer true.
 */
export function mergePoolsIntoRanking(ranking: SerializedRanking, pools: PoolVenueQuote[], side: 'buy' | 'sell'): SerializedRanking {
  const rows: RankedRow[] = ranking.venues.map((v) => ({ ...v }));
  const excluded: ExcludedRow[] = ranking.excluded.filter((e) => !(e.venue === 'meteora' && e.reason.startsWith(METEORA_NOT_PRICED_PREFIX)));
  for (const p of pools) {
    if (!p.available) {
      excluded.push({ venue: p.venue, pool: p.pool, reason: p.reason });
      continue;
    }
    rows.push({
      rank: 0,
      venue: p.venue,
      pool: p.pool,
      quoteAtoms: p.quote.toString(),
      baseAtoms: p.base.toString(),
      pricePerBase: p.pricePerBase.toString(),
      midPricePerBase: p.midPricePerBase.toString(),
      slippageVsPoolMidBps: p.slippageBps.toString(),
      fill: p.partial ? 'partial' : 'full',
      feeAtoms: p.fee.toString(),
      executableNow: true,
      route: { pool: p.route.pool, aToB: p.route.aToB, inputMint: p.route.inputMint, outputMint: p.route.outputMint, amountIn: p.route.amountIn.toString(), expectedOut: p.route.expectedOut.toString() },
    });
  }
  const key = (v: RankedRow) => (v.venue === 'cross' ? `cross:${v.cross ?? ''}` : v.venue === 'jupiter' ? 'jupiter' : `${v.venue}:${String(v.pool ?? '')}`);
  const price = (v: RankedRow) => BigInt(v.pricePerBase);
  rows.sort((a, b) => {
    if (a.fill !== b.fill) return a.fill === 'full' ? -1 : 1;
    if (a.fill === 'partial') {
      const ba = BigInt(a.baseAtoms);
      const bb = BigInt(b.baseAtoms);
      if (ba !== bb) return ba > bb ? -1 : 1;
    }
    const pa = price(a);
    const pb = price(b);
    if (pa !== pb) return side === 'buy' ? (pa < pb ? -1 : 1) : pa > pb ? -1 : 1;
    return key(a) < key(b) ? -1 : 1;
  });
  rows.forEach((r, i) => (r.rank = i + 1));
  const top = rows[0];
  const caveats = [...ranking.caveats];
  if (rows.some((v) => v.venue === 'meteora-damm-v2' || v.venue === 'meteora-dlmm')) {
    const notes = ['A pool quote is executable now and is priced from the pool’s own accounts at the moment of the request, fee included; every trade in the pool moves it, so a wallet should send it with a minimum output.'];
    if (rows.some((v) => v.venue === 'jupiter')) notes.push('A Jupiter route may itself pass through one of the pools listed here; the two prices are for the same liquidity, not additional liquidity.');
    const at = caveats.findIndex((c) => c.startsWith('This is a quote comparison only'));
    caveats.splice(at >= 0 ? at : caveats.length, 0, ...notes);
  }
  return {
    ...ranking,
    venues: rows,
    excluded,
    best: top ? (top.venue === 'cross' ? { venue: 'cross', cross: String(top.cross) } : top.venue === 'jupiter' ? { venue: 'jupiter' } : { venue: top.venue, pool: String(top.pool) }) : null,
    caveats,
  };
}
