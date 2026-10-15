'use client';

// The issuer's identity attester (services/identity-attester, `kyc` command), asked directly from the holder's browser.
// Recording a verification publishes the wallet's country and tier on chain, so the attester only accepts the request from
// the wallet itself: it hands out a challenge, the wallet signs it (no transaction, no cost) and the signature goes back.

/** Where the attester answers, e.g. https://attester.example.org. Unset: this deployment has no identity provider connected. */
export const KYC_ATTESTER_URL: string | null = process.env.NEXT_PUBLIC_KYC_ATTESTER_URL?.replace(/\/+$/, '') || null;

export type Challenge = { issuedAt: number; message: string };

export type Reason = { code: string; message: string };

/** What the attester said about one wallet. The first three are answers about the wallet; the rest are about the request. */
export type Attestation =
  | { kind: 'attested'; action: 'created' | 'replaced' | 'unchanged'; expiry: number; country: string | null; tier: number }
  | { kind: 'ineligible'; reasons: Reason[]; closed: boolean }
  | { kind: 'unavailable' }
  | { kind: 'rate-limited'; retryAfter: number }
  | { kind: 'refused'; message: string }
  | { kind: 'unreachable' };

async function json(res: Response): Promise<Record<string, unknown>> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** The text this wallet signs to ask for its own attestation. `null` when the attester is unreachable or takes no signed requests. */
export async function identityChallenge(wallet: string): Promise<Challenge | null> {
  if (!KYC_ATTESTER_URL) return null;
  try {
    const res = await fetch(`${KYC_ATTESTER_URL}/v1/identity/challenge?wallet=${encodeURIComponent(wallet)}`, { cache: 'no-store' });
    if (!res.ok) return null;
    const b = (await res.json()) as Partial<Challenge>;
    return typeof b.issuedAt === 'number' && typeof b.message === 'string' ? { issuedAt: b.issuedAt, message: b.message } : null;
  } catch {
    return null;
  }
}

export const bytesToBase64 = (b: Uint8Array) => btoa(Array.from(b, (x) => String.fromCharCode(x)).join(''));

/** Sends the signed challenge. Every outcome, including a refusal, comes back as data so the screen can say exactly what happened. */
export async function requestAttestation(wallet: string, issuedAt: number, signature: Uint8Array): Promise<Attestation> {
  if (!KYC_ATTESTER_URL) return { kind: 'unreachable' };
  let res: Response;
  try {
    res = await fetch(`${KYC_ATTESTER_URL}/v1/identity/attest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ wallet, issuedAt, signature: bytesToBase64(signature) }),
    });
  } catch {
    return { kind: 'unreachable' };
  }
  const b = await json(res);
  if (res.status === 429) return { kind: 'rate-limited', retryAfter: Number(res.headers.get('retry-after') ?? 10) };
  if (res.status === 503) return { kind: 'unavailable' };
  if (!res.ok) return { kind: 'refused', message: typeof b.error === 'string' ? b.error : `The attester answered HTTP ${res.status}.` };
  if (b.status === 'attested') {
    return { kind: 'attested', action: b.action as 'created' | 'replaced' | 'unchanged', expiry: Number(b.expiry), country: (b.country as string | null) ?? null, tier: Number(b.tier) };
  }
  if (b.status === 'ineligible') return { kind: 'ineligible', reasons: (b.reasons as Reason[]) ?? [], closed: b.closed === true };
  return { kind: 'refused', message: 'The attester answered with something this page does not understand.' };
}
