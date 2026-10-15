// The mainnet funding trace as a job that can finish (F3, F8). On devnet a trace is a handful of calls; on mainnet a cross can have hundreds of bidders, each costing one
// `getSignaturesForAddress` and up to a few `getTransaction` calls, against public endpoints that rate limit hard (the first attempt was refused, HUMAN_TASKS H26). The pieces:
//
//   pacedRpc         spaces calls so a loop cannot hammer an endpoint, and retries a rate-limited or unreachable call with a growing wait instead of failing the whole job.
//   FileFundingCache a funding found once is final (a wallet's first SOL does not change), so each result is appended to a file the moment it is known. A job that is stopped,
//                    refused or killed resumes from the file and never repeats a call.
//   traceWallets     traces many wallets under a time budget, a few at a time, and says exactly which wallets are traced, which are not yet and why. It never turns an error into
//                    an answer: a wallet it could not read stays untraced and counts as unknown downstream.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { MemoryFundingCache, type FundingCache, traceFunding, type TraceOptions } from './funding.js';
import type { Funding, RpcLike } from './types.js';

export interface PaceOptions {
  /** Least time between the start of one call and the start of the next, in milliseconds. Default 250 (four a second); public mainnet endpoints want 1000 or more. */
  minIntervalMs?: number;
  /** Attempts per call beyond the first. Default 6. */
  retries?: number;
  /** First wait after a refusal, doubled each time up to `maxBackoffMs`. Default 1000. */
  backoffMs?: number;
  maxBackoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Called for each retry, for logging. */
  onRetry?: (info: { method: string; attempt: number; waitMs: number; reason: string }) => void;
}

/** True for the failures that waiting can fix: rate limits, timeouts, unreachable or unhealthy endpoints. */
export function isTransient(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e);
  return /rate.?limit|429|too many requests|no endpoint could answer|timed? ?out|no answer in|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|HTTP 5\d\d|unhealthy|-32005|-32029|-32014/i.test(m);
}

export function pacedRpc(rpc: RpcLike, o: PaceOptions = {}): RpcLike {
  const interval = o.minIntervalMs ?? 250;
  const retries = o.retries ?? 6;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = o.now ?? Date.now;
  let next = 0;
  // One queue for every caller, so concurrent workers share the same pace.
  let chain: Promise<void> = Promise.resolve();
  const slot = (): Promise<void> => {
    const mine = chain.then(async () => {
      const wait = next - now();
      if (wait > 0) await sleep(wait);
      next = now() + interval;
    });
    chain = mine.catch(() => undefined);
    return mine;
  };
  return {
    async call<T = unknown>(method: string, params?: unknown[]): Promise<T> {
      let wait = o.backoffMs ?? 1_000;
      for (let attempt = 0; ; attempt++) {
        await slot();
        try {
          return await rpc.call<T>(method, params);
        } catch (e) {
          if (attempt >= retries || !isTransient(e)) throw e;
          o.onRetry?.({ method, attempt: attempt + 1, waitMs: wait, reason: (e instanceof Error ? e.message : String(e)).split('\n')[0]!.slice(0, 160) });
          await sleep(wait);
          // The wait also pushes the pace forward, so a refusal slows every worker, not only the one that was refused.
          next = Math.max(next, now() + wait);
          wait = Math.min(o.maxBackoffMs ?? 30_000, wait * 2);
        }
      }
    },
  };
}

interface Line {
  wallet: string;
  funder: string | null;
  lamports: string | null;
  signature: string | null;
  blockTime: number | null;
  unknown?: Funding['unknown'];
  pagesTried?: number;
}

