// What the keeper knows about an issuer's subscription (row Y8, ADR-0304, ADR-0960). The billing service records payments it has read back from the chain and says,
// for an issuer, whether a paid period covers now. A subscription buys the managed service around the program: the keeper's scheduler spawning the next cross of an
// issuer's recurring series at its own expense. It never gates the program (anyone can spawn that cross) and it never gates a user's money: settling, claiming,
// refunding, finalizing and releasing a locked fill are done for every cross the keeper is scoped to, whoever has paid.
import type { Address } from '@solana/kit';

/** The part of the billing service's `GET /v1/billing/entitlements/:issuer` answer the keeper acts on. */
export type Entitlement = {
  /** A paid period covers the time of the answer. */
  entitled: boolean;
  plan: string | null;
  /** Unix seconds the covering period ends; null when no period covers now. */
  periodEnd: number | null;
  crossesIncluded: number;
  crossesUsed: number;
  /** True when the answer is an earlier one, kept because the billing service could not be reached. */
  stale?: boolean;
};

export type EntitlementSource = (issuer: Address) => Promise<Entitlement>;

export class EntitlementError extends Error {
  override readonly name = 'EntitlementError';
}

export type BillingEntitlementOptions = {
  /** The billing service, for example `http://billing:8791`. */
  baseUrl: string;
  fetch?: typeof fetch;
  /** How long an entitled answer is reused (default 60 s). */
  ttlMs?: number;
  /** How long a not-entitled answer is reused (default 10 s): an issuer who has just paid should not wait a minute to be served. */
  negativeTtlMs?: number;
  /** How long an earlier answer may stand in for an unreachable billing service (default 24 h). An entitled answer never outlives its own period. */
  staleMs?: number;
  /** Per request (default 5 s). */
  timeoutMs?: number;
  /** Wall clock in milliseconds (a test seam). */
  now?: () => number;
};

const SCHEMA = 'opening-cross/entitlement/v1';
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/** Validates the billing answer's shape: an answer that does not say plainly whether the issuer is entitled is an error, never a guess. */
export function parseEntitlement(body: unknown): Entitlement {
  const b = body as Record<string, unknown> | null;
  if (!b || typeof b !== 'object' || b.schema !== SCHEMA || typeof b.entitled !== 'boolean') throw new EntitlementError(`the billing service did not answer with ${SCHEMA}`);
  const cur = b.current as { plan?: unknown; end?: unknown } | null | undefined;
  if (b.entitled && (!cur || typeof cur.plan !== 'string' || !Number.isSafeInteger(cur.end))) throw new EntitlementError('an entitled answer must name the plan and the end of the period');
  if (!isCount(b.crossesIncluded) || !isCount(b.crossesUsed)) throw new EntitlementError('the answer must count the crosses included and used');
  return {
    entitled: b.entitled,
    plan: b.entitled ? (cur!.plan as string) : null,
    periodEnd: b.entitled ? (cur!.end as number) : null,
    crossesIncluded: b.crossesIncluded,
    crossesUsed: b.crossesUsed,
  };
}

/**
 * Reads entitlements from the billing service over HTTP. The default time of the billing route is used (never earlier than the issuer's latest payment), so an issuer
 * is not told "not entitled" about a period that began a second ago on a chain clock that runs ahead of this machine's (W2A-Y8-billing.md).
 */
export function billingEntitlements(o: BillingEntitlementOptions): EntitlementSource {
  const fetchImpl = o.fetch ?? fetch;
  const base = o.baseUrl.replace(/\/+$/, '');
  const ttl = o.ttlMs ?? 60_000;
  const negativeTtl = o.negativeTtlMs ?? 10_000;
  const staleMs = o.staleMs ?? 24 * 3_600_000;
  const timeoutMs = o.timeoutMs ?? 5_000;
  const now = o.now ?? Date.now;
  const kept = new Map<string, { at: number; value: Entitlement }>();
  return async (issuer) => {
    const hit = kept.get(issuer);
    const t = now();
    if (hit && t - hit.at < (hit.value.entitled ? ttl : negativeTtl)) return hit.value;
    try {
      const res = await fetchImpl(`${base}/v1/billing/entitlements/${encodeURIComponent(issuer)}`, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
      if (!res.ok) throw new EntitlementError(`the billing service answered ${res.status}`);
      const value = parseEntitlement(await res.json());
      kept.set(issuer, { at: t, value });
      return value;
    } catch (e) {
      // The billing service is down or confused. An earlier answer stands in for a while; an entitled one only until its own period ends, a refusal for as long as staleMs.
      if (hit && t - hit.at < staleMs) {
        const v = hit.value;
        const lapsed = v.entitled && v.periodEnd !== null && v.periodEnd * 1000 <= t;
        return { ...v, entitled: v.entitled && !lapsed, ...(lapsed ? { plan: null, periodEnd: null } : {}), stale: true };
      }
      throw e instanceof EntitlementError ? e : new EntitlementError(`the billing service could not be reached: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
}
