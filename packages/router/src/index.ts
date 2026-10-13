// Best-execution routing for Opening Cross (ROADMAP D6).
//
// For one order — buy or sell `quantity` base atoms — the router prices two venues at the same
// moment and reports both, net of fees:
//   * the next cross: for open-disclosure crosses, the clearing rule is re-run on the current
//     on-chain book with the order added, giving the indicative price and this order's fill;
//     sealed books are hidden by design, so only the order's own limit bounds the outcome;
//   * a DEX route: a live Jupiter quote for the same mints and size.
// The cross result is indicative until the call period closes: later orders can move it, which
// the report states. Nothing here signs or sends anything.
import type { Address } from '@solana/kit';
import { CROSS_CORE_PROGRAM_ADDRESS, CROSS_DISCRIMINATOR, CrossState, Disclosure, type Cross, getCrossDecoder, getLevelsDecoder } from '@opening-cross/cross-core-client';
import { shardAddress } from '@opening-cross/sdk';
import { type RefOrder, bookAddressOf, referenceClear, referenceFills } from '@opening-cross/verifier';

export const REPORT_SCHEMA = 'opening-cross/best-execution/v1';

/** Reads an account with its owning program, or null if it does not exist. */
export type AccountReader = (address: Address) => Promise<{ data: Uint8Array; owner: Address } | null>;
export type Intent = { side: 'buy' | 'sell'; quantity: bigint; /** Limit in cross price units; omitted = any price on the grid. */ limitPrice?: bigint };

export type CrossQuote =
  | { venue: 'cross'; cross: Address; available: false; reason: string }
  | {
      venue: 'cross';
      cross: Address;
      available: true;
      disclosure: 'open' | 'sealed';
      closeTs: bigint;
      /** Open crosses only: the clearing price and this order's fill if the call closed now. */
      indicative: { prints: boolean; price: bigint | null; fill: bigint; quote: bigint } | null;
      feeBps: number;
    };

export type DexQuote = { venue: 'jupiter'; available: true; quote: bigint; base: bigint; contextSlot: bigint; route: string[]; priceImpactPct: string } | { venue: 'jupiter'; available: false; reason: string };

export type BestExecutionReport = {
  schema: typeof REPORT_SCHEMA;
  at: string;
  intent: { side: 'buy' | 'sell'; quantity: string; limitPrice: string | null };
  cross: Record<string, unknown>;
  dex: Record<string, unknown>;
  /** Quote atoms per `priceScale` base atoms, so both venues read in the cross's price units. */
  comparison: { crossPrice: string | null; dexPrice: string | null; crossBetterByBps: number | null; filledOnCross: string; filledOnDex: string } ;
  recommendation: 'cross' | 'dex' | 'split' | 'none';
  caveats: string[];
};

/** Per-tick resting quantity of a cross: the merged book plus every shard not yet merged (while the
 *  call is open, orders rest in the shards). Returns the reason as a string if an account is missing. */
export async function loadBook(read: AccountReader, cross: Address, c: Cross): Promise<{ buy: bigint[]; sell: bigint[]; buyOrders: number[]; sellOrders: number[] } | string> {
  const sources = [await bookAddressOf(cross)];
  for (let i = 0; i < c.shards; i++) if (!((c.mergedMask >>> i) & 1)) sources.push(await shardAddress(cross, i));
  const out = { buy: new Array<bigint>(c.ticks).fill(0n), sell: new Array<bigint>(c.ticks).fill(0n), buyOrders: new Array<number>(c.ticks).fill(0), sellOrders: new Array<number>(c.ticks).fill(0) };
  // Read together, so a reader that batches (the API's) asks the endpoint once for the book and every shard.
  const accounts = await Promise.all(sources.map((a) => read(a)));
  for (const [n, a] of sources.entries()) {
    const src = accounts[n];
    if (!src || src.owner !== CROSS_CORE_PROGRAM_ADDRESS) return `order book account ${a} not found`;
    const levels = getLevelsDecoder().decode(src.data);
    for (let i = 0; i < c.ticks; i++) {
      out.buy[i] = out.buy[i]! + levels.buy[i]!;
      out.sell[i] = out.sell[i]! + levels.sell[i]!;
      out.buyOrders[i] = out.buyOrders[i]! + levels.buyOrders[i]!;
      out.sellOrders[i] = out.sellOrders[i]! + levels.sellOrders[i]!;
    }
  }
  return out;
}

