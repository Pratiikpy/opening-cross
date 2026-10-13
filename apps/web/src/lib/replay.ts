// Launch replay (S12): the ordered on-chain events of a cross as GET /v1/replay/:address serves them, turned into sentences,
// a running tally and a time axis. Everything shown comes from those events. Nothing is inferred beyond arithmetic on them:
// in particular the clearing price is never recomputed here, because the issuer's supply schedule is not an event.
import { type Market, formatAtoms, formatPrice, shortAddress } from './units';

export type ReplayEvent = {
  n: number;
  kind: string;
  event: string;
  slot: string;
  time: string | null;
  signature: string;
  details: Record<string, unknown>;
};

export type ReplayResponse = {
  cross: string;
  complete: boolean;
  state: string;
  source: string;
  summary: { events: number; ordersPlaced: number; revealed: number; cancelled: number; claimed: number; cleared: boolean; finalized: boolean; clearingPrice: string | null; matched: string | null; firstEventAt: string | null; lastEventAt: string | null };
  events: ReplayEvent[];
};

export type ReplayListRow = {
  address: string;
  state: string;
  kind: string | null;
  disclosure: 'open' | 'sealed';
  baseMint: string;
  quoteMint: string;
  window: { openTs: string; closeTs: string; revealEndTs: string };
  outcome: 'live' | 'no print' | 'printed';
  clearingPrice: string | null;
  matched: string | null;
  proceedsQuote: string | null;
  orders: { placed: number; wallets: number; claimed: number; cancelled: number };
  events: number;
  firstOrderAt: string | null;
  clearedAt: string | null;
  finalizedAt: string | null;
};

export type ReplayListResponse = { network: string; days: number; count: number; crosses: ReplayListRow[] };

const str = (v: unknown): string | null => (typeof v === 'string' || typeof v === 'number' || typeof v === 'bigint' ? String(v) : null);
const big = (v: unknown): bigint | null => {
  const s = str(v);
  return s !== null && /^\d+$/.test(s) ? BigInt(s) : null;
};

/** True for a response this page can render faithfully: the shape is checked, not trusted. */
export function isReplayResponse(v: unknown): v is ReplayResponse {
  const r = v as ReplayResponse | null;
  return !!r && typeof r.cross === 'string' && Array.isArray(r.events) && !!r.summary && r.events.every((e) => typeof e.kind === 'string' && typeof e.slot === 'string' && typeof e.signature === 'string' && typeof e.details === 'object' && e.details !== null);
}

export function isReplayListResponse(v: unknown): v is ReplayListResponse {
  const r = v as ReplayListResponse | null;
  return !!r && Array.isArray(r.crosses) && r.crosses.every((c) => typeof c.address === 'string' && !!c.window && !!c.orders);
}

const KIND_LABEL: Record<string, string> = {
  created: 'Cross created',
  order_placed: 'Order placed',
  order_revealed: 'Bid revealed',
  order_cancelled: 'Order cancelled',
  base_mint_bound: 'Base mint bound',
  cleared: 'Cleared',
  order_claimed: 'Order settled',
  finalized: 'Finalized',
  rules_set: 'Rules set',
  order_placement: 'Order placed in a window',
  draw_started: 'Draw begun',
  draw_finished: 'Draw finished',
  extension_pending: 'Extension pending',
  insider_challenged: 'Insider challenged',
  challenge_resolved: 'Challenge ruled on',
  challenge_expired: 'Challenge expired',
  lock_created: 'Fill locked',
  lock_released: 'Lock released',
  print_fed: 'Price published to lenders',
};
export const kindLabel = (kind: string): string => KIND_LABEL[kind] ?? kind;

const sideOf = (v: unknown): 'buy' | 'sell' | null => (v === 0 || v === '0' ? 'buy' : v === 1 || v === '1' ? 'sell' : null);
const RATIONED = ['none', 'buy', 'sell'];
const NO_PRINT = [
  'no crossing orders',
  'volume below the minimum',
  'imbalance too high',
  'settlement window expired',
  'oracle divergence',
  'oracle unavailable',
  'amount raised below the minimum',
  'float below the minimum',
  'valuation above the ceiling',
  'price moved too far from the reference',
  'trading halted',
  'corporate action',
  'token paused',
  'oracles disagreed',
];
const PURPOSE = ['', 'the last counted ending window', 'the length of the extension'];
const KIND = ['launch', 'reopen', 'tender', 'recurring'];

