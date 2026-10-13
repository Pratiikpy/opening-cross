// Backing of real-asset tokens (PRODUCT_FEATURES F6). The API judges each token's signed backing attestation
// (GET /v1/integrity/backing); this check turns a token that is no longer verified into a finding, and says plainly what it does NOT do.
//
// It does not pause anything. The program has one pause, and it is protocol-wide: pausing every market because one asset's
// attestation went stale would be a larger harm than the one it answers. A pause for one asset needs a program change (a per-mint
// pause), which is recorded as the gap; until then the finding is a warning that a person acts on.
import type { Check, Finding } from '../types.js';

export type BackingToken = {
  readonly mint: string;
  readonly status: 'verified' | 'stale' | 'undercollateralised' | 'unverifiable';
  readonly reasons: readonly string[];
  readonly coverageBps: number | null;
  readonly ageSecs: number | null;
  readonly custodian: string | null;
  readonly liveCross: boolean;
};

/** `feed` returns the tokens that have published a backing attestation, with the API's verdict on each. */
export function backingStatus(feed: () => Promise<readonly BackingToken[]>): Check {
  return {
    name: 'backing-status',
    async run() {
      const out: Finding[] = [];
      for (const t of await feed()) {
        if (t.status === 'verified') continue;
        out.push({
          check: 'backing-status',
          subject: t.mint,
          severity: 'warning',
          message: `${t.mint} is ${t.status}${t.liveCross ? ' and has a live cross' : ''}: ${t.reasons[0] ?? 'no reason given'}. Nothing was paused: the program can only pause the whole protocol.`,
          evidence: { mint: t.mint, status: t.status, liveCross: t.liveCross, coverageBps: t.coverageBps, ageSecs: t.ageSecs, custodian: t.custodian },
        });
      }
      return out;
    },
  };
}

/** Reads the feed from an Opening Cross API. */
export function backingFeedFromApi(baseUrl: string, fetchImpl: typeof fetch = fetch): () => Promise<readonly BackingToken[]> {
  return async () => {
    const res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/v1/integrity/backing`, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`the backing feed answered HTTP ${res.status}`);
    const j = (await res.json()) as { tokens?: BackingToken[] };
    if (!Array.isArray(j.tokens)) throw new Error('the backing feed has no tokens list');
    return j.tokens;
  };
}