/** Indicative outcome of adding `intent` to a live cross. */
export async function quoteCross(read: AccountReader, cross: Address, intent: Intent, now: bigint): Promise<CrossQuote> {
  const acct = await read(cross);
  if (!acct) return { venue: 'cross', cross, available: false, reason: 'cross not found' };
  const isCross = acct.owner === CROSS_CORE_PROGRAM_ADDRESS && acct.data.length >= 8 && (CROSS_DISCRIMINATOR as Uint8Array).every((b, i) => acct.data[i] === b);
  if (!isCross) return { venue: 'cross', cross, available: false, reason: 'not an Opening Cross account' };
  const c: Cross = getCrossDecoder().decode(acct.data);
  if (c.state !== CrossState.Live) return { venue: 'cross', cross, available: false, reason: 'cross is not accepting orders' };
  if (now >= c.closeTs) return { venue: 'cross', cross, available: false, reason: 'call period has closed' };
  if (now < c.openTs) return { venue: 'cross', cross, available: false, reason: 'call period has not opened' };
  if (c.ordersTotal >= c.maxOrders) return { venue: 'cross', cross, available: false, reason: 'cross is full' };
  const feeBps = c.protocolFeeBps + c.integratorFeeBps;
  const maxPrice = c.minPrice + BigInt(c.ticks - 1) * c.tick;
  const limit = intent.limitPrice ?? (intent.side === 'buy' ? maxPrice : c.minPrice);
  if (limit < c.minPrice || limit > maxPrice || (limit - c.minPrice) % c.tick !== 0n) {
    return { venue: 'cross', cross, available: false, reason: 'limit price is not on the cross grid' };
  }
  if (c.disclosure === Disclosure.Sealed) {
    return { venue: 'cross', cross, available: true, disclosure: 'sealed', closeTs: c.closeTs, indicative: null, feeBps };
  }
  const levels = await loadBook(read, cross, c);
  if (typeof levels === 'string') return { venue: 'cross', cross, available: false, reason: levels };
  const { buy, sell } = levels;
  const orders: RefOrder[] = [];
  for (let i = 0; i < c.ticks; i++) {
    const price = c.minPrice + BigInt(i) * c.tick;
    if (buy[i]! > 0n) orders.push({ side: 'buy', price, quantity: buy[i]! });
    if (sell[i]! > 0n) orders.push({ side: 'sell', price, quantity: sell[i]! });
  }
  const mine: RefOrder = { side: intent.side, price: limit, quantity: intent.quantity };
  const all = [...orders, mine];
  const r = referenceClear(all, { min: c.minPrice, tick: c.tick, ticks: c.ticks }, c.referencePrice.__option === 'Some' ? c.referencePrice.value : null);
  if (!r) return { venue: 'cross', cross, available: true, disclosure: 'open', closeTs: c.closeTs, indicative: { prints: false, price: null, fill: 0n, quote: 0n }, feeBps };
  const fill = referenceFills(all, r).at(-1)!;
  // Buyers pay ceil(fill·P/scale); sellers receive floor(fill·P/scale) less the fee (cross_core::claim).
  const gross = intent.side === 'buy' ? ceilDiv(fill * r.price, c.priceScale) : (fill * r.price) / c.priceScale;
  const quote = intent.side === 'buy' ? gross : gross - (gross * BigInt(feeBps)) / 10_000n;
  return { venue: 'cross', cross, available: true, disclosure: 'open', closeTs: c.closeTs, indicative: { prints: true, price: r.price, fill, quote }, feeBps };
}