export const utcStamp = (iso: string | null): string => (iso ? `${new Date(iso).toISOString().replace('T', ' ').slice(0, 19)} UTC` : 'time not recorded');

/** One plain sentence for an event, in tokens and quote tokens. Fields the program did not emit are left out, never guessed. */
export function describeEvent(e: ReplayEvent, m: Market): string {
  const d = e.details;
  const tokens = (v: unknown) => (big(v) !== null ? `${formatAtoms(big(v)!, m.baseDecimals)} tokens` : null);
  const quote = (v: unknown) => (big(v) !== null ? formatAtoms(big(v)!, m.quoteDecimals) : null);
  const price = (v: unknown) => (big(v) !== null ? formatPrice(big(v)!, m) : null);
  const who = (v: unknown) => (str(v) ? shortAddress(str(v)!) : 'a wallet');
  switch (e.kind) {
    case 'created': {
      const kind = KIND[Number(d.kind)] ?? 'cross';
      const open = Number(d.disclosure) === 1;
      const closes = big(d.closeTs);
      return `A ${kind} cross was created by ${who(d.creator)} with ${open ? 'open' : 'sealed'} bids${closes !== null ? `, closing at ${utcStamp(new Date(Number(closes) * 1000).toISOString())}` : ''}.`;
    }
    case 'order_placed': {
      const side = sideOf(d.side);
      const idx = str(d.index);
      const head = `${side ? (side === 'buy' ? 'Buy' : 'Sell') : 'An'} order${idx !== null ? ` #${idx}` : ''} was placed by ${who(d.owner)}`;
      if (d.sealed === true) return `${head}. It is sealed: its price and size stay hidden until it is revealed.`;
      const p = price(d.price);
      const q = tokens(d.quantity);
      return `${head}${q ? ` for ${q}` : ''}${p ? ` at a limit of ${p}` : ''}.`;
    }
    case 'order_revealed': {
      const side = sideOf(d.side);
      const p = price(d.price);
      const q = tokens(d.quantity);
      return `A sealed ${side ? `${side} ` : ''}bid was revealed${q ? `: ${q}` : ''}${p ? ` at a limit of ${p}` : ''}.`;
    }
    case 'order_cancelled':
      return `An order was cancelled by ${who(d.owner)} and its escrow returned.`;
    case 'base_mint_bound':
      return `The base mint was bound: ${who(d.baseMint)}.`;
    case 'cleared': {
      const c = (d.clearing as { value?: Record<string, unknown> } | null | undefined)?.value;
      if (d.printed === true && c) {
        const rationed = RATIONED[Number(c.rationed)];
        return `The cross printed at ${price(c.price) ?? 'one price'} with ${tokens(c.matched) ?? 'its matched volume'} traded${rationed && rationed !== 'none' ? `; ${rationed} orders at the price were filled pro rata` : ''}.`;
      }
      const reason = (d.noPrintReason as { value?: unknown } | null | undefined)?.value;
      return `The cross did not print${typeof reason === 'number' && NO_PRINT[reason] ? `: ${NO_PRINT[reason]}` : ''}. Every order is refunded in full.`;
    }
    case 'order_claimed': {
      const side = sideOf(d.side);
      const fill = big(d.fill);
      if (side === 'buy') {
        const got = tokens(d.baseOut);
        const back = quote(d.quoteOut);
        return fill === 0n ? `${who(d.owner)} was not filled and took ${back ?? 'its'} back in quote tokens.` : `${who(d.owner)} received ${got ?? 'its fill'}${back && back !== '0' ? ` and ${back} quote tokens back` : ''}.`;
      }
      const got = quote(d.quoteOut);
      return fill === 0n ? `${who(d.owner)} sold nothing and took its tokens back.` : `${who(d.owner)} sold ${tokens(d.fill) ?? 'its fill'}${got ? ` and received ${got} quote tokens` : ''}.`;
    }
    case 'rules_set': {
      const bits: string[] = [];
      const ending = d.ending as { endingSecs?: number; buckets?: number } | undefined;
      if (ending?.endingSecs) bits.push(`an ending period of ${ending.endingSecs} s in ${ending.buckets} windows`);
      const bond = big(d.bondQuote);
      if (bond && bond > 0n) bits.push(`a bond of ${formatAtoms(bond, m.quoteDecimals)} quote behind ${str(d.insiders) ?? 'its'} declared insider${str(d.insiders) === '1' ? '' : 's'}`);
      return `The cross’s rules were fixed${bits.length ? `: ${bits.join(', ')}` : ''}. They cannot change.`;
    }
    case 'order_placement': {
      const x = d.ext as { class?: number; bucket?: number; lockCliff?: number } | undefined;
      const cls = x?.class ? [, 'small verified buyer', 'locked buyer', 'priority'][x.class] : null;
      return `An order was recorded${x && x.bucket !== undefined && x.bucket !== 255 ? ` in ending window ${x.bucket + 1}` : ''}${cls ? ` as a ${cls} order` : ''}${x?.lockCliff ? `, its fill locked for ${x.lockCliff} s` : ''}.`;
    }
    case 'draw_started':
      return `A draw began at slot ${str(d.slot) ?? 'unknown'} to fix ${PURPOSE[Number(d.purpose)] ?? 'a rule of the cross'}.`;
    case 'draw_finished': {
      const end = Number(d.endBucket);
      return `The draw finished${Number(d.purpose) === 1 && end !== 255 && Number.isFinite(end) ? `: ending window ${end + 1} is the last that counts, and orders in later windows are refunded` : Number(d.purpose) === 2 ? ': the length of the extension was set' : ''}.`;
    }
    case 'extension_pending': {
      const reason = NO_PRINT[Number(d.reason)];
      return `The cross did not print${reason ? ` (${reason})` : ''} and its rules allow one extension, so the call will reopen for a drawn length.`;
    }
    case 'insider_challenged':
      return `${who(d.challenger)} challenged ${who(d.subject)} as an undeclared insider (challenge ${str(d.id) ?? ''}).`.replace(' ()', '');
    case 'challenge_resolved':
      return d.upheld === true ? `Challenge ${str(d.id) ?? ''} was upheld and ${quote(d.slash) ? `${quote(d.slash)} quote` : 'part'} of the issuer’s bond was slashed.` : `Challenge ${str(d.id) ?? ''} was rejected.`;
    case 'challenge_expired':
      return `Challenge ${str(d.id) ?? ''} expired unanswered and its deposit was returned.`;
    case 'lock_created':
      return `${who(d.owner)}’s fill of ${tokens(d.amount) ?? 'tokens'} was locked${big(d.cliffSecs) ? ` for ${str(d.cliffSecs)} s` : ''}${big(d.vestSecs) ? ` and vests over ${str(d.vestSecs)} s` : ''}.`;
    case 'lock_released':
      return `${tokens(d.amount) ?? 'Tokens'} were released to ${who(d.owner)}; ${tokens(d.remaining) ?? 'none'} remain locked.`;
    case 'print_fed':
      return `The cross’s price ${price(d.price) ?? ''} for ${tokens(d.matched) ?? 'its volume'} was published to the lender price feed.`.replace('  ', ' ');
    case 'finalized':
      return `The cross was finalized: every order is paid or refunded and the proceeds went to the issuer${quote(d.proceedsQuote) ? ` (${quote(d.proceedsQuote)} quote tokens after fees)` : ''}.`;
    default:
      return `${e.event}.`;
  }
}

