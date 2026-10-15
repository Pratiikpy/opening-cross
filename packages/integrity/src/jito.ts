// Jito bundle evidence for the organic-volume measure (F2). A Jito bundle is up to five transactions that land together or not at all, and one tipper pays for it. Two
// bidders whose orders were placed in the same transaction, or in a bundle one of them paid for, did not act independently: somebody assembled both. That is a stronger link than a
// shared first funder, and it is invisible to a funding trace, which is why the organic-volume measure takes it as an extra source of links.
//
// What is used, and how far it can be trusted:
//   * The eight tip accounts are program-derived addresses of Jito's tip-payment program (seeds `TIP_ACCOUNT_0` .. `TIP_ACCOUNT_7`). They are derived here, never typed, and the live
//     check (`scripts/jito-live.ts`) compares them with the block engine's own `getTipAccounts` and with the owner of each account on chain.
//   * Which bundle a transaction landed in comes from Jito's public bundle explorer (`bundles.jito.wtf/api/v1/bundles/transaction/<signature>`). That API is the one behind
//     explorer.jito.wtf. It is not a documented or versioned interface, and it keeps about seven days of bundles (measured 2026-10-15: the oldest bundle returned was seven days
//     old). A transaction older than the window is reported `unknown`, never `not-bundled`: absence of a record is only evidence of absence while the record would still exist.
//     Because the window is short, a final answer is kept in a `PlacementStore` the first time it is read, and a cross is best watched while it is live.
//   * A lookup that fails (network, rate limit, unexpected body) is `unknown` with the reason. It is never read as "not bundled".
//   * Who paid for a bundle is read from the transactions (the source of the tip transfer), not only from the explorer's `tippers`, which lists fee payers: a relay that sponsors a
//     user's fees is listed as the tipper while the user's wallet pays the lamports (3 of 40 live bundles).
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { type Address, address, getProgramDerivedAddress, getUtf8Encoder } from '@solana/kit';
import type { RpcLike } from './types.js';

/** Jito's tip-payment program. Cross-checked live against the block engine's tip accounts (see scripts/jito-live.ts). */
export const JITO_TIP_PAYMENT_PROGRAM: Address = address('T1pyyaTNZsKv2WcRAB8oVnk93mLJw2XzjtVYqCsaHqt');
export const JITO_TIP_ACCOUNT_COUNT = 8;
/** The explorer's retention, with a margin: older transactions are `unknown`. */
export const EXPLORER_RETENTION_SECS = 6 * 86_400 + 18 * 3_600;
export const EXPLORER_BASE = 'https://bundles.jito.wtf';

let tipCache: Promise<readonly Address[]> | undefined;
/** The eight tip accounts, derived from the tip-payment program. */
export function jitoTipAccounts(): Promise<readonly Address[]> {
  tipCache ??= Promise.all(
    Array.from({ length: JITO_TIP_ACCOUNT_COUNT }, async (_, i) => (await getProgramDerivedAddress({ programAddress: JITO_TIP_PAYMENT_PROGRAM, seeds: [getUtf8Encoder().encode(`TIP_ACCOUNT_${i}`)] }))[0]),
  );
  return tipCache;
}

interface ParsedIx {
  program?: string;
  parsed?: { type?: string; info?: Record<string, unknown> };
}
export interface ParsedTransaction {
  blockTime: number | null;
  slot?: number;
  meta: { err: unknown; innerInstructions?: { instructions: ParsedIx[] }[] } | null;
  transaction: { message: { instructions: ParsedIx[]; accountKeys?: ({ pubkey: string; signer?: boolean } | string)[] }; signatures?: string[] };
}

export interface TipPayment {
  from: string;
  lamports: bigint;
  /** The tip accounts paid, in the order seen. */
  to: string[];
}

/** The lamports a transaction paid to Jito tip accounts, from its system-program transfers (top level and inner). Null when it paid none. */
export function tipIn(tx: ParsedTransaction, tips: ReadonlySet<string>): TipPayment | null {
  const all: ParsedIx[] = [...tx.transaction.message.instructions, ...(tx.meta?.innerInstructions ?? []).flatMap((i) => i.instructions)];
  let from: string | null = null;
  let lamports = 0n;
  const to: string[] = [];
  for (const ix of all) {
    if (ix.program !== 'system' || ix.parsed?.type !== 'transfer' || !ix.parsed.info) continue;
    const i = ix.parsed.info;
    if (typeof i.destination !== 'string' || !tips.has(i.destination) || typeof i.source !== 'string') continue;
    const v = BigInt(String(i.lamports ?? 0));
    if (v <= 0n) continue;
    from ??= i.source;
    lamports += v;
    to.push(i.destination);
  }
  return from === null ? null : { from, lamports, to };
}

