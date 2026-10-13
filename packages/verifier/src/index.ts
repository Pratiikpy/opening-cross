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
  type CrossExt,
  getClassBookDecoder,
  getCrossDecoder,
  getCrossExtDecoder,
  getLevelsDecoder,
} from '@opening-cross/cross-core-client';
import { type RefOrder, referenceClear } from './reference.js';
import { type Order2, type Rules2, referenceClearCapped, referenceGuards2, referenceInsiderBound } from './reference2.js';

export * from './reference.js';
export * from './reference2.js';
export * from './conformance.js';
export * from './conformance2.js';

export const PROOF_SCHEMA = 'opening-cross/fairness-proof/v1';
/** Proofs for crosses that carry rules (ADR-0100) add the rules, the draw and the allocation figures. */
export const PROOF_SCHEMA_V2 = 'opening-cross/fairness-proof/v2';

const decoderSize = (d: { fixedSize?: number; maxSize?: number }) => d.fixedSize ?? d.maxSize ?? 0;
const CROSS_BODY = decoderSize(getCrossDecoder() as never);

/** The extension tail of a cross account, or null when the cross has no rules. */
export function readExt(account: Uint8Array): CrossExt | null {
  if (account.length < CROSS_BODY + 2 || account[CROSS_BODY] !== 1) return null;
  const ext = getCrossExtDecoder().decode(account.subarray(CROSS_BODY));
  return ext.rulesSet ? ext : null;
}

export async function classBookAddressOf(cross: Address): Promise<Address> {
  return (await getProgramDerivedAddress({ programAddress: CROSS_CORE_PROGRAM_ADDRESS, seeds: [new TextEncoder().encode('classes'), getAddressEncoder().encode(cross)] }))[0];
}

/** Returns raw account data, or null if the account does not exist. */
export type AccountFetcher = (address: Address) => Promise<Uint8Array | null>;

export type BookLevel = { price: string; buy: string; sell: string; buyOrders: number; sellOrders: number };

export type FairnessProof = {
  schema: typeof PROOF_SCHEMA | typeof PROOF_SCHEMA_V2;
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
  /** Present on schema v2: what the cross's rules were and what they decided. */
  rules?: {
    supplyCap: string | null;
    minRaiseQuote: string;
    totalSupply: string;
    minFloatBps: number;
    maxFdvX100: number;
    anchorPrice: string;
    moveBps: number;
    reserveBps: number[];
    lotteryUnit: string;
    insiders: number;
    draw: { epoch: number; seed: string | null; endBucket: number | null };
    allocation: { classQty: string[]; tickets: number; rho: number; insiderUpperBound: string; counted: string } | null;
  };
};

export async function bookAddressOf(cross: Address): Promise<Address> {
  return (await getProgramDerivedAddress({ programAddress: CROSS_CORE_PROGRAM_ADDRESS, seeds: [new TextEncoder().encode('book'), getAddressEncoder().encode(cross)] }))[0];
}

const STATE_NAMES = ['Live', 'Cleared', 'NoPrint', 'Finalized'] as const;
// Mirrors cross_core::NoPrintReason.
const NO_PRINT = ['NoCross', 'BelowMinimumVolume', 'ImbalanceTooHigh', 'SettlementExpired', 'OracleDivergence', 'OracleUnavailable', 'BelowMinimumRaise', 'FloatTooLow', 'FdvTooHigh', 'PriceMoved', 'Halted', 'CorporateAction', 'IssuerPaused', 'OracleDisagreement'] as const;