export type ReplayTally = {
  step: number;
  placed: number;
  revealed: number;
  cancelled: number;
  claimed: number;
  /** Placed and neither cancelled nor settled yet. */
  open: number;
  /** Sealed orders whose price and size are still hidden. */
  sealedHidden: number;
  cleared: boolean;
  finalized: boolean;
  /** Limit price -> quantity of orders whose terms are public so far, highest price first. Sealed, unrevealed orders are never in it. Empty once the cross has cleared. */
  levels: { price: bigint; buy: bigint; sell: bigint }[];
  phase: 'taking orders' | 'cleared' | 'finalized';
};

/** The book as the events alone describe it after `upto` events (1-based; 0 = before the first). */
export function tallyAt(events: readonly ReplayEvent[], upto: number): ReplayTally {
  const n = Math.max(0, Math.min(upto, events.length));
  const orders = new Map<string, { side: 'buy' | 'sell' | null; price: bigint | null; quantity: bigint | null; hidden: boolean }>();
  let placed = 0, revealed = 0, cancelled = 0, claimed = 0;
  let cleared = false, finalized = false;
  for (let i = 0; i < n; i++) {
    const e = events[i]!;
    const d = e.details;
    const order = str(d.order);
    if (e.kind === 'order_placed') {
      placed++;
      const hidden = d.sealed === true;
      if (order) orders.set(order, { side: sideOf(d.side), price: hidden ? null : big(d.price), quantity: hidden ? null : big(d.quantity), hidden });
    } else if (e.kind === 'order_revealed') {
      revealed++;
      if (order) orders.set(order, { side: sideOf(d.side), price: big(d.price), quantity: big(d.quantity), hidden: false });
    } else if (e.kind === 'order_cancelled') {
      cancelled++;
      if (order) orders.delete(order);
    } else if (e.kind === 'order_claimed') claimed++;
    else if (e.kind === 'cleared') cleared = true;
    else if (e.kind === 'finalized') finalized = true;
  }
  const byPrice = new Map<string, { price: bigint; buy: bigint; sell: bigint }>();
  let sealedHidden = 0;
  for (const o of orders.values()) {
    if (o.hidden) sealedHidden++;
    if (o.hidden || !o.side || o.price === null || o.quantity === null) continue;
    const row = byPrice.get(o.price.toString()) ?? { price: o.price, buy: 0n, sell: 0n };
    row[o.side] += o.quantity;
    byPrice.set(o.price.toString(), row);
  }
  return {
    step: n,
    placed,
    revealed,
    cancelled,
    claimed,
    open: Math.max(0, placed - cancelled - claimed),
    sealedHidden,
    cleared,
    finalized,
    levels: cleared ? [] : [...byPrice.values()].sort((x, y) => (x.price < y.price ? 1 : -1)),
    phase: finalized ? 'finalized' : cleared ? 'cleared' : 'taking orders',
  };
}

