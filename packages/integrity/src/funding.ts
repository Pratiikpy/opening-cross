// Where a wallet's first SOL came from, and which wallets share a source. A shared first funder is evidence of common control, not
// proof: an exchange, a faucet or a friend funds many unrelated wallets. So the clustering ignores funders that have funded many
// wallets in the population we have seen (a service, not a person), says which funders it ignored, and presents every cluster as
// "linked by", never as "the same person".
import type { Cluster, Funding, RpcLike } from './types.js';

export interface FundingCache {
  get(wallet: string): Promise<Funding | null>;
  set(f: Funding): Promise<void>;
}

export class MemoryFundingCache implements FundingCache {
  private readonly m = new Map<string, Funding>();
  async get(w: string) {
    return this.m.get(w) ?? null;
  }
  async set(f: Funding) {
    this.m.set(f.wallet, f);
  }
  /** How many distinct wallets each funder has funded among everything cached. */
  fanout(): Map<string, number> {
    const out = new Map<string, Set<string>>();
    for (const f of this.m.values()) if (f.funder) (out.get(f.funder) ?? out.set(f.funder, new Set()).get(f.funder)!).add(f.wallet);
    return new Map([...out].map(([k, v]) => [k, v.size]));
  }
}

interface ParsedIx {
  program?: string;
  parsed?: { type?: string; info?: Record<string, unknown> };
}
interface ParsedTx {
  blockTime: number | null;
  meta: { err: unknown; innerInstructions?: { instructions: ParsedIx[] }[] } | null;
  transaction: { message: { instructions: ParsedIx[] } };
}

/** The first lamports a transaction delivered to `wallet`, from its system-program instructions, top level and inner. */
export function inboundSol(tx: ParsedTx, wallet: string): { from: string; lamports: bigint } | null {
  const all: ParsedIx[] = [...tx.transaction.message.instructions, ...(tx.meta?.innerInstructions ?? []).flatMap((i) => i.instructions)];
  for (const ix of all) {
    if (ix.program !== 'system' || !ix.parsed?.info) continue;
    const t = ix.parsed.type;
    const i = ix.parsed.info;
    if ((t === 'transfer' || t === 'transferWithSeed') && i.destination === wallet && typeof i.source === 'string') {
      const lamports = BigInt(String(i.lamports ?? 0));
      if (lamports > 0n) return { from: i.source, lamports };
    }
    if ((t === 'createAccount' || t === 'createAccountWithSeed') && i.newAccount === wallet && typeof i.source === 'string') {
      const lamports = BigInt(String(i.lamports ?? 0));
      if (lamports > 0n) return { from: i.source, lamports };
    }
  }
  return null;
}

export interface TraceOptions {
  /** Signatures per page. Default 1000, the RPC maximum. */
  pageSize?: number;
  /** Pages to read looking for the start of a wallet's history. Default 3. */
  maxPages?: number;
  /** How many of the oldest transactions to inspect for an inbound transfer. Default 4. */
  inspect?: number;
  cache?: FundingCache;
}

/** Finds the first funder of a wallet. Never guesses: a wallet whose history is too long or holds no inbound transfer is reported as unknown. */
export async function traceFunding(rpc: RpcLike, wallet: string, opts: TraceOptions = {}): Promise<Funding> {
  const cached = await opts.cache?.get(wallet);
  if (cached) return cached;
  const pageSize = opts.pageSize ?? 1000;
  const maxPages = opts.maxPages ?? 3;
  const inspect = opts.inspect ?? 4;
  let before: string | undefined;
  let oldest: { signature: string; err: unknown }[] = [];
  let complete = false;
  for (let page = 0; page < maxPages; page++) {
    const sigs = await rpc.call<{ signature: string; err: unknown }[]>('getSignaturesForAddress', [wallet, { limit: pageSize, commitment: 'confirmed', ...(before ? { before } : {}) }]);
    if (sigs.length === 0 && page === 0) break;
    oldest = sigs;
    if (sigs.length < pageSize) {
      complete = true;
      break;
    }
    before = sigs[sigs.length - 1]!.signature;
  }
  const done = async (f: Funding) => {
    await opts.cache?.set(f);
    return f;
  };
  if (oldest.length === 0) return done({ wallet, funder: null, lamports: null, signature: null, blockTime: null, unknown: 'no-history' });
  if (!complete) return done({ wallet, funder: null, lamports: null, signature: null, blockTime: null, unknown: 'history-too-long' });
  for (const s of oldest.slice(-inspect).reverse()) {
    if (s.err) continue;
    const tx = await rpc.call<ParsedTx | null>('getTransaction', [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }]);
    if (!tx) continue;
    const got = inboundSol(tx, wallet);
    if (got && got.from !== wallet) return done({ wallet, funder: got.from, lamports: got.lamports, signature: s.signature, blockTime: tx.blockTime });
  }
  return done({ wallet, funder: null, lamports: null, signature: null, blockTime: null, unknown: 'no-inbound-transfer' });
}

