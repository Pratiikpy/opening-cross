// The treasury console's reads and requests. The reads are the W3A routes (GET /v1/treasuries/:address/ext, /proposals, /grants, /rounds), where
// 64-bit integers arrive as decimal strings and stay strings until they are formatted. The requests are built here from forms in human units and
// refuse, in words naming the field, anything that would round. Whether the terms of an extension are acceptable is decided by `checkExtParams`,
// which the API runs when the transaction is built; `previewExt` asks it without signing.
import { isAddress } from '@solana/kit';
import { type TermsForm } from '@opening-cross/presets/treasury';
import { API_URL } from './api';
import { apiRead } from './issuer-data';
import type { Result } from './api';
import type { TreasuryDetail } from './treasury';
import { formatAtoms, parseAtoms } from './units';

// ------------------------------------------------------------------------------------------------ what the API serves

export type ExtTerms = {
  governance: { votePeriodSecs: string; timelockSecs: string; quorumBps: number; thresholdBps: number; maxProposalBps: number; proposerMinBps: number } | null;
  nav: { periodSecs: string; capBps: number; insiders: string[] } | null;
  distributions: { streamSecs: string };
  revenue: { shareBps: number; credential: string; schema: string; roundSecs: string; start: string; payGraceSecs: string; trancheMinRevenue: string; trancheAmount: string } | null;
  grants: { minLockupSecs: string };
  disclosure: { periodSecs: string; requestMinBps: number } | null;
  assignment: { credential: string; schema: string } | null;
  windDown: { windowSecs: string; recovery: string } | null;
};
export type ExtLive = {
  proposals: string;
  votesLocked: string;
  totalStaked: string;
  grants: string;
  grantsUnreleased: string;
  navOpen: boolean;
  navPeriod: { start: string; supplyAtStart: string; burned: string; endsAt: string } | null;
  missedRounds: number;
  currentRound: string | null;
  stream: { remaining: string; end: string } | null;
  disclosures: number;
  lastDisclosureAt: string | null;
  disclosureRequestOpenSince: string | null;
  disclosureDeadline: string | null;
  assigned: boolean | null;
  windDown: { start: string; sweepOpensAt: string; swept: boolean } | null;
};
export type ExtRead = { treasury: string; extended: false; note: string } | { treasury: string; extended: true; state: 'active' | 'liquidating'; terms: ExtTerms; live: ExtLive; balances: { vault: string; coinVault: string | null; distVault: string | null; coinSupply: string } };
export type ProposalStatus = 'voting' | 'failed' | 'timelock' | 'executable' | 'expired' | 'executed';
export type ProposalRead = { id: string; proposer: string; kind: 'spend' | 'open-nav' | 'close-nav'; amount: string; destination: string | null; descHash: string; createdAt: string; voteEndsAt: string; executableAt: string; expiresAt: string; yes: string; no: string; quorumNeeded: string; status: ProposalStatus };
export type GrantRead = { id: string; address: string; beneficiary: string; total: string; released: string; lockupEnd: string; expiresAt: string; burned: boolean; status: 'locked' | 'releasing' | 'expirable' | 'expired'; milestones: { index: number; bps: number; requiresAttestation: boolean; released: boolean; amount: string }[] };
export type RoundRead = { round: string; endsAt: string; payDeadline: string; status: 'open' | 'awaiting-payment' | 'late' | 'paid' | 'missed'; revenue: string | null; due: string | null; trancheReleased: boolean | null; attestation: string; attested: boolean };

export type TreasuryView = {
  detail: TreasuryDetail;
  ext: ExtRead;
  proposals: ProposalRead[];
  grants: GrantRead[];
  rounds: RoundRead[];
  /** Everything above was read; a part that could not be is named here and shown as unread, never as empty. */
  unread: string[];
};

export async function loadTreasury(address: string): Promise<Result<TreasuryView>> {
  const detail = await apiRead<TreasuryDetail>(`/v1/treasuries/${address}`);
  if (!detail.ok) return detail;
  const ext = await apiRead<ExtRead>(`/v1/treasuries/${address}/ext`);
  if (!ext.ok) return ext;
  const unread: string[] = [];
  if (!ext.data.extended) return { ok: true, data: { detail: detail.data, ext: ext.data, proposals: [], grants: [], rounds: [], unread } };
  const [p, g, r] = await Promise.all([apiRead<{ proposals: ProposalRead[] }>(`/v1/treasuries/${address}/proposals`), apiRead<{ grants: GrantRead[] }>(`/v1/treasuries/${address}/grants`), apiRead<{ rounds: RoundRead[] }>(`/v1/treasuries/${address}/rounds`)]);
  if (!p.ok) unread.push(`proposals (${p.error})`);
  if (!g.ok) unread.push(`grants (${g.error})`);
  if (!r.ok) unread.push(`revenue rounds (${r.error})`);
  return { ok: true, data: { detail: detail.data, ext: ext.data, proposals: p.ok ? p.data.proposals : [], grants: g.ok ? g.data.grants : [], rounds: r.ok ? r.data.rounds : [], unread } };
}

