// Gate reads and the test attester, over the Opening Cross API (services/api/src/routes/gate.ts) and the devnet test attester
// (services/identity-attester). Nothing here is stored: every answer is read from the chain behind the API.
import { API_URL } from './api';

export const ATTESTER_URL: string | null = process.env.NEXT_PUBLIC_ATTESTER_URL ?? null;

export type GateRoute = { kind: 'allowlist' | 'attestation' | 'authority'; detail: string };

export type Gate = {
  mint: string;
  config: string | null;
  authority?: string;
  mode?: 'Allowlist' | 'Open';
  allowlistRoot?: string | null;
  sas?: { credential: string; schema: string } | null;
  routes?: GateRoute[];
  crosses: string[];
  error?: string;
};

export type ReasonCode =
  | 'CROSS_HAS_NO_GATE'
  | 'HAS_PASS'
  | 'GATE_CONFIG_MISSING'
  | 'NOT_ON_ALLOWLIST'
  | 'ALLOWLIST_NOT_PUBLISHED'
  | 'NO_ATTESTATION'
  | 'ATTESTATION_EXPIRED'
  | 'AUTHORITY_GRANT_ONLY'
  | 'CLAIMABLE_BY_ALLOWLIST'
  | 'CLAIMABLE_BY_ATTESTATION'
  | 'PASS_BACKING_LAPSED';

export type Reason = { code: ReasonCode; rule: string; message: string; fix: string | null };

export type Claim = { route: 'allowlist' | 'attestation'; endpoint: string; body: { mint: string; owner: string; route: string } };

export type Standing = {
  hasPass: boolean;
  pass: string;
  allowlist: { configured: boolean; published: boolean; listed: boolean | null };
  sas: { configured: boolean; credential: string | null; schema: string | null; attestation: string | null; state: 'missing' | 'foreign' | 'expired' | 'live' | null; expiry: string | null };
  claim: Claim | null;
  reasons: Reason[];
};

export type GateDetail = Omit<Gate, 'crosses'> & { standing?: Standing };

export type Eligibility = {
  cross: string;
  wallet: string;
  crossState: 'Live' | 'Cleared' | 'NoPrint' | 'Finalized';
  acceptingOrders: boolean;
  gated: boolean;
  gateMint: string | null;
  eligible: boolean;
  canClaim: boolean;
  claim?: Claim | null;
  sas?: Standing['sas'];
  allowlist?: Standing['allowlist'];
  reasons: Reason[];
};

export type Result<T> = { ok: true; data: T } | { ok: false; error: string };

async function call<T>(url: string, init?: RequestInit): Promise<Result<T>> {
  try {
    const res = await fetch(url, { cache: 'no-store', ...init });
    const body = (await res.json()) as T & { error?: string };
    if (!res.ok) return { ok: false, error: body.error ?? `HTTP ${res.status}` };
    return { ok: true, data: body };
  } catch {
    return { ok: false, error: 'The service could not be reached.' };
  }
}

export const loadGates = () => call<{ scannedCrosses: number; gates: Gate[] }>(`${API_URL}/v1/gates`);
export const loadGate = (mint: string, wallet?: string) => call<GateDetail>(`${API_URL}/v1/gates/${mint}${wallet ? `?wallet=${wallet}` : ''}`);
export const loadEligibility = (cross: string, wallet: string) => call<Eligibility>(`${API_URL}/v1/eligibility/${cross}/${wallet}`);

export type AllowlistRoot = { mint: string; root: string; count: number; duplicates: number; invalid: { entry: string; position: number }[]; invalidCount: number };
export const previewAllowlistRoot = (mint: string, addresses: string) =>
  call<AllowlistRoot>(`${API_URL}/v1/gates/allowlist-root`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mint, addresses }) });

export const publishAllowlist = (mint: string, addresses: string) =>
  call<{ mint: string; root: string; count: number; published: true }>(`${API_URL}/v1/gates/${mint}/allowlist`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ addresses }) });

export type AttesterInfo = { label: string; attester: string; credential: string; schema: string; check: string; notChecked: string[]; attestationLifetimeSeconds: number };
export const loadAttester = () => (ATTESTER_URL ? call<AttesterInfo>(`${ATTESTER_URL}/v1/attester`) : Promise.resolve<Result<AttesterInfo>>({ ok: false, error: 'No attester is configured for this deployment.' }));
export const loadChallenge = (wallet: string) => call<{ wallet: string; issuedAt: number; message: string }>(`${ATTESTER_URL}/v1/attester/challenge?wallet=${wallet}`);
export const submitAttestation = (wallet: string, issuedAt: number, signatureB64: string) =>
  call<{ attestation: string; expiry: string; reused: boolean; signature: string | null; label: string }>(`${ATTESTER_URL}/v1/attester/attest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ wallet, issuedAt, signature: signatureB64 }),
  });

export const bytesToBase64 = (b: Uint8Array) => btoa(Array.from(b, (x) => String.fromCharCode(x)).join(''));

/** Plain wording for the reasons the API returns; the API's own `message` is the long form. */
export const REASON_TITLE: Record<ReasonCode, string> = {
  CROSS_HAS_NO_GATE: 'No gate',
  HAS_PASS: 'You hold a pass',
  GATE_CONFIG_MISSING: 'Gate not set up',
  NOT_ON_ALLOWLIST: 'Not on the allowlist',
  ALLOWLIST_NOT_PUBLISHED: 'Allowlist not published',
  NO_ATTESTATION: 'No attestation',
  ATTESTATION_EXPIRED: 'Attestation expired',
  AUTHORITY_GRANT_ONLY: 'Passes are granted by the issuer',
  CLAIMABLE_BY_ALLOWLIST: 'You can claim a pass (allowlist)',
  CLAIMABLE_BY_ATTESTATION: 'You can claim a pass (attestation)',
  PASS_BACKING_LAPSED: 'The attestation behind your pass lapsed',
};

/** Tone of a reason: good news, a blocker, or a warning. */
export const REASON_TONE: Record<ReasonCode, 'good' | 'block' | 'warn'> = {
  CROSS_HAS_NO_GATE: 'good',
  HAS_PASS: 'good',
  GATE_CONFIG_MISSING: 'block',
  NOT_ON_ALLOWLIST: 'block',
  ALLOWLIST_NOT_PUBLISHED: 'block',
  NO_ATTESTATION: 'block',
  ATTESTATION_EXPIRED: 'block',
  AUTHORITY_GRANT_ONLY: 'block',
  CLAIMABLE_BY_ALLOWLIST: 'warn',
  CLAIMABLE_BY_ATTESTATION: 'warn',
  PASS_BACKING_LAPSED: 'warn',
};