export async function verifyCross(fetch: AccountFetcher, cross: Address): Promise<FairnessProof> {
  const crossData = await fetch(cross);
  if (!crossData) throw new Error(`cross ${cross} not found`);
  const c: Cross = getCrossDecoder().decode(crossData);
  const ext = readExt(crossData);
  let rulesBlock: FairnessProof['rules'] = ext ? rulesBlockOf(ext, null) : undefined;
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
    notes.push(ext?.draw.extPending ? 'The first clear failed its guards and the cross is waiting for its one extension.' : 'The cross has not cleared yet; nothing to verify.');
    return proof(false, { printed: false, price: null, matched: null, rationed: null, noPrintReason: null });
  }

  const grid = { min: c.minPrice, tick: c.tick, ticks: c.ticks };
  const cap = ext && ext.guards.maxMatched > 0n ? ext.guards.maxMatched : null;
  const r = ext ? referenceClearCapped(orders, grid, reference, cap) : referenceClear(orders, grid, reference);
  let recomputed: FairnessProof['recomputed'];
  if (!r) {
    recomputed = { printed: false, price: null, matched: null, rationed: null, noPrintReason: 'NoCross' };
  } else {
    let counted = r.matched;
    let allocation: NonNullable<FairnessProof['rules']>['allocation'] = null;
    let rules2: Rules2 | null = null;
    if (ext) {
      rules2 = rulesOfExt(ext, c.priceScale);
      if (ext.neutrality.insiderCount > 0 || usesClasses(ext)) {
        const book2 = await fetch(await classBookAddressOf(cross));
        if (!book2) throw new Error(`class book for ${cross} not found`);
        const cb = getClassBookDecoder().decode(book2);
        const synthetic = syntheticOrders(orders, cb, c, r.price);
        const tickets = synthetic.filter((o) => o.side === 'buy' && o.class === 1 && o.price === r.price).length;
        if (ext.alloc.lotteryUnit > 0n && tickets > 0) {
          rules2 = { ...rules2, rho: BigInt(Buffer.from(ext.draw.seed).readBigUInt64LE(16) % BigInt(tickets)) };
        }
        const bound = referenceInsiderBound(synthetic, r as never, rules2);
        counted = r.matched > bound ? r.matched - bound : 0n;
        const classQty = [1, 2, 3].map((k) => synthetic.filter((o) => o.side === 'buy' && o.class === k && o.price === r.price).reduce((a, o) => a + o.quantity, 0n));
        allocation = { classQty: classQty.map(String), tickets, rho: Number(rules2.rho), insiderUpperBound: bound.toString(), counted: counted.toString() };
      }
      rulesBlock = rulesBlockOf(ext, allocation);
    }
    const imbalance = (() => {
      let d = 0n, s = 0n;
      for (const o of orders) {
        if (o.side === 'buy' && o.price >= r.price) d += o.quantity;
        if (o.side === 'sell' && o.price <= r.price) s += o.quantity;
      }
      if (cap !== null && s > cap) s = cap;
      return d > s ? d - s : s - d;
    })();
    const maxImb = c.maxImbalanceBps.__option === 'Some' ? BigInt(c.maxImbalanceBps.value) : null;
    let reason: string | null = null;
    if (ext && rules2 && 'demand' in r) {
      reason = referenceGuards2(r as never, counted, rules2, { minMatched: c.minMatched, maxImbalanceBps: maxImb });
    } else if (r.matched < c.minMatched) reason = 'BelowMinimumVolume';
    else if (maxImb !== null && imbalance * 10_000n > maxImb * r.matched) reason = 'ImbalanceTooHigh';
    recomputed = reason
      ? { printed: false, price: null, matched: null, rationed: null, noPrintReason: reason }
      : { printed: true, price: r.price.toString(), matched: r.matched.toString(), rationed: r.rationed ?? 'none', noPrintReason: null };
  }

  let verified: boolean;
  const onchainReason = onchain.noPrintReason === null ? null : NO_PRINT[onchain.noPrintReason]!;
  if (onchainReason === 'Halted' || onchainReason === 'CorporateAction' || onchainReason === 'IssuerPaused') {
    // These verdicts depend on a halt state or a mint's pause flag at the time of the clear, not on the book.
    notes.push(`No print because of the state of the asset (${onchainReason}); the book alone cannot reproduce this verdict. The book's own clearing is ${recomputed.printed ? `P* ${recomputed.price}` : 'no cross'}.`);
    verified = !onchain.printed;
  } else if (onchainReason === 'OracleDivergence' || onchainReason === 'OracleUnavailable') {
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
      schema: ext ? PROOF_SCHEMA_V2 : PROOF_SCHEMA,
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
      ...(rulesBlock ? { rules: rulesBlock } : {}),
    };
  }
}

