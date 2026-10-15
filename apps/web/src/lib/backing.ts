// The backing watchdog (F6; ADR-0655): what GET /v1/assets/:mint/backing serves, the words a holder reads, and the forms of the issuer's and the attester's
// screens. Pure and free of React. Integers that can exceed 2^53 are decimal strings; times are Unix seconds.
//
// Rules of the program (programs/cross_backing, docs/evidence/W3D-F6.md): an issuer opts an asset in once (the attester it trusts, the coverage it commits to,
// 1% to 200% of the live supply, and the longest age of a statement, one minute to thirty days). The asset's halt state must name the watchdog as its venue signer.
// The attester posts statements; anyone may `check`, which halts the asset through cross_core when the statement is missing, stale or short of the live supply. A fresh
// statement does not lift a halt: only a printing resume cross does. The chain proves that a claim exists, is fresh, covers the supply and was signed by the named key;
// it proves nothing about what a custodian holds.
import type { ReleaseNote } from './new-programs';
import { formatAtoms, parseAtoms, shortAddress } from './units';

export type Verdict = 'Backed' | 'Missing' | 'Stale' | 'Short';
export type BackingRead = {
  mint: string;
  optedIn: boolean;
  policy: { address: string; attester: string; minCoverageBps: number; maxAgeSecs: string } | null;
  attestation: { backingAtoms: string; postedTs: string; ageSecs: string; freshUntil: string } | null;
  supply: string | null;
  required?: string | null;
  coverageBps?: string | null;
  verdict?: Verdict | null;
  haltsOnNextCheck?: boolean;
  watchdog: string;
  halt: { halted: boolean; reason: string; sinceTs?: string; resumedBy?: string | null } | null;
  release: ReleaseNote;
  note?: string;
};
export type PoliciesRead = { policies: { mint: string; policy: string; attester: string; minCoverageBps: number; maxAgeSecs: number; lastBackingAtoms: string | null; lastPostedTs: number | null }[]; release: ReleaseNote; note?: string };

export const bpsPct = (bps: number | string): string => `${(Number(bps) / 100).toFixed(Number(bps) % 100 === 0 ? 0 : 2)}%`;

export function ageText(secs: number): string {
  const s = Math.max(0, Math.floor(secs));
  if (s < 90) return `${s} seconds`;
  if (s < 5_400) return `${Math.round(s / 60)} minutes`;
  if (s < 129_600) return `${Math.round(s / 3_600)} hours`;
  return `${Math.round(s / 86_400)} days`;
}

export type Badge = { tone: 'ok' | 'block' | 'warn' | 'info'; title: string; lines: string[] };

/** The state of an asset's backing in words: the badge title, and what it means for trading. */
export function badgeOf(b: BackingRead, decimals: number, now: number): Badge {
  if (!b.optedIn) return { tone: 'info', title: 'No backing policy', lines: [b.note ?? 'This asset has not opted in to the backing watchdog, so nothing halts it for missing backing.'] };
  const p = b.policy!;
  const halted = b.halt?.halted === true;
  const lines: string[] = [];
  const f = (v: string | null | undefined) => (v == null ? 'unknown' : formatAtoms(BigInt(v), decimals));
  if (b.verdict === 'Backed') {
    lines.push(`The latest statement, ${ageText(now - Number(b.attestation!.postedTs))} old, covers ${bpsPct(b.coverageBps ?? '0')} of the live supply (${f(b.attestation!.backingAtoms)} against ${f(b.supply)}); the issuer committed to ${bpsPct(p.minCoverageBps)}.`);
    lines.push(`It stays fresh until ${stamp(b.attestation!.freshUntil)}. After that, anyone can run the check and the asset halts.`);
    if (halted) lines.push('The asset is halted all the same: a fresh statement does not lift a halt. Only a printing resume cross does.');
    return { tone: halted ? 'warn' : 'ok', title: 'Backed', lines };
  }
  const why: Record<string, string> = {
    Missing: 'No statement has been posted, so the backing cannot be verified.',
    Stale: `The latest statement is older than the ${ageText(Number(p.maxAgeSecs))} the policy allows${b.attestation ? ` (posted ${ageText(now - Number(b.attestation.postedTs))} ago)` : ''}.`,
    Short: `The latest statement covers ${bpsPct(b.coverageBps ?? '0')} of the live supply, below the ${bpsPct(p.minCoverageBps)} the issuer committed to (${f(b.attestation?.backingAtoms)} against ${f(b.required ?? null)} required).`,
  };
  lines.push(why[b.verdict ?? 'Missing'] ?? 'The backing could not be verified.');
  if (halted) lines.push(`The asset is halted${b.halt?.sinceTs ? ` since ${stamp(b.halt.sinceTs)}` : ''}. A fresh statement does not lift it: only a printing resume cross does.`);
  else lines.push('The asset is not halted yet. The next check, which anyone can run and the keeper runs, halts it.');
  return { tone: 'block', title: b.verdict === 'Stale' ? 'Statement stale' : b.verdict === 'Short' ? 'Under-backed' : 'Unbacked', lines };
}