// ------------------------------------------------------------------------------------------------------------ explorer

export type BundleLookup = { status: 'bundled'; bundleId: string } | { status: 'not-bundled' } | { status: 'unknown'; why: string };

export interface ExplorerDeps {
  fetch?: typeof fetch;
  base?: string;
  timeoutMs?: number;
  now?: () => number;
}

async function getJson(url: string, d: ExplorerDeps): Promise<{ status: number; body: unknown }> {
  const res = await (d.fetch ?? fetch)(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(d.timeoutMs ?? 10_000) });
  const text = await res.text();
  if (text.length > 1_000_000) throw new Error('the explorer answered more than 1 MB');
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* a non-JSON body is handled by the caller from the status */
  }
  return { status: res.status, body };
}

/**
 * Which bundle a transaction landed in. `blockTime` (unix seconds) is the transaction's own time: a transaction older than the explorer's retention is `unknown`, because
 * the explorer would have no record of it whether or not it was bundled.
 */
export async function bundleOf(signature: string, blockTime: number | null, d: ExplorerDeps = {}): Promise<BundleLookup> {
  const now = (d.now ?? (() => Math.floor(Date.now() / 1000)))();
  if (blockTime !== null && now - blockTime > EXPLORER_RETENTION_SECS) return { status: 'unknown', why: `the transaction is ${Math.floor((now - blockTime) / 86_400)} days old and the explorer keeps about seven days` };
  let r: { status: number; body: unknown };
  try {
    r = await getJson(`${d.base ?? EXPLORER_BASE}/api/v1/bundles/transaction/${encodeURIComponent(signature)}`, d);
  } catch (e) {
    return { status: 'unknown', why: `the explorer did not answer: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (r.status === 200 && Array.isArray(r.body) && r.body.length > 0) {
    const id = (r.body[0] as { bundle_id?: unknown }).bundle_id;
    return typeof id === 'string' && /^[0-9a-f]{64}$/.test(id) ? { status: 'bundled', bundleId: id } : { status: 'unknown', why: 'the explorer answered without a bundle id' };
  }
  const err = r.body && typeof r.body === 'object' ? (r.body as { error?: unknown }).error : undefined;
  if (err === 'Bundle not found') return blockTime === null ? { status: 'unknown', why: 'the transaction has no block time, so its age against the explorer window is not known' } : { status: 'not-bundled' };
  if (r.status === 429) return { status: 'unknown', why: 'the explorer is rate limiting' };
  return { status: 'unknown', why: `the explorer answered HTTP ${r.status}${typeof err === 'string' ? `: ${err.slice(0, 80)}` : ''}` };
}

export interface BundleInfo {
  bundleId: string;
  slot: number;
  validator: string;
  tippers: string[];
  landedTipLamports: bigint;
  signatures: string[];
}

/** What the explorer records about one bundle, or null when it has none. */
export async function bundleInfo(bundleId: string, d: ExplorerDeps = {}): Promise<BundleInfo | null> {
  const r = await getJson(`${d.base ?? EXPLORER_BASE}/api/v1/bundles/bundle/${encodeURIComponent(bundleId)}`, d);
  if (r.status !== 200 || !Array.isArray(r.body) || r.body.length === 0) return null;
  const b = r.body[0] as Record<string, unknown>;
  if (b.bundleId !== bundleId || !Array.isArray(b.txSignatures) || !Array.isArray(b.tippers)) return null;
  return { bundleId, slot: Number(b.slot), validator: String(b.validator), tippers: b.tippers.map(String), landedTipLamports: BigInt(String(b.landedTipLamports ?? 0)), signatures: b.txSignatures.map(String) };
}

// ------------------------------------------------------------------------------------------------------ order evidence

export interface PlacedOrder {
  owner: string;
  /** The order account, from which the placing transaction is found. */
  orderAddress: string;
}

export interface Placement {
  owner: string;
  orderAddress: string;
  signature: string | null;
  slot: number | null;
  blockTime: number | null;
  bundle: BundleLookup | { status: 'no-transaction'; why: string };
  /**
   * For a bundled placement: the wallets that paid a tip in the bundle (the explorer's listed tippers and the sources of the tip transfers read from the transactions). Kept with
   * the placement because the explorer forgets the bundle after about seven days.
   */
  payers?: string[];
}

/** Where final answers are kept between runs. A cross watched while it is live keeps its bundle evidence after the explorer has forgotten it. */
export interface PlacementStore {
  get(orderAddress: string): Placement | null;
  set(p: Placement): void;
}

export class MemoryPlacementStore implements PlacementStore {
  protected readonly m = new Map<string, Placement>();
  get(a: string) {
    return this.m.get(a) ?? null;
  }
  set(p: Placement) {
    this.m.set(p.orderAddress, p);
  }
}

/** A placement store backed by an append-only JSON-lines file, so a watcher that restarts keeps what it has seen. A line that does not parse is skipped. */
export class FilePlacementStore extends MemoryPlacementStore {
  readonly skippedLines: number;
  constructor(readonly path: string) {
    super();
    let skipped = 0;
    if (existsSync(path)) {
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const p = JSON.parse(line) as Placement;
          if (typeof p.orderAddress !== 'string' || typeof p.owner !== 'string' || !p.bundle) throw new Error('not a placement');
          this.m.set(p.orderAddress, p);
        } catch {
          skipped += 1;
        }
      }
    } else mkdirSync(dirname(path), { recursive: true });
    this.skippedLines = skipped;
  }
  override set(p: Placement) {
    if (this.m.has(p.orderAddress)) return;
    super.set(p);
    appendFileSync(this.path, `${JSON.stringify(p)}\n`);
  }
}

/** The oldest successful transaction that touched an order account: the one that created it. Null when none is found or the history is longer than one page. */
export async function placingTransaction(rpc: RpcLike, orderAddress: string): Promise<{ signature: string; slot: number; blockTime: number | null } | null> {
  const sigs = await rpc.call<{ signature: string; slot: number; err: unknown; blockTime: number | null }[]>('getSignaturesForAddress', [orderAddress, { limit: 1000, commitment: 'confirmed' }]);
  if (sigs.length === 0 || sigs.length >= 1000) return null;
  for (let i = sigs.length - 1; i >= 0; i--) {
    const s = sigs[i]!;
    if (!s.err) return { signature: s.signature, slot: s.slot, blockTime: s.blockTime };
  }
  return null;
}

/** The wallets that paid a Jito tip in any of these transactions, read from the transactions. A transaction that cannot be read contributes nothing. */
async function tipSources(rpc: RpcLike, signatures: readonly string[]): Promise<string[]> {
  const tips = new Set<string>(await jitoTipAccounts());
  const out = new Set<string>();
  for (const sig of signatures) {
    try {
      const tx = await rpc.call<ParsedTransaction | null>('getTransaction', [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }]);
      const t = tx && tipIn(tx, tips);
      if (t) out.add(t.from);
    } catch {
      /* an unreadable transaction adds no evidence */
    }
  }
  return [...out];
}

export interface CoordinationLink {
  a: string;
  b: string;
  why: string;
  /**
   * same-transaction: one transaction carried both orders, so both owners signed it.
   * same-bundle: both orders landed in one bundle and one of the two owners paid its tip, so one bidder paid to land the other's transaction.
   * bundle-by-third-party: both orders landed in one bundle whose tip was paid by somebody who is neither bidder (a bot, a relay, a searcher). Bundles with more than one signer
   *   are ordinary traffic (22 of 40 multi-transaction bundles sampled on mainnet on 2026-10-15), so this is reported and never merged into a cluster.
   */
  kind: 'same-transaction' | 'same-bundle' | 'bundle-by-third-party';
}

export interface CoordinationReport {
  placements: Placement[];
  /** Links strong enough to join bidders into a cluster: same transaction, or same bundle with a bidder paying the tip. */
  links: CoordinationLink[];
  /** Bidders that shared a bundle paid for by a third party: shown to a reader, not used as evidence of common control. */
  weakLinks: CoordinationLink[];
  /** Owners joined to another owner by a strong link. */
  coordinated: string[];
  /** How many placements could not be answered for, and why, so a reader sees how much of the cross was checked. */
  unknown: { count: number; reasons: string[] };
  /** How many placements the explorer positively reported as not bundled. */
  notBundled: number;
  bundled: number;
  /** Placements answered from the store rather than the network. */
  fromStore: number;
}

/**
 * Looks up where each order was placed and links owners whose orders landed together. Owners placing orders in one transaction are linked: a transaction needs every
 * signer's signature, so one party held both keys or both agreed to it. Owners whose orders share a bundle are linked when one of them paid the bundle's tip.
 *
 * A final answer (bundled with its payers, or positively not bundled) goes into `store`; an unknown one never does, so the next run asks again.
 */
export async function coordinationLinks(rpc: RpcLike, orders: readonly PlacedOrder[], d: ExplorerDeps = {}, store?: PlacementStore): Promise<CoordinationReport> {
  const placements: Placement[] = [];
  const payersOf = new Map<string, string[]>();
  let fromStore = 0;
  for (const o of orders) {
    const kept = store?.get(o.orderAddress);
    if (kept && kept.owner === o.owner && (kept.bundle.status === 'not-bundled' || (kept.bundle.status === 'bundled' && kept.payers))) {
      placements.push(kept);
      fromStore += 1;
      if (kept.bundle.status === 'bundled') payersOf.set(kept.bundle.bundleId, kept.payers!);
      continue;
    }
    let p: Awaited<ReturnType<typeof placingTransaction>>;
    try {
      p = await placingTransaction(rpc, o.orderAddress);
    } catch (e) {
      placements.push({ ...o, signature: null, slot: null, blockTime: null, bundle: { status: 'no-transaction', why: `the order's history could not be read: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}` } });
      continue;
    }
    if (!p) {
      placements.push({ ...o, signature: null, slot: null, blockTime: null, bundle: { status: 'no-transaction', why: 'no placing transaction was found for the order account' } });
      continue;
    }
    const placement: Placement = { ...o, signature: p.signature, slot: p.slot, blockTime: p.blockTime, bundle: await bundleOf(p.signature, p.blockTime, d) };
    if (placement.bundle.status === 'bundled') {
      const id = placement.bundle.bundleId;
      if (!payersOf.has(id)) {
        let info: BundleInfo | null = null;
        try {
          info = await bundleInfo(id, d);
        } catch {
          info = null;
        }
        if (info) payersOf.set(id, [...new Set([...info.tippers, ...(await tipSources(rpc, info.signatures))])]);
      }
      const payers = payersOf.get(id);
      if (payers) placement.payers = payers;
      else placement.bundle = { status: 'unknown', why: `the bundle ${id} was found but its details could not be read, so who paid for it is not known` };
    }
    if (store && (placement.bundle.status === 'not-bundled' || (placement.bundle.status === 'bundled' && placement.payers))) store.set(placement);
    placements.push(placement);
  }

  const links: CoordinationLink[] = [];
  const weak: CoordinationLink[] = [];
  const seen = new Set<string>();
  const add = (into: CoordinationLink[], l: CoordinationLink) => {
    if (l.a === l.b) return;
    const key = `${l.kind}|${[l.a, l.b].sort().join('|')}|${l.why}`;
    if (!seen.has(key)) {
      seen.add(key);
      into.push(l);
    }
  };
  const byBundle = new Map<string, Placement[]>();
  const byTx = new Map<string, Placement[]>();
  for (const p of placements) {
    if (p.signature) (byTx.get(p.signature) ?? byTx.set(p.signature, []).get(p.signature)!).push(p);
    if (p.bundle.status === 'bundled') (byBundle.get(p.bundle.bundleId) ?? byBundle.set(p.bundle.bundleId, []).get(p.bundle.bundleId)!).push(p);
  }
  for (const [sig, ps] of byTx) {
    const owners = [...new Set(ps.map((p) => p.owner))];
    for (let i = 1; i < owners.length; i++) add(links, { a: owners[0]!, b: owners[i]!, kind: 'same-transaction', why: `both placed an order in transaction ${sig}` });
  }
  for (const [id, ps] of byBundle) {
    const owners = [...new Set(ps.map((p) => p.owner))];
    if (owners.length < 2) continue;
    const payers = new Set(ps[0]!.payers ?? []);
    const paying = owners.filter((o) => payers.has(o));
    for (let i = 1; i < owners.length; i++) {
      if (paying.length > 0) add(links, { a: owners[0]!, b: owners[i]!, kind: 'same-bundle', why: `orders were placed in Jito bundle ${id}, whose tip ${paying[0]} paid` });
      else add(weak, { a: owners[0]!, b: owners[i]!, kind: 'bundle-by-third-party', why: `orders were placed in Jito bundle ${id}, tipped by ${[...payers].join(', ') || 'nobody listed'}, who placed no order here` });
    }
  }
  const coordinated = [...new Set(links.flatMap((l) => [l.a, l.b]))];
  const unknownRows = placements.filter((p) => p.bundle.status === 'unknown' || p.bundle.status === 'no-transaction');
  return {
    placements,
    links,
    weakLinks: weak,
    coordinated,
    unknown: { count: unknownRows.length, reasons: [...new Set(unknownRows.map((p) => (p.bundle as { why: string }).why))] },
    notBundled: placements.filter((p) => p.bundle.status === 'not-bundled').length,
    bundled: placements.filter((p) => p.bundle.status === 'bundled').length,
    fromStore,
  };
}