/** Live Jupiter quote for the same size: ExactOut for buys (base out), ExactIn for sells. */
export async function quoteJupiter(p: { baseMint: Address; quoteMint: Address; intent: Intent; slippageBps?: number; baseUrl?: string; fetchImpl?: typeof fetch }): Promise<DexQuote> {
  const buy = p.intent.side === 'buy';
  const url = new URL(`${p.baseUrl ?? 'https://lite-api.jup.ag/swap/v1'}/quote`);
  url.searchParams.set('inputMint', buy ? p.quoteMint : p.baseMint);
  url.searchParams.set('outputMint', buy ? p.baseMint : p.quoteMint);
  url.searchParams.set('amount', p.intent.quantity.toString());
  url.searchParams.set('swapMode', buy ? 'ExactOut' : 'ExactIn');
  url.searchParams.set('slippageBps', String(p.slippageBps ?? 50));
  const res = await (p.fetchImpl ?? fetch)(url, { headers: { accept: 'application/json' } });
  if (!res.ok) return { venue: 'jupiter', available: false, reason: `Jupiter answered HTTP ${res.status}: ${(await res.text()).slice(0, 200)}` };
  const q = (await res.json()) as { inAmount: string; outAmount: string; contextSlot: number; priceImpactPct: string; routePlan: { swapInfo: { label: string } }[] };
  return {
    venue: 'jupiter',
    available: true,
    quote: BigInt(buy ? q.inAmount : q.outAmount),
    base: BigInt(buy ? q.outAmount : q.inAmount),
    contextSlot: BigInt(q.contextSlot),
    route: q.routePlan.map((r) => r.swapInfo.label),
    priceImpactPct: q.priceImpactPct,
  };
}

/** Combines both quotes into a report; prices are expressed in the cross's units. */
export function bestExecution(intent: Intent, cross: CrossQuote, dex: DexQuote, priceScale: bigint, at = new Date()): BestExecutionReport {
  const caveats: string[] = [];
  const buy = intent.side === 'buy';
  const per = (quote: bigint, base: bigint) => (base === 0n ? null : buy ? ceilDiv(quote * priceScale, base) : (quote * priceScale) / base);
  const crossFill = cross.available && cross.indicative ? cross.indicative.fill : 0n;
  const crossPrice = cross.available && cross.indicative && cross.indicative.prints && crossFill > 0n ? per(cross.indicative.quote, crossFill) : null;
  const dexPrice = dex.available ? per(dex.quote, dex.base) : null;
  if (cross.available && cross.disclosure === 'sealed') caveats.push('Sealed cross: the book is hidden until reveal, so no indicative price exists; your limit bounds what you pay or receive.');
  if (cross.available && cross.indicative) caveats.push('Indicative: computed on the book as it stands; orders placed before the call closes can change the price and your fill.');
  if (cross.available && cross.indicative?.prints && crossFill < intent.quantity) caveats.push(`Partial: the cross would fill ${crossFill} of ${intent.quantity} base atoms at your limit.`);
  if (!cross.available) caveats.push(`Cross unavailable: ${cross.reason}.`);
  if (!dex.available) caveats.push(`DEX route unavailable: ${dex.reason}.`);
  if (dex.available) caveats.push('DEX quote is executable now within its slippage bound; the cross settles after the call closes.');

  let betterBps: number | null = null;
  let recommendation: BestExecutionReport['recommendation'] = 'none';
  if (crossPrice !== null && dexPrice !== null) {
    // Positive = the cross is better for this side.
    const diff = buy ? dexPrice - crossPrice : crossPrice - dexPrice;
    betterBps = Number((diff * 10_000n) / dexPrice);
    recommendation = betterBps > 0 ? (crossFill < intent.quantity ? 'split' : 'cross') : 'dex';
  } else if (dexPrice !== null) recommendation = 'dex';
  else if (crossPrice !== null) recommendation = crossFill < intent.quantity ? 'split' : 'cross';

  return {
    schema: REPORT_SCHEMA,
    at: at.toISOString(),
    intent: { side: intent.side, quantity: intent.quantity.toString(), limitPrice: intent.limitPrice?.toString() ?? null },
    cross: json(cross),
    dex: json(dex),
    comparison: { crossPrice: crossPrice?.toString() ?? null, dexPrice: dexPrice?.toString() ?? null, crossBetterByBps: betterBps, filledOnCross: crossFill.toString(), filledOnDex: dex.available ? dex.base.toString() : '0' },
    recommendation,
    caveats,
  };
}

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
const json = (v: unknown) => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x))) as Record<string, unknown>;

