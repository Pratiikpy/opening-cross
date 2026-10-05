// Independent verifier for Opening Cross (ROADMAP D5).
//
// Recomputes a cross's clearing from its on-chain book with `referenceClear` — a second,
// independent implementation of ADR-0003 written from the ADR text, not from `clearing-core` —
// re-applies the volume and imbalance print guards, and compares the result with what the
// program recorded. The output is a self-contained fairness proof anyone can re-check offline.
import { type Address, getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';
import {
  CROSS_CORE_PROGRAM_ADDRESS,
  CrossState,
  type Cross,
  getCrossDecoder,
  getLevelsDecoder,
} from '@opening-cross/cross-core-client';
import { type RefOrder, referenceClear } from './reference.js';

export * from './reference.js';

export const PROOF_SCHEMA = 'opening-cross/fairness-proof/v1';

/** Returns raw account data, or null if the account does not exist. */
export type AccountFetcher = (address: Address) => Promise<Uint8Array | null>;

export type BookLevel = { price: string; buy: string; sell: string; buyOrders: number; sellOrders: number };

export type FairnessProof = {
  schema: typeof PROOF_SCHEMA;
  program: Address;
  cross: Address;
  state: 'Live' | 'Cleared' | 'NoPrint' | 'Finalized';
  params: {
    minPrice: string;
    tick: string;
    ticks: number;
    priceScale: string;
    referencePrice: string | null;
    minMatched: string;
    maxImbalanceBps: number | null;
    oracleGuard: boolean;
  };
  book: BookLevel[];
  onchain: { printed: boolean; price: string | null; matched: string | null; rationed: string | null; noPrintReason: number | null };
  recomputed: { printed: boolean; price: string | null; matched: string | null; rationed: string | null; noPrintReason: string | null };
  /** `true` when every recomputed field equals the on-chain record. */
  verified: boolean;
  notes: string[];
};

export async function bookAddressOf(cross: Address): Promise<Address> {
  return (await getProgramDerivedAddress({ programAddress: CROSS_CORE_PROGRAM_ADDRESS, seeds: [new TextEncoder().encode('book'), getAddressEncoder().encode(cross)] }))[0];
}

const STATE_NAMES = ['Live', 'Cleared', 'NoPrint', 'Finalized'] as const;
// Mirrors cross_core::NoPrintReason.
const NO_PRINT = ['NoCross', 'BelowMinimumVolume', 'ImbalanceTooHigh', 'SettlementExpired', 'OracleDivergence', 'OracleUnavailable'] as const;

export async function verifyCross(fetch: AccountFetcher, cross: Address): Promise<FairnessProof> {
  const crossData = await fetch(cross);
  if (!crossData) throw new Error(`cross ${cross} not found`);
  const c: Cross = getCrossDecoder().decode(crossData);
  const bookData = await fetch(await bookAddressOf(cross));
  if (!bookData) throw new Error(`book for ${cross} not found`);
  const book = getLevelsDecoder().decode(bookData);
  const notes: string[] = [];

  const levels: BookLevel[] = [];
  const orders: RefOrder[] = [];
  for (let i = 0; i < c.ticks; i++) {
    const buy = book.buy[i]!;
    const sell = book.sell[i]!;
    if (buy === 0n && sell === 0n) continue;
    const price = c.minPrice + BigInt(i) * c.tick;
    levels.push({ price: price.toString(), buy: buy.toString(), sell: sell.toString(), buyOrders: book.buyOrders[i]!, sellOrders: book.sellOrders[i]! });
    if (buy > 0n) orders.push({ side: 'buy', price, quantity: buy });
    if (sell > 0n) orders.push({ side: 'sell', price, quantity: sell });
  }

  const reference = c.referencePrice.__option === 'Some' ? c.referencePrice.value : null;
  const state = STATE_NAMES[c.state]!;
  const onchainClearing = c.clearing.__option === 'Some' ? c.clearing.value : null;
  const onchain = {
    printed: onchainClearing !== null,
    price: onchainClearing?.price.toString() ?? null,
    matched: onchainClearing?.matched.toString() ?? null,
    rationed: onchainClearing ? ['none', 'buy', 'sell'][onchainClearing.rationed]! : null,
    noPrintReason: c.noPrintReason.__option === 'Some' ? (c.noPrintReason.value as number) : null,
  };

  if (c.state === CrossState.Live) {
    notes.push('The cross has not cleared yet; nothing to verify.');
    return proof(false, { printed: false, price: null, matched: null, rationed: null, noPrintReason: null });
  }

  const r = referenceClear(orders, { min: c.minPrice, tick: c.tick, ticks: c.ticks }, reference);
  let recomputed: FairnessProof['recomputed'];
  if (!r) {
    recomputed = { printed: false, price: null, matched: null, rationed: null, noPrintReason: 'NoCross' };
  } else {
    const imbalance = (() => {
      let d = 0n, s = 0n;
      for (const o of orders) {
        if (o.side === 'buy' && o.price >= r.price) d += o.quantity;
        if (o.side === 'sell' && o.price <= r.price) s += o.quantity;
      }
      return d > s ? d - s : s - d;
    })();
    const maxImb = c.maxImbalanceBps.__option === 'Some' ? BigInt(c.maxImbalanceBps.value) : null;
    let reason: string | null = null;
    if (r.matched < c.minMatched) reason = 'BelowMinimumVolume';
    else if (maxImb !== null && imbalance * 10_000n > maxImb * r.matched) reason = 'ImbalanceTooHigh';
    recomputed = reason
      ? { printed: false, price: null, matched: null, rationed: null, noPrintReason: reason }
      : { printed: true, price: r.price.toString(), matched: r.matched.toString(), rationed: r.rationed ?? 'none', noPrintReason: null };
  }

  let verified: boolean;
  const onchainReason = onchain.noPrintReason === null ? null : NO_PRINT[onchain.noPrintReason]!;
  if (onchainReason === 'OracleDivergence' || onchainReason === 'OracleUnavailable') {
    // The oracle verdict depends on the Pyth update passed at the clear, not on the book.
    notes.push(`No print by the oracle guard (${onchainReason}); the book alone cannot reproduce this verdict. The book's own clearing is ${recomputed.printed ? `P* ${recomputed.price}` : 'no cross'}.`);
    verified = !onchain.printed;
  } else if (onchainReason === 'SettlementExpired') {
    notes.push('Cleared, then abandoned by its settlement adapter after the deadline; every order was refunded.');
    verified = recomputed.printed;
  } else if (onchain.printed) {
    const oracleOk = c.oracle.__option === 'Some';
    if (oracleOk) notes.push('An oracle guard was configured and passed at the clear.');
    verified = recomputed.printed && recomputed.price === onchain.price && recomputed.matched === onchain.matched && recomputed.rationed === onchain.rationed;
  } else {
    verified = !recomputed.printed && recomputed.noPrintReason === onchainReason;
  }
  return proof(verified, recomputed);

  function proof(ok: boolean, rec: FairnessProof['recomputed']): FairnessProof {
    return {
      schema: PROOF_SCHEMA,
      program: CROSS_CORE_PROGRAM_ADDRESS,
      cross,
      state,
      params: {
        minPrice: c.minPrice.toString(),
        tick: c.tick.toString(),
        ticks: c.ticks,
        priceScale: c.priceScale.toString(),
        referencePrice: reference?.toString() ?? null,
        minMatched: c.minMatched.toString(),
        maxImbalanceBps: c.maxImbalanceBps.__option === 'Some' ? c.maxImbalanceBps.value : null,
        oracleGuard: c.oracle.__option === 'Some',
      },
      book: levels,
      onchain: { ...onchain, noPrintReason: onchain.noPrintReason },
      recomputed: rec,
      verified: ok,
      notes,
    };
  }
}
