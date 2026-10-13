// Mint safety for the API: the token-safety package's detection, read through the API's own account
// reader, cached, retried when the RPC rate limits, and turned into plain-language verdicts.
//
// Policy (the package's own severities, nothing added here):
//   block    -> a cross cannot be created on this mint (create-cross answers 422 with the reason)
//   halt     -> creation is allowed with a warning; no cross can print while the condition holds
//   disclose -> creation is allowed; the issuer power is listed so every bidder sees it
//
// The assessment time is this server's wall clock (the API has no Clock sysvar read); it only matters for a
// scheduled display-multiplier change, which the package treats as a halt inside a seven-day window.
import type { Address } from '@solana/kit';
import { type Level, LEVEL_OF, type Risk, type Verdict, assessMintAccount, bySeverity, summaryOf, verdictOf } from '@opening-cross/token-safety';
import { RequestError } from './tx.js';

export type RiskView = { code: string; severity: Risk['severity']; level: Level; message: string; holder?: string };

export type SafetyView = {
  mint: Address;
  tokenProgram: Address;
  decimals: number;
  supply: bigint;
  /** Display multiplier in force at `asOf`; 1 when the mint has none. */
  uiMultiplier: number;
  verdict: Verdict;
  /** False when any risk is a blocker or a halt (the package's `crossable`). */
  crossable: boolean;
  summary: string;
  /** Worst first. */
  risks: RiskView[];
  asOf: bigint;
  checkedAt: string;
  clock: 'api wall clock';
};

type Account = { data: Uint8Array; owner: Address } | null;

export type SafetyOptions = {
  account: (a: Address) => Promise<Account>;
  /** Milliseconds since epoch; injected by tests. */
  now?: () => number;
  /** How long a verdict is reused (default 30 s). A mint can be paused at any moment, so this stays short. */
  ttlMs?: number;
  /** Reads per mint before giving up on an RPC that keeps answering 429 or dropping the connection (default 4). */
  attempts?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Upper bound on cached mints (default 1000). */
  capacity?: number;
};

/** Rate limits and dropped connections: the upstream is busy, not the request wrong. Same test the API's error handler applies. */
export const isTransient = (e: unknown): boolean =>
  /\b429\b|HTTP error|fetch failed|ETIMEDOUT|ECONNRESET/.test(`${String(e)} ${JSON.stringify((e as { context?: unknown })?.context ?? {})}`);

export function present(report: ReturnType<typeof assessMintAccount>, checkedAt: Date): SafetyView {
  const risks = bySeverity(report.risks);
  const verdict = verdictOf(risks);
  return {
    mint: report.mint,
    tokenProgram: report.tokenProgram,
    decimals: report.decimals,
    supply: report.supply,
    uiMultiplier: report.uiMultiplier,
    verdict,
    crossable: report.crossable,
    summary: summaryOf(verdict),
    risks: risks.map((r) => ({ code: r.code, severity: r.severity, level: LEVEL_OF[r.severity], message: r.message, ...(r.holder && { holder: r.holder }) })),
    asOf: report.asOf,
    checkedAt: checkedAt.toISOString(),
    clock: 'api wall clock',
  };
}

export function createSafety(o: SafetyOptions) {
  const now = o.now ?? Date.now;
  const ttl = o.ttlMs ?? 30_000;
  const attempts = o.attempts ?? 4;
  const capacity = o.capacity ?? 1000;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const cache = new Map<string, { at: number; value: Promise<SafetyView> }>();

  async function read(mint: Address): Promise<SafetyView> {
    let account: Account = null;
    for (let attempt = 1; ; attempt++) {
      try {
        account = await o.account(mint);
        break;
      } catch (e) {
        if (attempt >= attempts || !isTransient(e)) throw e;
        await sleep(250 * 2 ** (attempt - 1));
      }
    }
    if (!account) throw new RequestError(404, `mint ${mint} does not exist on chain`);
    const at = new Date(now());
    try {
      return present(assessMintAccount(mint, account, BigInt(Math.floor(at.getTime() / 1000))), at);
    } catch (e) {
      // A foreign owner or bytes that do not decode as a mint: the caller named something that is not a token mint.
      throw new RequestError(422, `${mint} is not a token mint: ${(e as Error).message}`);
    }
  }

  /** The verdict for a mint, reused for `ttlMs`. Concurrent callers share one read; a failed read is not cached. */
  function get(mint: Address): Promise<SafetyView> {
    const hit = cache.get(mint);
    if (hit && now() - hit.at < ttl) return hit.value;
    const value = read(mint);
    cache.set(mint, { at: now(), value });
    if (cache.size > capacity) cache.delete(cache.keys().next().value as string);
    value.catch(() => {
      if (cache.get(mint)?.value === value) cache.delete(mint);
    });
    return value;
  }

  return { get };
}

export type SafetyGate = {
  /** Blockers: the cross cannot be created. */
  blockers: RiskView[];
  /** Halts and disclosures: the cross can be created; the creator is told. */
  warnings: RiskView[];
};

/** Splits a verdict by the package's policy. Pure. */
export function gate(v: SafetyView): SafetyGate {
  return { blockers: v.risks.filter((r) => r.level === 'blocker'), warnings: v.risks.filter((r) => r.level !== 'blocker') };
}