export type Position = { treasury: string; owner: string; held: string; staked: string; claimable: string; totalStaked: string };
export const loadPosition = (address: string, owner: string) => apiRead<Position>(`/v1/treasuries/${address}/positions/${owner}`);

// ------------------------------------------------------------------------------------------------ amounts and times

const DAY = 86_400;
export const unixNow = () => Math.floor(Date.now() / 1000);

/** A positive amount in the token's own decimals as atoms (string), or the sentence that says why not. */
export function atomsOf(text: string, decimals: number | null, what: string, { allowZero = false } = {}): { ok: true; atoms: string } | { ok: false; error: string } {
  if (decimals === null) return { ok: false, error: `${what}: the token has not been read yet.` };
  const a = parseAtoms(text, decimals);
  if (a === null) return { ok: false, error: `${what} is an amount with at most ${decimals} decimal places.` };
  if (a === 0n && !allowZero) return { ok: false, error: `${what} must be above zero.` };
  return { ok: true, atoms: a.toString() };
}

/** SHA-256 of a text, as 64 hex characters: the hash of a disclosure or a proposal's description, which is all that goes on chain. */
export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export const fmt = (atoms: string | null | undefined, decimals: number | null, unit: string): string => (atoms === null || atoms === undefined ? 'unavailable' : decimals === null ? `${atoms} atoms` : `${formatAtoms(BigInt(atoms), decimals)} ${unit}`);
export const pctOf = (bps: number): string => `${(bps / 100).toFixed(2).replace(/\.?0+$/, '')}%`;

// ------------------------------------------------------------------------------------------------ extending a treasury

export type ExtIssue = { code: string; field: string; message: string; severity: 'refused' | 'advice' };
export type TermsErrors = Partial<Record<keyof TermsForm | `insiders.${number}`, string>>;
export type TermsBuild = { body: Record<string, unknown> | null; errors: TermsErrors };

const blank = (s: string) => s.trim() === '';

/** The init-ext request from the terms form. `kind: 'flagship'` sends the API's own preset with the six inputs it needs; `custom` sends every term set. */
export function buildTerms(f: TermsForm, kind: 'flagship' | 'custom', authority: string, quoteDecimals: number | null): TermsBuild {
  const errors: TermsErrors = {};
  const bad = (k: keyof TermsForm, m: string) => {
    errors[k] = m;
  };
  const days = (k: keyof TermsForm, what: string, unit = DAY): number | undefined => {
    const v = f[k] as string;
    if (blank(v)) return undefined;
    if (!/^\d{1,6}$/.test(v.trim())) {
      bad(k, `${what} is a whole number.`);
      return undefined;
    }
    return Number(v.trim()) * unit;
  };
  const bps = (k: keyof TermsForm, what: string): number | undefined => {
    const v = f[k] as string;
    if (blank(v)) return undefined;
    if (!/^\d{1,3}(\.\d{1,2})?$/.test(v.trim()) || Number(v) > 100) {
      bad(k, `${what} is a percentage from 0 to 100 with at most two decimals.`);
      return undefined;
    }
    return Math.round(Number(v.trim()) * 100);
  };
  const addr = (k: keyof TermsForm): string | undefined => {
    const v = f[k] as string;
    if (blank(v)) return undefined;
    if (!isAddress(v.trim())) {
      bad(k, 'This is not a Solana address.');
      return undefined;
    }
    return v.trim();
  };
  const quote = (k: keyof TermsForm, what: string): string | undefined => {
    const v = f[k] as string;
    if (blank(v)) return undefined;
    const r = atomsOf(v, quoteDecimals, what, { allowZero: true });
    if (!r.ok) {
      bad(k, r.error);
      return undefined;
    }
    return r.atoms;
  };
  let revStart: number | undefined;
  if (!blank(f.revStart)) {
    const t = new Date(f.revStart).getTime();
    if (!Number.isFinite(t)) bad('revStart', 'Enter the start as a date and time.');
    else revStart = Math.floor(t / 1000);
  }
  const insiders: string[] = [];
  f.insiders.forEach((a, i) => {
    if (blank(a)) return;
    if (!isAddress(a.trim())) errors[`insiders.${i}`] = 'This is not a Solana address.';
    else insiders.push(a.trim());
  });

  if (kind === 'flagship') {
    const share = bps('revSharePct', 'The holders’ share of revenue');
    const need = (k: keyof TermsForm, v: unknown, what: string) => {
      if (v === undefined && !errors[k]) bad(k, `${what} is needed for this preset.`);
    };
    const revenueCredential = addr('revCredential');
    const revenueSchema = addr('revSchema');
    const assignmentCredential = addr('assignCredential');
    const assignmentSchema = addr('assignSchema');
    const recovery = addr('recovery');
    need('revSharePct', share === 0 ? undefined : share, 'The share of revenue owed to holders');
    need('revCredential', revenueCredential, 'The revenue attester’s credential');
    need('revSchema', revenueSchema, 'The revenue attester’s schema');
    need('assignCredential', assignmentCredential, 'Counsel’s credential');
    need('assignSchema', assignmentSchema, 'Counsel’s schema');
    need('revStart', revStart, 'The start of the first revenue round');
    need('recovery', recovery, 'The recovery account');
    if (Object.keys(errors).length) return { body: null, errors };
    return { body: { authority, preset: 'flagship', revenueCredential, revenueSchema, assignmentCredential, assignmentSchema, revenueShareBps: share, revenueStart: revStart, recovery, ...(insiders.length ? { insiders } : {}) }, errors };
  }

  const params: Record<string, unknown> = {};
  const put = (k: string, v: unknown) => {
    if (v !== undefined) params[k] = v;
  };
  put('votePeriodSecs', days('votePeriodDays', 'The vote period'));
  put('timelockSecs', days('timelockDays', 'The timelock'));
  put('quorumBps', bps('quorumPct', 'The quorum'));
  put('thresholdBps', bps('thresholdPct', 'The majority'));
  put('maxProposalBps', bps('maxProposalPct', 'The largest proposal'));
  put('proposerMinBps', bps('proposerMinPct', 'The proposer’s minimum holding'));
  put('minLockupSecs', days('minLockupDays', 'The grant lockup'));
  put('navPeriodSecs', days('navPeriodDays', 'The NAV period'));
  put('navCapBps', bps('navCapPct', 'The NAV cap'));
  if (insiders.length) put('insiders', insiders);
  put('streamSecs', days('streamHours', 'The stream length', 3_600));
  put('revShareBps', bps('revSharePct', 'The holders’ share of revenue'));
  put('revCredential', addr('revCredential'));
  put('revSchema', addr('revSchema'));
  put('roundSecs', days('roundDays', 'The round length'));
  put('revStart', revStart);
  put('payGraceSecs', days('payGraceDays', 'The grace period'));
  put('trancheMinRevenue', quote('trancheMinRevenue', 'The tranche’s revenue threshold'));
  put('trancheAmount', quote('trancheAmount', 'The tranche'));
  put('disclosurePeriodSecs', days('disclosurePeriodDays', 'The disclosure deadline'));
  put('requestMinBps', bps('requestMinPct', 'The minimum holding to request a disclosure'));
  if (f.assignRequired) put('assignRequired', true);
  put('assignCredential', addr('assignCredential'));
  put('assignSchema', addr('assignSchema'));
  put('windowSecs', days('windowDays', 'The wind-down window'));
  put('recovery', addr('recovery'));
  // The program refuses a wind-down with no recovery account; say so here instead of sending a request that is certain to be refused.
  if (params.windowSecs !== undefined && params.recovery === undefined && !errors.recovery) errors.recovery = 'A wind-down names the account that receives what holders did not redeem. Fixed at extension and unchangeable.';
  if (Object.keys(errors).length) return { body: null, errors };
  if (Object.keys(params).length === 0) return { body: null, errors: { votePeriodDays: 'Set at least one term. An extension can be made only once.' } };
  return { body: { authority, params }, errors };
}

