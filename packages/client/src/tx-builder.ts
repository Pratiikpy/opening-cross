// Two ways to get the unsigned transactions for an action, behind one interface:
//   * the API builder asks `POST /v1/tx/*` (what a web app does; the API reads the chain and compiles the message);
//   * the local builder reads the chain itself and compiles the same instructions with the SDK. A client that signs with
//     a key it holds (a CLI, a bot) should use this one: it never signs bytes an HTTP server composed.
// Both return the same shape and, for the same chain state, the same instructions; the tests compare them.
import {
  type Address,
  type Blockhash,
  type Instruction,
  address as toAddress,
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';
import {
  CrossState,
  CrossKind,
  Disclosure,
  ORDER_DISCRIMINATOR,
  OrderSide,
  SupplyMode,
  type CrossView,
  buildCancel,
  buildClaim,
  buildCreateCross,
  buildFinalizeWithAccounts,
  buildMissingShards,
  buildPlaceOrder,
  buildReveal,
  buildSettleBook,
  getOrderDecoder,
  orderAddress,
  shardAddress,
} from '@opening-cross/sdk';
import { AuthorityType, getSetAuthorityInstruction } from '@solana-program/token-2022';
import type { ApiClient } from './api.js';
import { readCrossFromChain } from './chain.js';
import { ActionError } from './errors.js';
import { bytesOfHex, hexOfBytes } from './sealed.js';
import type { RpcClient } from './rpc.js';
import type { BuiltAction, Side, UnsignedTransaction } from './types.js';

export type PlaceOrderRequest = { cross: string; owner: string; nonce: bigint; side: Side; price: bigint; quantity: bigint; escrow?: bigint; salt?: Uint8Array };
export type CancelRequest = { cross: string; owner: string; nonce: bigint };
export type RevealRequest = { cross: string; owner: string; nonce: bigint; price: bigint; quantity: bigint; salt: Uint8Array };
export type SettleRequest = { cross: string; payer: string; oraclePrice?: string };
export type ClaimRequest = { cross: string; owner: string; nonce: bigint; payer?: string };
export type FinalizeRequest = { cross: string; payer: string };
export type InitShardsRequest = { cross: string; payer: string };

export const CROSS_KINDS = ['launch', 'reopen', 'tender', 'recurring'] as const;
export const SUPPLY_MODES = ['escrow', 'mint', 'deferred-mint'] as const;
export const DISCLOSURES = ['sealed', 'open'] as const;

export type CreateCrossRequest = {
  creator: string;
  /** Omit for a deferred-mint cross (the settlement adapter creates and binds the base mint). */
  baseMint?: string | null;
  quoteMint: string;
  baseTokenProgram: string;
  quoteTokenProgram: string;
  crossId: bigint;
  kind: (typeof CROSS_KINDS)[number];
  supplyMode: (typeof SUPPLY_MODES)[number];
  disclosure: (typeof DISCLOSURES)[number];
  minPrice: bigint;
  tick: bigint;
  ticks: number;
  priceScale: bigint;
  openTs: bigint;
  closeTs: bigint;
  revealEndTs: bigint;
  referencePrice?: bigint | null;
  minMatched?: bigint;
  maxImbalanceBps?: number | null;
  integratorFeeBps?: number;
  integrator: string;
  gateMint?: string | null;
  shards: number;
  maxOrders: number;
  proceedsTo: string;
  schedule?: { price: bigint; quantity: bigint }[];
  oracle?: { feedId: string; maxDivergenceBps: number; maxStalenessSecs: number } | null;
  calendar?: string | null;
  settler?: string | null;
  settleDeadlineTs?: bigint;
};

export interface TxBuilder {
  readonly kind: 'api' | 'local';
  placeOrder(r: PlaceOrderRequest): Promise<BuiltAction>;
  cancel(r: CancelRequest): Promise<BuiltAction>;
  reveal(r: RevealRequest): Promise<BuiltAction>;
  settle(r: SettleRequest): Promise<BuiltAction>;
  claim(r: ClaimRequest): Promise<BuiltAction>;
  finalize(r: FinalizeRequest): Promise<BuiltAction>;
  initShards(r: InitShardsRequest): Promise<BuiltAction>;
  createCross(r: CreateCrossRequest): Promise<BuiltAction>;
}

// ------------------------------------------------------------------ the API builder

export function apiTxBuilder(api: ApiClient): TxBuilder {
  const s = (v: bigint) => v.toString();
  return {
    kind: 'api',
    placeOrder: (r) => api.tx.placeOrder({ cross: r.cross, owner: r.owner, side: r.side, price: s(r.price), quantity: s(r.quantity), nonce: s(r.nonce), ...(r.escrow !== undefined ? { escrow: s(r.escrow) } : {}), ...(r.salt ? { salt: hexOfBytes(r.salt) } : {}) }),
    cancel: (r) => api.tx.cancel({ cross: r.cross, owner: r.owner, nonce: s(r.nonce) }),
    reveal: (r) => api.tx.reveal({ cross: r.cross, owner: r.owner, nonce: s(r.nonce), price: s(r.price), quantity: s(r.quantity), salt: hexOfBytes(r.salt) }),
    settle: (r) => api.tx.settle({ cross: r.cross, payer: r.payer, ...(r.oraclePrice ? { oraclePrice: r.oraclePrice } : {}) }),
    claim: (r) => api.tx.claim({ cross: r.cross, owner: r.owner, nonce: s(r.nonce), ...(r.payer ? { payer: r.payer } : {}) }),
    finalize: (r) => api.tx.finalize({ cross: r.cross, payer: r.payer }),
    initShards: (r) => api.tx.initShards({ cross: r.cross, payer: r.payer }),
    createCross: (r) =>
      api.tx.createCross({
        creator: r.creator,
        ...(r.baseMint ? { baseMint: r.baseMint } : {}),
        quoteMint: r.quoteMint,
        baseTokenProgram: r.baseTokenProgram,
        quoteTokenProgram: r.quoteTokenProgram,
        crossId: s(r.crossId),
        kind: r.kind,
        supplyMode: r.supplyMode,
        disclosure: r.disclosure,
        minPrice: s(r.minPrice),
        tick: s(r.tick),
        ticks: r.ticks,
        priceScale: s(r.priceScale),
        openTs: s(r.openTs),
        closeTs: s(r.closeTs),
        revealEndTs: s(r.revealEndTs),
        ...(r.referencePrice != null ? { referencePrice: s(r.referencePrice) } : {}),
        minMatched: s(r.minMatched ?? 0n),
        ...(r.maxImbalanceBps != null ? { maxImbalanceBps: r.maxImbalanceBps } : {}),
        integratorFeeBps: r.integratorFeeBps ?? 0,
        integrator: r.integrator,
        ...(r.gateMint ? { gateMint: r.gateMint } : {}),
        shards: r.shards,
        maxOrders: r.maxOrders,
        proceedsTo: r.proceedsTo,
        schedule: (r.schedule ?? []).map((l) => ({ price: s(l.price), quantity: s(l.quantity) })),
        ...(r.oracle ? { oracle: r.oracle } : {}),
        ...(r.calendar ? { calendar: r.calendar } : {}),
        ...(r.settler ? { settler: r.settler } : {}),
        settleDeadlineTs: s(r.settleDeadlineTs ?? 0n),
      }),
  };
}

// ------------------------------------------------------------------ the local builder

type Lifetime = { blockhash: string; lastValidBlockHeight: bigint };

/** Compiles instructions into an unsigned version-0 transaction with `feePayer` as the only signer slot. */
export function compileUnsigned(feePayer: Address, ixs: Instruction[], lifetime: Lifetime): UnsignedTransaction {
  const tx = compileTransaction(
    pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(createNoopSigner(feePayer), m),
      (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: lifetime.blockhash as Blockhash, lastValidBlockHeight: lifetime.lastValidBlockHeight }, m),
      (m) => appendTransactionMessageInstructions(ixs, m),
    ),
  );
  return { transaction: getBase64EncodedWireTransaction(tx), signers: Object.keys(tx.signatures) };
}

