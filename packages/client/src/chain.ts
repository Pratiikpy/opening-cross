// Reading a cross straight from the cluster, without the API: the trustless half of "state from the API with chain
// verification". The presentation is the API's own (same field names, integers as decimal strings), so the two can be
// compared field for field.
import { type Address, address as toAddress } from '@solana/kit';
import {
  CROSS_CORE_PROGRAM_ADDRESS,
  CROSS_DISCRIMINATOR,
  type Cross,
  CrossState,
  Disclosure,
  bookAddress,
  getCrossDecoder,
  getLevelsDecoder,
  shardAddress,
} from '@opening-cross/sdk';
import { referenceClear } from '@opening-cross/verifier';
import { ActionError } from './errors.js';
import type { RpcClient } from './rpc.js';
import type { BookLevel, BookResponse, CrossDetail } from './types.js';

const STATE = ['Live', 'Cleared', 'NoPrint', 'Finalized'] as const;
const NO_PRINT = ['NoCross', 'BelowMinimumVolume', 'ImbalanceTooHigh', 'SettlementExpired', 'OracleDivergence', 'OracleUnavailable', 'BelowMinimumRaise', 'FloatTooLow', 'FdvTooHigh', 'PriceMoved', 'Halted', 'CorporateAction', 'IssuerPaused'] as const;

/** The decoded cross if these bytes really are one owned by cross_core; anyone can create an account whose bytes look like a cross under another program. */
export function decodeCross(account: { data: Uint8Array; owner: string } | null): Cross | null {
  if (!account || account.owner !== CROSS_CORE_PROGRAM_ADDRESS || account.data.length < 8) return null;
  const disc = CROSS_DISCRIMINATOR as Uint8Array;
  if (!disc.every((b, i) => account.data[i] === b)) return null;
  return getCrossDecoder().decode(account.data);
}

const str = (v: bigint | number): string => String(v);

/** The same presentation as the API's `GET /v1/crosses/:address`. */
export function presentCross(address: string, c: Cross): CrossDetail {
  const clearing = c.clearing.__option === 'Some' ? c.clearing.value : null;
  return {
    address,
    state: STATE[c.state]!,
    disclosure: c.disclosure === Disclosure.Sealed ? 'sealed' : 'open',
    creator: c.creator,
    baseMint: c.baseBound ? c.baseMint : null,
    quoteMint: c.quoteMint,
    window: { openTs: str(c.openTs), closeTs: str(c.closeTs), revealEndTs: str(c.revealEndTs) },
    grid: { minPrice: str(c.minPrice), tick: str(c.tick), ticks: c.ticks, priceScale: str(c.priceScale) },
    decimals: { base: c.baseDecimals, quote: c.quoteDecimals },
    supplyMode: ['escrow', 'mint', 'deferred-mint'][c.supplyMode]!,
    kind: ['launch', 'reopen', 'tender', 'recurring'][c.kind]!,
    settlement: { settleDeadlineTs: str(c.settleDeadlineTs), baseBound: c.baseBound },
    fees: { protocolBps: c.protocolFeeBps, integratorBps: c.integratorFeeBps, integrator: c.integrator },
    orders: { total: c.ordersTotal, open: c.ordersOpen, max: c.maxOrders },
    clearing: clearing && { price: str(clearing.price), matched: str(clearing.matched), rationed: (['none', 'buy', 'sell'] as const)[clearing.rationed]! },
    noPrintReason: c.noPrintReason.__option === 'Some' ? (NO_PRINT[c.noPrintReason.value] ?? `Unknown(${c.noPrintReason.value})`) : null,
    gateMint: c.gateMint.__option === 'Some' ? c.gateMint.value : null,
    oracleGuard: c.oracle.__option === 'Some',
  };
}