export interface ClusterOptions {
  /** Funders known to be services (an exchange, a faucet). Wallets sharing only such a funder are not linked. */
  serviceFunders?: ReadonlySet<string>;
  /** Distinct wallets each funder has funded across everything seen, e.g. `MemoryFundingCache.fanout()` or a database count. */
  fanout?: ReadonlyMap<string, number>;
  /** A funder that has funded this many wallets or more is treated as a service. Default 25. */
  serviceFanout?: number;
  /** Basis points of supply each wallet holds, to total per cluster. */
  holdings?: ReadonlyMap<string, number>;
}

export interface ClusterResult {
  clusters: Cluster[];
  /** Wallets with no link to another. */
  alone: string[];
  /** Wallets whose funder could not be found; they are in neither list above as linked, and a reader should not take them as independent. */
  unknownFunder: string[];
  /** Funders ignored as services, with how many of the wallets looked at they funded. */
  ignoredServices: { funder: string; funded: number; why: string }[];
}

/** Groups wallets that share a first funder, or where one funded another. */
export function clusterByFunding(fundings: readonly Funding[], opts: ClusterOptions = {}): ClusterResult {
  const service = opts.serviceFunders ?? new Set<string>();
  const cutoff = opts.serviceFanout ?? 25;
  const wallets = [...new Set(fundings.map((f) => f.wallet))];
  const parent = new Map(wallets.map((w) => [w, w]));
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  const union = (a: string, b: string) => parent.set(find(a), find(b));

  const links: Cluster['links'] = [];
  const byFunder = new Map<string, Funding[]>();
  const ignored = new Map<string, { funded: number; why: string }>();
  const unknownFunder: string[] = [];
  for (const f of fundings) {
    if (!f.funder) {
      unknownFunder.push(f.wallet);
      continue;
    }
    (byFunder.get(f.funder) ?? byFunder.set(f.funder, []).get(f.funder)!).push(f);
  }
  for (const [funder, group] of byFunder) {
    const seen = opts.fanout?.get(funder) ?? group.length;
    const why = service.has(funder) ? 'listed as a service' : seen >= cutoff ? `funded ${seen} wallets, which is what a service does` : null;
    if (why) {
      ignored.set(funder, { funded: Math.max(seen, group.length), why });
      continue;
    }
    // The funder may itself be one of the wallets: then each funded wallet is linked to it.
    if (parent.has(funder)) {
      for (const f of group) {
        union(f.wallet, funder);
        links.push({ a: funder, b: f.wallet, why: `${funder} sent ${f.wallet} its first SOL (${f.lamports} lamports, tx ${f.signature})` });
      }
    }
    for (let i = 1; i < group.length; i++) {
      union(group[0]!.wallet, group[i]!.wallet);
      links.push({ a: group[0]!.wallet, b: group[i]!.wallet, why: `both received their first SOL from ${funder}` });
    }
  }
  const groups = new Map<string, string[]>();
  for (const w of wallets) (groups.get(find(w)) ?? groups.set(find(w), []).get(find(w))!).push(w);
  const clusters: Cluster[] = [];
  const alone: string[] = [];
  for (const members of groups.values()) {
    if (members.length < 2) {
      if (!unknownFunder.includes(members[0]!)) alone.push(members[0]!);
      continue;
    }
    const set = new Set(members);
    const c: Cluster = { members, links: links.filter((l) => set.has(l.a) && set.has(l.b)) };
    if (opts.holdings) c.shareBps = members.reduce((s, m) => s + (opts.holdings!.get(m) ?? 0), 0);
    clusters.push(c);
  }
  clusters.sort((a, b) => b.members.length - a.members.length);
  return { clusters, alone, unknownFunder, ignoredServices: [...ignored].map(([funder, v]) => ({ funder, ...v })) };
}