export function stamp(secs: string | number): string {
  return `${new Date(Number(secs) * 1000).toISOString().replace('T', ' ').slice(0, 16)} UTC`;
}

// ---------------------------------------------------------------------------------------------------- forms

export type PolicyForm = { attester: string; coveragePct: string; ageValue: string; ageUnit: 'minutes' | 'hours' | 'days' };
export const EMPTY_POLICY: PolicyForm = { attester: '', coveragePct: '100', ageValue: '24', ageUnit: 'hours' };
export type PolicyErrors = Partial<Record<keyof PolicyForm, string>>;
const UNIT_SECS = { minutes: 60, hours: 3_600, days: 86_400 } as const;

/** The body of POST /v1/tx/backing-create-policy. The policy is permanent, so its bounds (1% to 200%, one minute to thirty days) are checked first. */
export function buildPolicy(f: PolicyForm, authority: string | null, mint: string, isAddr: (a: string) => boolean): { body: Record<string, unknown> | null; errors: PolicyErrors } {
  const errors: PolicyErrors = {};
  if (!isAddr(f.attester.trim())) errors.attester = 'This is not a Solana address.';
  const bps = /^\d{1,3}(\.\d{1,2})?$/.test(f.coveragePct.trim()) ? Math.round(Number(f.coveragePct.trim()) * 100) : null;
  if (bps === null || bps < 100 || bps > 20_000) errors.coveragePct = 'Coverage is 1 to 200 percent of the live supply.';
  const n = /^\d{1,7}$/.test(f.ageValue.trim()) ? Number(f.ageValue.trim()) : null;
  const secs = n === null ? null : n * UNIT_SECS[f.ageUnit];
  if (secs === null || secs < 60 || secs > 2_592_000) errors.ageValue = 'A statement may be at most 1 minute to 30 days old.';
  if (Object.keys(errors).length > 0 || !authority || bps === null || secs === null) return { body: null, errors };
  return { body: { authority, mint, attester: f.attester.trim(), minCoverageBps: bps, maxAgeSecs: secs }, errors };
}

/** The body of POST /v1/tx/backing-attest from a figure typed in whole tokens of the asset. */
export function buildAttest(amount: string, attester: string | null, mint: string, decimals: number | null): { body: Record<string, unknown> | null; error?: string } {
  if (decimals === null) return { body: null, error: 'The asset’s decimals have not been read yet.' };
  const v = parseAtoms(amount, decimals);
  if (amount.trim() === '' || v === null) return { body: null, ...(amount.trim() === '' ? {} : { error: `A number of tokens with at most ${decimals} decimals.` }) };
  if (!attester) return { body: null };
  return { body: { attester, mint, backingAtoms: v.toString() } };
}

export const who = (a: string | null | undefined): string => (a ? shortAddress(a) : 'nobody');
