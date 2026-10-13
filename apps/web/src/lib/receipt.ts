// Shareable receipt (S2, VM5). A receipt restates what the chain recorded for a cross, the verdict of the independent
// recomputation (GET /v1/crosses/:address/proof) and the transactions that recorded the result, as one JSON document
// (`opening-cross/receipt/v1`, schema in packages/verifier/schema, rules in docs/standard/receipt-v1.md).
//
// It is hash-bound, not signed: nothing here holds a key. The document has no clock and no randomness, so the same cross
// always produces the same bytes; the SHA-256 of those bytes is the receipt's identity, and anyone can rebuild it from the
// public API and compare. The receipt makes no claim beyond a recomputation: there is no zero-knowledge or multi-party proof.
import { formatAtoms, formatPrice, shortAddress } from './units';

export const RECEIPT_SCHEMA = 'opening-cross/receipt/v1';
export const PROOF_SCHEMA_ID = 'opening-cross/fairness-proof/v1';

const NO_PRINT = ['NoCross', 'BelowMinimumVolume', 'ImbalanceTooHigh', 'SettlementExpired', 'OracleDivergence', 'OracleUnavailable', 'BelowMinimumRaise', 'FloatTooLow', 'FdvTooHigh', 'PriceMoved', 'Halted', 'CorporateAction', 'IssuerPaused', 'OracleDisagreement'] as const;

/** The parts of GET /v1/crosses/:address/proof a receipt reads. Anything else in the proof is covered by `proofSha256`. */
export type ProofInput = {
  schema: string;
  program: string;
  cross: string;
  state: 'Live' | 'Cleared' | 'NoPrint' | 'Finalized';
  onchain: { printed: boolean; price: string | null; matched: string | null; rationed: string | null; noPrintReason: number | null };
  recomputed: { printed: boolean; price: string | null; matched: string | null; rationed: string | null; noPrintReason: string | null };
  verified: boolean;
  [k: string]: unknown;
};

export type MarketInput = { priceScale: string; decimals: { base: number; quote: number } };

export type AnchorInput = { event: string; kind: string; slot: string; time: string | null; signature: string };

export type OrderInput = {
  address: string;
  owner: string;
  idx: number;
  side: 'buy' | 'sell';
  escrow: string;
  sealed: boolean;
  price: string | null;
  quantity: string | null;
  status: 'committed' | 'revealed' | 'cancelled' | 'claimed';
  fill: string | null;
  quote_out: string | null;
  base_out: string | null;
  fee: string | null;
};

export type Receipt = {
  schema: typeof RECEIPT_SCHEMA;
  network: string;
  program: string;
  cross: string;
  market: { priceScale: string; baseDecimals: number; quoteDecimals: number };
  result: { state: 'Cleared' | 'NoPrint' | 'Finalized'; printed: boolean; price: string | null; matched: string | null; rationed: 'none' | 'buy' | 'sell' | null; noPrintReason: string | null };
  verification: { method: string; recomputedMatchesChain: boolean; proofSchema: string; proofSha256: string };
  orders: { total: number; filled: number } | null;
  anchors: { event: 'CrossCleared' | 'CrossFinalized'; signature: string; slot: string; time: string | null }[];
  wallet: null | { owner: string; orders: ReceiptOrder[] };
  limits: string[];
};

export type ReceiptOrder = {
  order: string;
  index: number;
  side: 'buy' | 'sell';
  escrow: string;
  limitPrice: string | null;
  quantity: string | null;
  status: OrderInput['status'];
  fill: string | null;
  baseOut: string | null;
  quoteOut: string | null;
  fee: string | null;
};

export const METHOD = 'A second implementation of the clearing rule recomputed the price, matched volume and rationed side from the cross\'s on-chain book and compared them with the result the program recorded.';

/** What the receipt does not show. Stated inside every receipt so the document cannot be quoted without it. */
export const LIMITS = [
  'This is a recomputation anyone can repeat, not a zero-knowledge or multi-party proof.',
  'The receipt is bound to its content by a SHA-256 hash; it is not signed by a key.',
  'It does not show that the book equals the sum of the orders placed, that each individual fill equals the rule\'s value, or that the tokens are what their issuer says.',
  'Order figures are the chain index\'s record of the cross\'s orders, which a reconciler compares with the chain.',
];

/** Canonical JSON: keys sorted at every level, no whitespace, standard JSON string escapes. The byte string a receipt hash is taken over. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') {
    if (typeof v === 'number' && !Number.isFinite(v)) throw new Error('canonicalJson: a number must be finite');
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(',')}}`;
}

export async function sha256Hex(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export type ReceiptInputs = {
  network: string;
  market: MarketInput;
  proof: ProofInput;
  /** Every order of the cross, as GET /v1/crosses/:address/orders serves them; null when they could not be read. */
  orders: OrderInput[] | null;
  /** The cross's replay events, for the transactions that recorded the result. */
  anchors: AnchorInput[];
  /** A wallet to add its own orders for; omitted for the cross receipt. */
  owner?: string;
};

export class NoReceiptError extends Error {}