const usesClasses = (x: CrossExt) => x.alloc.reserveBps.some((b) => b > 0) || x.alloc.lotteryUnit > 0n;

function rulesOfExt(x: CrossExt, priceScale: bigint): Rules2 {
  return {
    supplyCap: x.guards.maxMatched > 0n ? x.guards.maxMatched : null,
    minRaiseQuote: x.guards.minRaiseQuote,
    priceScale,
    totalSupply: x.guards.totalSupply,
    minFloatBps: BigInt(x.guards.minFloatBps),
    maxFdvX100: BigInt(x.guards.maxFdvX100),
    anchorPrice: x.guards.anchorPrice,
    moveBps: BigInt(x.guards.moveBps),
    reserveBps: [BigInt(x.alloc.reserveBps[0]!), BigInt(x.alloc.reserveBps[1]!), BigInt(x.alloc.reserveBps[2]!)],
    lotteryUnit: x.alloc.lotteryUnit,
    rho: 0n,
  };
}

function rulesBlockOf(x: CrossExt, allocation: NonNullable<FairnessProof['rules']>['allocation']): FairnessProof['rules'] {
  return {
    supplyCap: x.guards.maxMatched > 0n ? x.guards.maxMatched.toString() : null,
    minRaiseQuote: x.guards.minRaiseQuote.toString(),
    totalSupply: x.guards.totalSupply.toString(),
    minFloatBps: x.guards.minFloatBps,
    maxFdvX100: x.guards.maxFdvX100,
    anchorPrice: x.guards.anchorPrice.toString(),
    moveBps: x.guards.moveBps,
    reserveBps: [...x.alloc.reserveBps],
    lotteryUnit: x.alloc.lotteryUnit.toString(),
    insiders: x.neutrality.insiderCount,
    draw: { epoch: x.draw.epoch, seed: x.draw.seedReady ? Buffer.from(x.draw.seed).toString('hex') : null, endBucket: x.draw.endBucket === 255 ? null : x.draw.endBucket },
    allocation,
  };
}

/** The book's buy side split by class and insider, as synthetic orders: the pools and the insider bound depend only on these aggregates. */
function syntheticOrders(orders: RefOrder[], cb: ReturnType<ReturnType<typeof getClassBookDecoder>['decode']>, c: Cross, clearingPrice: bigint): Order2[] {
  const out: Order2[] = orders.filter((o) => o.side === 'sell').map((o) => ({ ...o, class: 0, insider: false }));
  for (let i = 0; i < c.ticks; i++) {
    const price = c.minPrice + BigInt(i) * c.tick;
    const total = orders.find((o) => o.side === 'buy' && o.price === price)?.quantity ?? 0n;
    if (total === 0n) continue;
    const q1 = cb.qty[0]![i]!, q2 = cb.qty[1]![i]!, q3 = cb.qty[2]![i]!, ins = cb.insiderQty[i]!;
    const general = total - q1 - q2 - q3 - ins;
    const push = (quantity: bigint, cls: number, insider = false) => quantity > 0n && out.push({ side: 'buy', price, quantity, class: cls, insider });
    push(general, 0);
    push(ins, 0, true);
    push(q2, 2);
    push(q3, 3);
    // Class 1 enters as one order per lottery ticket at the clearing price; the pools only read the total and the count.
    const tickets = cb.tickets[i]!;
    if (tickets > 0 && price === clearingPrice) {
      for (let t = 0; t < tickets; t++) out.push({ side: 'buy', price, quantity: t === 0 ? q1 : 0n, class: 1, insider: false });
    } else push(q1, 1);
  }
  return out;
}
export * from './rpc.js';