/** A funding cache backed by an append-only JSON-lines file. Loading skips lines that do not parse, so a write cut short by a crash costs one line, not the file. */
export class FileFundingCache implements FundingCache {
  private readonly mem = new MemoryFundingCache();
  readonly skippedLines: number;
  constructor(readonly path: string) {
    let skipped = 0;
    if (existsSync(path)) {
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const l = JSON.parse(line) as Line;
          if (typeof l.wallet !== 'string') throw new Error('no wallet');
          void this.mem.set({ wallet: l.wallet, funder: l.funder, lamports: l.lamports === null ? null : BigInt(l.lamports), signature: l.signature, blockTime: l.blockTime, ...(l.unknown ? { unknown: l.unknown } : {}), ...(l.pagesTried !== undefined ? { pagesTried: l.pagesTried } : {}) });
        } catch {
          skipped += 1;
        }
      }
    } else mkdirSync(dirname(path), { recursive: true });
    this.skippedLines = skipped;
  }
  get(wallet: string) {
    return this.mem.get(wallet);
  }
  async set(f: Funding) {
    const prev = await this.mem.get(f.wallet);
    // A funding found is final. The one answer that is not: "history too long", which a deeper read may replace (later lines win when the file is loaded).
    if (prev && !(prev.unknown === 'history-too-long' && (f.unknown !== 'history-too-long' || (f.pagesTried ?? 0) > (prev.pagesTried ?? 3)))) return;
    await this.mem.set(f);
    const line: Line = { wallet: f.wallet, funder: f.funder, lamports: f.lamports === null ? null : f.lamports.toString(), signature: f.signature, blockTime: f.blockTime, ...(f.unknown ? { unknown: f.unknown } : {}), ...(f.pagesTried !== undefined ? { pagesTried: f.pagesTried } : {}) };
    appendFileSync(this.path, `${JSON.stringify(line)}\n`);
  }
  /** Distinct wallets each funder has funded among everything cached. */
  fanout() {
    return this.mem.fanout();
  }
}

export interface TraceJobOptions extends Omit<TraceOptions, 'cache'> {
  cache: FundingCache;
  /** Wallets traced at the same time. Default 2; the pace is shared, so this does not raise the call rate. */
  concurrency?: number;
  /** Stop starting new wallets after this many milliseconds. Default: no limit. */
  budgetMs?: number;
  now?: () => number;
  onProgress?: (p: { done: number; total: number; wallet: string; outcome: 'traced' | 'cached' | 'failed' }) => void;
}

export interface TraceJobResult {
  fundings: Map<string, Funding>;
  /** Wallets with a result, split by what the result is. */
  funded: number;
  unknownHistory: number;
  /** Wallets not traced: out of budget, or every attempt failed. They are not independent, they are not known. */
  untraced: { wallet: string; why: string }[];
  fromCache: number;
  complete: boolean;
}

export async function traceWallets(rpc: RpcLike, wallets: readonly string[], o: TraceJobOptions): Promise<TraceJobResult> {
  const list = [...new Set(wallets)];
  const now = o.now ?? Date.now;
  const started = now();
  const out = new Map<string, Funding>();
  const untraced = new Map<string, string>();
  let fromCache = 0;
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < list.length) {
      const w = list[next++]!;
      if (o.budgetMs !== undefined && now() - started > o.budgetMs) {
        untraced.set(w, 'out of time budget; run the job again to continue');
        continue;
      }
      const cached = await o.cache.get(w);
      try {
        // traceFunding decides whether a cached answer is final: a "history too long" one is read again when this run is willing to read deeper.
        const f = await traceFunding(rpc, w, { ...(o.pageSize !== undefined && { pageSize: o.pageSize }), ...(o.maxPages !== undefined && { maxPages: o.maxPages }), ...(o.inspect !== undefined && { inspect: o.inspect }), ...(o.ascending && { ascending: true }), cache: o.cache });
        out.set(w, f);
        const reused = cached !== null && f === cached;
        if (reused) fromCache += 1;
        o.onProgress?.({ done: ++done, total: list.length, wallet: w, outcome: reused ? 'cached' : 'traced' });
      } catch (e) {
        untraced.set(w, (e instanceof Error ? e.message : String(e)).split('\n')[0]!.slice(0, 200));
        o.onProgress?.({ done: ++done, total: list.length, wallet: w, outcome: 'failed' });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, o.concurrency ?? 2) }, worker));
  const all = [...out.values()];
  return {
    fundings: out,
    funded: all.filter((f) => f.funder !== null).length,
    unknownHistory: all.filter((f) => f.funder === null).length,
    untraced: [...untraced].map(([wallet, why]) => ({ wallet, why })),
    fromCache,
    complete: untraced.size === 0,
  };
}