/** Builds the receipt and its canonical bytes and hash. Throws NoReceiptError for a cross that has not settled: there is nothing to receipt. */
export async function buildReceipt(i: ReceiptInputs): Promise<{ receipt: Receipt; canonical: string; sha256: string }> {
  const p = i.proof;
  if (p.state === 'Live') throw new NoReceiptError('The cross has not settled yet, so there is no result to receipt.');
  const o = p.onchain;
  const reason = o.noPrintReason === null ? null : (NO_PRINT[o.noPrintReason] ?? `reason ${o.noPrintReason}`);
  const mine = i.owner ? (i.orders ?? []).filter((x) => x.owner === i.owner) : null;
  const receipt: Receipt = {
    schema: RECEIPT_SCHEMA,
    network: i.network,
    program: p.program,
    cross: p.cross,
    market: { priceScale: i.market.priceScale, baseDecimals: i.market.decimals.base, quoteDecimals: i.market.decimals.quote },
    result: { state: p.state, printed: o.printed, price: o.price, matched: o.matched, rationed: (o.rationed as 'none' | 'buy' | 'sell' | null) ?? null, noPrintReason: reason },
    verification: { method: METHOD, recomputedMatchesChain: p.verified, proofSchema: p.schema, proofSha256: await sha256Hex(canonicalJson(p)) },
    orders: i.orders ? { total: i.orders.length, filled: i.orders.filter((x) => x.fill !== null && BigInt(x.fill) > 0n).length } : null,
    anchors: i.anchors
      .filter((a) => a.kind === 'cleared' || a.kind === 'finalized')
      .map((a) => ({ event: a.kind === 'cleared' ? ('CrossCleared' as const) : ('CrossFinalized' as const), signature: a.signature, slot: a.slot, time: a.time })),
    wallet: i.owner
      ? {
          owner: i.owner,
          orders: (mine ?? []).map((x) => ({ order: x.address, index: x.idx, side: x.side, escrow: x.escrow, limitPrice: x.price, quantity: x.quantity, status: x.status, fill: x.fill, baseOut: x.base_out, quoteOut: x.quote_out, fee: x.fee })),
        }
      : null,
    limits: LIMITS,
  };
  const canonical = canonicalJson(receipt);
  return { receipt, canonical, sha256: await sha256Hex(canonical) };
}

// ---- what the card and the page say, computed from the receipt alone

export type CardLine = { label: string; value: string };

export type Card = {
  title: string;
  verdict: { text: string; tone: 'ok' | 'bad' | 'neutral' };
  headline: { label: string; value: string };
  lines: CardLine[];
  wallet: { heading: string; lines: string[] } | null;
};

const market = (r: Receipt) => ({ priceScale: BigInt(r.market.priceScale), baseDecimals: r.market.baseDecimals, quoteDecimals: r.market.quoteDecimals });

/** Wording for one wallet order: what it asked for and what it got, in tokens. */
export function describeReceiptOrder(o: ReceiptOrder, r: Receipt): string {
  const m = market(r);
  const q = o.quantity !== null ? `${formatAtoms(BigInt(o.quantity), m.baseDecimals)} tokens` : 'an undisclosed size';
  const limit = o.limitPrice !== null ? ` at a limit of ${formatPrice(BigInt(o.limitPrice), m)}` : '';
  const head = `${o.side === 'buy' ? 'Buy' : 'Sell'} ${q}${limit}`;
  if (o.status === 'cancelled') return `${head}: cancelled and refunded.`;
  if (o.status !== 'claimed') return `${head}: not settled yet.`;
  const fill = BigInt(o.fill ?? '0');
  if (o.side === 'buy') {
    const paid = BigInt(o.escrow) - BigInt(o.quoteOut ?? '0');
    const back = formatAtoms(BigInt(o.quoteOut ?? '0'), m.quoteDecimals);
    return fill === 0n ? `${head}: not filled, ${formatAtoms(BigInt(o.quoteOut ?? o.escrow), m.quoteDecimals)} quote tokens returned.` : `${head}: filled ${formatAtoms(fill, m.baseDecimals)} tokens, paid ${formatAtoms(paid, m.quoteDecimals)} quote tokens, ${back} returned.`;
  }
  return fill === 0n ? `${head}: sold nothing, tokens returned.` : `${head}: sold ${formatAtoms(fill, m.baseDecimals)} tokens for ${formatAtoms(BigInt(o.quoteOut ?? '0'), m.quoteDecimals)}.`;
}

/** The card's words from the receipt alone, so the page, the image and the JSON cannot disagree. */
export function cardOf(r: Receipt): Card {
  const m = market(r);
  const res = r.result;
  const verdict: Card['verdict'] = r.verification.recomputedMatchesChain
    ? { text: 'Recomputation matches the chain', tone: 'ok' }
    : { text: 'Recomputation does not match the chain', tone: 'bad' };
  const lines: CardLine[] = [];
  if (res.printed && res.matched !== null) lines.push({ label: 'Matched', value: `${formatAtoms(BigInt(res.matched), m.baseDecimals)} tokens${res.rationed && res.rationed !== 'none' ? `, ${res.rationed} side pro rata` : ''}` });
  if (r.orders) lines.push({ label: 'Orders filled', value: res.printed ? `${r.orders.filled} of ${r.orders.total}` : `0 of ${r.orders.total}, all refunded` });
  lines.push({ label: 'Cross', value: shortAddress(r.cross) });
  lines.push({ label: 'Network', value: r.network });
  return {
    title: r.wallet ? 'Order receipt' : 'Cross receipt',
    verdict,
    headline: res.printed && res.price !== null ? { label: 'One clearing price', value: formatPrice(BigInt(res.price), m) } : { label: 'Result', value: `No print${res.noPrintReason ? `: ${res.noPrintReason}` : ''}` },
    lines,
    wallet: r.wallet ? { heading: `Wallet ${shortAddress(r.wallet.owner)}`, lines: r.wallet.orders.length ? r.wallet.orders.map((o) => describeReceiptOrder(o, r)) : ['This wallet has no orders in this cross.'] } : null,
  };
}