/** Reads and decodes a cross from the cluster. Throws a typed NOT_FOUND if the address holds no cross. */
export async function readCrossFromChain(rpc: RpcClient, addr: string): Promise<{ address: Address; data: Cross; detail: CrossDetail }> {
  const account = await rpc.getAccount(addr);
  if (!account) throw new ActionError(`cross ${addr} not found on chain`, 'NOT_FOUND');
  const data = decodeCross(account);
  if (!data) throw new ActionError(`${addr} is not an Opening Cross account`, 'NOT_FOUND');
  return { address: toAddress(addr), data, detail: presentCross(addr, data) };
}

/**
 * The resting book from chain: the merged book plus every shard not yet merged (while the call is open, orders rest in the
 * shards), summed per tick, and the indicative clear of a live book computed with the independent reference rule.
 */
export async function readBookFromChain(rpc: RpcClient, addr: string, c: Cross): Promise<BookResponse> {
  const sources = [await bookAddress(toAddress(addr))];
  for (let i = 0; i < c.shards; i++) if (!((c.mergedMask >>> i) & 1)) sources.push(await shardAddress(toAddress(addr), i));
  const accounts = await rpc.getAccounts(sources);
  const buy = new Array<bigint>(c.ticks).fill(0n);
  const sell = new Array<bigint>(c.ticks).fill(0n);
  const buyOrders = new Array<number>(c.ticks).fill(0);
  const sellOrders = new Array<number>(c.ticks).fill(0);
  for (const [i, acct] of accounts.entries()) {
    if (!acct || acct.owner !== CROSS_CORE_PROGRAM_ADDRESS) throw new ActionError(`order book account ${sources[i]} not found`, 'NOT_FOUND');
    const levels = getLevelsDecoder().decode(acct.data);
    for (let t = 0; t < c.ticks; t++) {
      buy[t] = buy[t]! + levels.buy[t]!;
      sell[t] = sell[t]! + levels.sell[t]!;
      buyOrders[t] = buyOrders[t]! + levels.buyOrders[t]!;
      sellOrders[t] = sellOrders[t]! + levels.sellOrders[t]!;
    }
  }
  const levels: BookLevel[] = [];
  const orders: { side: 'buy' | 'sell'; price: bigint; quantity: bigint }[] = [];
  for (let t = 0; t < c.ticks; t++) {
    if (buy[t] === 0n && sell[t] === 0n) continue;
    const price = c.minPrice + BigInt(t) * c.tick;
    levels.push({ price: str(price), buy: str(buy[t]!), sell: str(sell[t]!), buyOrders: buyOrders[t]!, sellOrders: sellOrders[t]! });
    if (buy[t]! > 0n) orders.push({ side: 'buy', price, quantity: buy[t]! });
    if (sell[t]! > 0n) orders.push({ side: 'sell', price, quantity: sell[t]! });
  }
  const sealed = c.disclosure === Disclosure.Sealed;
  const live = c.state === CrossState.Live;
  const r = live ? referenceClear(orders, { min: c.minPrice, tick: c.tick, ticks: c.ticks }, c.referencePrice.__option === 'Some' ? c.referencePrice.value : null) : null;
  return {
    disclosure: sealed ? 'sealed' : 'open',
    levels,
    indicative: r && { price: str(r.price), matched: str(r.matched) },
    note: !live ? 'The book as it was cleared.' : sealed ? 'Sealed bids carry no price until they are revealed; only revealed orders appear here.' : 'Indicative until the call closes: later orders can move it.',
  };
}

/** Fields that legitimately move between two reads taken moments apart. */
const VOLATILE = /^(state|orders\.|clearing|noPrintReason)/;

export type CrossComparison = { matches: boolean; differences: { path: string; api: unknown; chain: unknown; volatile: boolean }[] };

/** Compares the API's presentation of a cross with the one read from chain, field by field. */
export function compareCross(api: CrossDetail, chain: CrossDetail): CrossComparison {
  const differences: CrossComparison['differences'] = [];
  const walk = (a: unknown, b: unknown, path: string) => {
    if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) walk((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], path ? `${path}.${k}` : k);
      return;
    }
    if (a !== b) differences.push({ path, api: a, chain: b, volatile: VOLATILE.test(path) });
  };
  walk(api, chain, '');
  return { matches: differences.length === 0, differences };
}