export type JupiterSwap = {
  /** Base64 wire bytes of an unsigned (VersionedTransaction) swap; the user is the fee payer and only signer. */
  transaction: string;
  lastValidBlockHeight: bigint;
  /** The quote the swap was built from. */
  quote: { inAmount: bigint; outAmount: bigint; priceImpactPct: string; route: string[]; swapMode: 'ExactIn' | 'ExactOut'; slippageBps: number };
};

/**
 * An unsigned Jupiter swap for the same intent `quoteJupiter` prices: ExactOut for buys (base out), ExactIn for sells. It asks
 * Jupiter for a quote and then for the transaction that executes exactly that quote for `userPublicKey`. Jupiter routes mainnet
 * liquidity only, so on devnet this is not callable; the caller says so instead of calling. Nothing is signed or sent.
 */
export async function jupiterSwapTransaction(p: { baseMint: Address; quoteMint: Address; intent: Intent; userPublicKey: Address; slippageBps?: number; baseUrl?: string; fetchImpl?: typeof fetch }): Promise<JupiterSwap> {
  const f = p.fetchImpl ?? fetch;
  const base = p.baseUrl ?? 'https://lite-api.jup.ag/swap/v1';
  const buy = p.intent.side === 'buy';
  const slippageBps = p.slippageBps ?? 50;
  const url = new URL(`${base}/quote`);
  url.searchParams.set('inputMint', buy ? p.quoteMint : p.baseMint);
  url.searchParams.set('outputMint', buy ? p.baseMint : p.quoteMint);
  url.searchParams.set('amount', p.intent.quantity.toString());
  url.searchParams.set('swapMode', buy ? 'ExactOut' : 'ExactIn');
  url.searchParams.set('slippageBps', String(slippageBps));
  const q = await f(url, { headers: { accept: 'application/json' } });
  if (!q.ok) throw new Error(`Jupiter quote answered HTTP ${q.status}: ${(await q.text()).slice(0, 200)}`);
  const quoteResponse = (await q.json()) as { inAmount: string; outAmount: string; priceImpactPct: string; routePlan: { swapInfo: { label: string } }[] };
  const s = await f(`${base}/swap`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ quoteResponse, userPublicKey: p.userPublicKey, wrapAndUnwrapSol: true }) });
  if (!s.ok) throw new Error(`Jupiter swap answered HTTP ${s.status}: ${(await s.text()).slice(0, 200)}`);
  const swap = (await s.json()) as { swapTransaction?: string; lastValidBlockHeight?: number };
  if (typeof swap.swapTransaction !== 'string') throw new Error('Jupiter returned no transaction');
  return {
    transaction: swap.swapTransaction,
    lastValidBlockHeight: BigInt(swap.lastValidBlockHeight ?? 0),
    quote: { inAmount: BigInt(quoteResponse.inAmount), outAmount: BigInt(quoteResponse.outAmount), priceImpactPct: quoteResponse.priceImpactPct, route: quoteResponse.routePlan.map((r) => r.swapInfo.label), swapMode: buy ? 'ExactOut' : 'ExactIn', slippageBps },
  };
}