/** Which box of the terms form an issue's `field` (the program's parameter name) belongs to. */
export function termsKeyForIssue(field: string): keyof TermsForm | null {
  const table: Record<string, keyof TermsForm> = {
    votePeriodSecs: 'votePeriodDays',
    timelockSecs: 'timelockDays',
    quorumBps: 'quorumPct',
    thresholdBps: 'thresholdPct',
    maxProposalBps: 'maxProposalPct',
    proposerMinBps: 'proposerMinPct',
    navCapBps: 'navCapPct',
    navPeriodSecs: 'navPeriodDays',
    revShareBps: 'revSharePct',
    roundSecs: 'roundDays',
    payGraceSecs: 'payGraceDays',
    revStart: 'revStart',
    trancheAmount: 'trancheAmount',
    disclosurePeriodSecs: 'disclosurePeriodDays',
    requestMinBps: 'requestMinPct',
    windowSecs: 'windowDays',
    recovery: 'recovery',
    streamSecs: 'streamHours',
    minLockupSecs: 'minLockupDays',
    assignCredential: 'assignCredential',
    revCredential: 'revCredential',
  };
  return table[field] ?? null;
}

export type ExtPreview = { ok: true; issues: ExtIssue[] } | { ok: false; error: string; reason: string | null; issues: ExtIssue[] };

/** Builds (never signs) the init-ext transaction to learn what the program would say: POST answers `issues` (advice) or 422 TERMS_INVALID with them. */
export async function previewExt(address: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<ExtPreview> {
  try {
    const res = await fetch(`${API_URL}/v1/treasuries/${address}/tx/init-ext`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), ...(signal ? { signal } : {}) });
    const j = (await res.json().catch(() => ({}))) as { error?: string; reason?: string; issues?: ExtIssue[] };
    if (res.ok) return { ok: true, issues: j.issues ?? [] };
    return { ok: false, error: j.error ?? `The API answered HTTP ${res.status}.`, reason: j.reason ?? null, issues: j.issues ?? [] };
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    return { ok: false, error: 'The Opening Cross API could not be reached, so these terms could not be checked.', reason: null, issues: [] };
  }
}