/** "+3 min 12 s" style distance from the first event; null when either time was not recorded. */
export function elapsedSince(first: string | null, at: string | null): string | null {
  if (!first || !at) return null;
  const s = Math.max(0, Math.round((Date.parse(at) - Date.parse(first)) / 1000));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  if (d > 0) return `+${d} d ${h} h ${m} min`;
  if (h > 0) return `+${h} h ${m} min ${r} s`;
  if (m > 0) return `+${m} min ${r} s`;
  return `+${r} s`;
}

/** Position of each event on the time axis as 0..1 of the span between the first and last recorded time; events without a time sit at their order. */
export function axisPositions(events: readonly ReplayEvent[]): number[] {
  const times = events.map((e) => (e.time ? Date.parse(e.time) : null));
  const known = times.filter((t): t is number => t !== null);
  if (events.length <= 1) return events.map(() => 0);
  const lo = Math.min(...known), hi = Math.max(...known);
  if (known.length === events.length && hi > lo) return times.map((t) => (t! - lo) / (hi - lo));
  return events.map((_, i) => i / (events.length - 1));
}

export const explorerTx = (signature: string, cluster: 'devnet' | 'mainnet-beta'): string => `https://explorer.solana.com/tx/${signature}${cluster === 'devnet' ? '?cluster=devnet' : ''}`;

/** Seconds between two ISO times as a short phrase, or null when either is missing. */
export function gapBetween(a: string | null, b: string | null): string | null {
  const t = elapsedSince(a, b);
  return t ? t.replace('+', '') : null;
}

/** The cluster the explorer links point at, from the configured RPC (devnet unless it says otherwise). */
export function clusterOf(rpcUrl: string): 'devnet' | 'mainnet-beta' {
  return /devnet|testnet|localhost|127\.0\.0\.1/i.test(rpcUrl) ? 'devnet' : 'mainnet-beta';
}

const phrase = (seconds: number): string => {
  const s = Math.max(0, Math.round(seconds));
  if (s < 90) return `${s} s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  if (s < 172800) return `${Math.round(s / 360) / 10} h`;
  return `${Math.round(s / 8640) / 10} d`;
};

/** The timings a reader scans in the list, each measured between two recorded moments; null when either end was not recorded. */
export function listTimings(r: Pick<ReplayListRow, 'window' | 'firstOrderAt' | 'clearedAt' | 'finalizedAt'>) {
  const secs = (fromUnix: string | null, toIso: string | null) => (fromUnix && toIso ? (Date.parse(toIso) - Number(fromUnix) * 1000) / 1000 : null);
  const between = (aIso: string | null, bIso: string | null) => (aIso && bIso ? (Date.parse(bIso) - Date.parse(aIso)) / 1000 : null);
  const a = secs(r.window.openTs, r.firstOrderAt);
  const b = secs(r.window.closeTs, r.clearedAt);
  const c = between(r.clearedAt, r.finalizedAt);
  return {
    firstOrderAfterOpen: a === null ? null : phrase(a),
    clearedAfterClose: b === null ? null : phrase(b),
    finalizedAfterCleared: c === null ? null : phrase(c),
  };
}