const toSide = (s: Side): OrderSide => (s === 'buy' ? OrderSide.Buy : OrderSide.Sell);

export function localTxBuilder(rpc: RpcClient): TxBuilder {
  async function view(addr: string): Promise<CrossView> {
    const { address, data } = await readCrossFromChain(rpc, addr);
    return { address, data };
  }
  async function orderData(cross: Address, owner: string, nonce: bigint) {
    const a = await orderAddress(cross, toAddress(owner), nonce);
    const acct = await rpc.getAccount(a);
    const disc = ORDER_DISCRIMINATOR as Uint8Array;
    if (!acct || acct.data.length < 8 || !disc.every((b, i) => acct.data[i] === b)) return { address: a, order: null };
    return { address: a, order: getOrderDecoder().decode(acct.data) };
  }
  const build = async (feePayer: string, groups: Instruction[][], extra: Record<string, unknown> = {}): Promise<BuiltAction> => {
    const lt = await rpc.latestBlockhash();
    return { transactions: groups.map((g) => compileUnsigned(toAddress(feePayer), g, lt)), extra };
  };

  return {
    kind: 'local',

    async placeOrder(r) {
      const cross = await view(r.cross);
      if (cross.data.state !== CrossState.Live) throw new ActionError('cross is not accepting orders', 'CONFLICT');
      if (cross.data.disclosure === Disclosure.Sealed && !r.salt) throw new ActionError('sealed cross: provide a 32-byte salt and keep it for the reveal', 'INVALID_INPUT');
      if (r.salt && r.salt.length !== 32) throw new ActionError('salt must be 32 bytes', 'INVALID_INPUT');
      const existing = await orderData(cross.address, r.owner, r.nonce);
      if (existing.order) throw new ActionError(`nonce ${r.nonce} is already used by this owner in this cross`, 'CONFLICT');
      const ix = await buildPlaceOrder({ cross, owner: createNoopSigner(toAddress(r.owner)), nonce: r.nonce, side: toSide(r.side), price: r.price, quantity: r.quantity, ...(r.escrow !== undefined ? { escrow: r.escrow } : {}), ...(r.salt ? { salt: r.salt } : {}) });
      return build(r.owner, [[ix]], { order: existing.address });
    },

    async cancel(r) {
      const cross = await view(r.cross);
      const { order } = await orderData(cross.address, r.owner, r.nonce);
      if (!order) throw new ActionError(`no open order for owner ${r.owner} with nonce ${r.nonce} in cross ${r.cross}`, 'NOT_FOUND');
      return build(r.owner, [[await buildCancel(cross, createNoopSigner(toAddress(r.owner)), r.nonce, order.side, order.state === 1)]]);
    },

    async reveal(r) {
      const cross = await view(r.cross);
      const { order } = await orderData(cross.address, r.owner, r.nonce);
      if (!order) throw new ActionError(`no open order for owner ${r.owner} with nonce ${r.nonce} in cross ${r.cross}`, 'NOT_FOUND');
      return build(r.owner, [[await buildReveal(cross, createNoopSigner(toAddress(r.owner)), r.nonce, r.price, r.quantity, r.salt)]]);
    },

    async settle(r) {
      const cross = await view(r.cross);
      if (cross.data.state !== CrossState.Live) throw new ActionError('cross is already settled', 'CONFLICT');
      const ixs = await buildSettleBook(cross, r.oraclePrice ? { oraclePrice: toAddress(r.oraclePrice) } : {}).catch((e: Error) => {
        throw new ActionError(e.message, 'INVALID_INPUT');
      });
      return build(r.payer, ixs.map((ix) => [ix]));
    },

    async claim(r) {
      const cross = await view(r.cross);
      if (cross.data.state === CrossState.Live) throw new ActionError('cross has not settled yet', 'CONFLICT');
      if (cross.data.state === CrossState.Finalized) throw new ActionError('cross is finalized: every order has already been paid or refunded', 'CONFLICT');
      const { order } = await orderData(cross.address, r.owner, r.nonce);
      if (!order) throw new ActionError(`no open order for owner ${r.owner} with nonce ${r.nonce} in cross ${r.cross}`, 'NOT_FOUND');
      const payer = r.payer ?? r.owner;
      return build(payer, [await buildClaim(cross, createNoopSigner(toAddress(payer)), toAddress(r.owner), r.nonce)]);
    },

    async finalize(r) {
      const cross = await view(r.cross);
      if (cross.data.ordersOpen !== 0) throw new ActionError(`${cross.data.ordersOpen} orders are still open`, 'CONFLICT');
      return build(r.payer, [await buildFinalizeWithAccounts(cross, createNoopSigner(toAddress(r.payer)))]);
    },

    async initShards(r) {
      const cross = await view(r.cross);
      const present = new Map<string, boolean>();
      const shards = await Promise.all(Array.from({ length: Number(cross.data.shards) }, (_, i) => shardAddress(cross.address, i)));
      (await rpc.getAccounts(shards)).forEach((a, i) => present.set(shards[i]!, a !== null));
      const ixs = await buildMissingShards(cross, createNoopSigner(toAddress(r.payer)), async (a) => present.get(a) ?? false);
      if (ixs.length === 0) throw new ActionError('every shard of this cross already exists', 'CONFLICT');
      return build(r.payer, ixs.map((ix) => [ix]));
    },

    async createCross(r) {
      const names = <T extends readonly string[]>(v: string, field: string, list: T): number => {
        const i = list.indexOf(v);
        if (i < 0) throw new ActionError(`${field} must be one of ${list.join(', ')}`, 'INVALID_INPUT');
        return i;
      };
      const kind = names(r.kind, 'kind', CROSS_KINDS) as CrossKind;
      const supplyMode = names(r.supplyMode, 'supplyMode', SUPPLY_MODES) as SupplyMode;
      const disclosure = names(r.disclosure, 'disclosure', DISCLOSURES) as Disclosure;
      const creator = toAddress(r.creator);
      const { cross, create, shards, ensureCreatorQuote } = await buildCreateCross({
        creator: createNoopSigner(creator),
        ...(r.baseMint ? { baseMint: toAddress(r.baseMint) } : {}),
        quoteMint: toAddress(r.quoteMint),
        baseTokenProgram: toAddress(r.baseTokenProgram),
        quoteTokenProgram: toAddress(r.quoteTokenProgram),
        crossId: r.crossId,
        kind,
        supplyMode,
        disclosure,
        minPrice: r.minPrice,
        tick: r.tick,
        ticks: r.ticks,
        priceScale: r.priceScale,
        openTs: r.openTs,
        closeTs: r.closeTs,
        revealEndTs: r.revealEndTs,
        referencePrice: r.referencePrice ?? null,
        minMatched: r.minMatched ?? 0n,
        maxImbalanceBps: r.maxImbalanceBps ?? null,
        integratorFeeBps: r.integratorFeeBps ?? 0,
        integrator: toAddress(r.integrator),
        gateMint: r.gateMint ? toAddress(r.gateMint) : null,
        oracle: r.oracle ? { feedId: bytesOfHex(r.oracle.feedId), maxDivergenceBps: r.oracle.maxDivergenceBps, maxStalenessSecs: r.oracle.maxStalenessSecs } : null,
        calendar: r.calendar ? toAddress(r.calendar) : null,
        shards: r.shards,
        maxOrders: r.maxOrders,
        proceedsTo: toAddress(r.proceedsTo),
        schedule: (r.schedule ?? []).map((l) => ({ price: l.price, quantity: l.quantity })),
        settler: r.settler ? toAddress(r.settler) : null,
        settleDeadlineTs: r.settleDeadlineTs ?? 0n,
      });
      // A minting cross must own its base mint's mint authority. Hand it over in the same transaction as the create, signed by
      // the issuer who holds it now, so the issuer signs once.
      const handover: Instruction[] =
        supplyMode === SupplyMode.Mint && r.baseMint
          ? [getSetAuthorityInstruction({ owned: toAddress(r.baseMint), owner: createNoopSigner(creator), authorityType: AuthorityType.MintTokens, newAuthority: cross }, { programAddress: toAddress(r.baseTokenProgram) })]
          : [];
      return build(r.creator, [[ensureCreatorQuote, ...handover, create], ...shards.map((s) => [s])], { cross });
    },
  };
}
