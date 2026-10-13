// Proof of backing for real-asset tokens (F6). A token that says it is backed one-to-one by a stock, a bond or a deposit is only as
// good as the evidence, so the check is explicit about what it has: a signed attestation from a party the operator trusts, the
// amount it says is held, and how old that is. With none of those the answer is "unverifiable", never "fine".
//
// What this cannot do: prove the custodian holds what the attestation says. That is the attester's claim, and the attester is the
// party being trusted; the check shows who signed, when, and whether the number covers the supply. Choosing the trusted attesters
// is the operator's decision (docs/HUMAN_TASKS.md).
import { type Signed, verifyDocument } from '@opening-cross/attest';

export const BACKING_SCHEMA = 'opening-cross/backing-attestation/v1';
export interface BackingBody {
  readonly [k: string]: string | number | undefined;
  readonly schema: typeof BACKING_SCHEMA;
  readonly mint: string;
  /** What the custodian holds against the token, in token atoms, as a decimal string. */
  readonly reserveAtoms: string;
  /** Unix seconds the figure was true. */
  readonly asOf: number;
  readonly custodian: string;
  /** Where a reader can check the custodian's own statement. */
  readonly evidence: string;
}
export type BackingAttestation = Signed<BackingBody>;

export type BackingStatus = 'verified' | 'stale' | 'undercollateralised' | 'unverifiable';

export interface BackingResult {
  mint: string;
  status: BackingStatus;
  reasons: string[];
  /** Reserves as a share of supply in basis points, when an attestation was usable. */
  coverageBps: number | null;
  ageSecs: number | null;
  attester: string | null;
  custodian: string | null;
  evidence: string | null;
  supply: bigint;
}

export interface BackingPolicy {
  /** Signers whose attestations count. */
  trustedAttesters: ReadonlySet<string>;
  /** Oldest an attestation may be, in seconds. Default seven days. */
  maxAgeSecs?: number;
  /** Reserves required as a share of supply, in basis points. Default 10000. */
  minCoverageBps?: number;
  now: number;
}

export async function checkBacking(mint: string, supply: bigint, attestation: BackingAttestation | null, policy: BackingPolicy): Promise<BackingResult> {
  const base: BackingResult = { mint, status: 'unverifiable', reasons: [], coverageBps: null, ageSecs: null, attester: null, custodian: null, evidence: null, supply };
  if (!attestation) return { ...base, reasons: ['No backing attestation has been published for this mint.'] };
  const check = await verifyDocument(attestation as never);
  if (!check.ok) return { ...base, attester: attestation.signer, reasons: [`The attestation does not verify (${check.reason}).`] };
  const b = attestation.body;
  const known = { ...base, attester: attestation.signer, custodian: b.custodian, evidence: b.evidence };
  if (b.mint !== mint) return { ...known, reasons: [`The attestation is for ${b.mint}, not this mint.`] };
  if (!policy.trustedAttesters.has(attestation.signer)) return { ...known, reasons: [`The attestation is signed by ${attestation.signer}, which is not a trusted attester here.`] };
  const age = policy.now - b.asOf;
  if (age < -300) return { ...known, reasons: ['The attestation is dated in the future.'] };
  const reserve = BigInt(b.reserveAtoms);
  const coverage = supply === 0n ? 10_000 : Number((reserve * 10_000n) / supply);
  const maxAge = policy.maxAgeSecs ?? 7 * 86_400;
  const minCoverage = policy.minCoverageBps ?? 10_000;
  const full: BackingResult = { ...known, ageSecs: Math.max(0, age), coverageBps: coverage };
  if (coverage < minCoverage) return { ...full, status: 'undercollateralised', reasons: [`Reserves of ${reserve} cover ${coverage / 100}% of the ${supply} supply; ${minCoverage / 100}% is required.`] };
  if (age > maxAge) return { ...full, status: 'stale', reasons: [`The attestation is ${Math.floor(age / 3600)} hours old; the limit is ${Math.floor(maxAge / 3600)} hours.`] };
  return { ...full, status: 'verified', reasons: [`Reserves of ${reserve} cover ${coverage / 100}% of the supply, attested by ${attestation.signer} for ${b.custodian}, ${Math.floor(Math.max(0, age) / 3600)} hours ago.`] };
}
