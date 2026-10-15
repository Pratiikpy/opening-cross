// Graduation by holder vote (D10, Z0; ADR-0656): what GET /v1/crosses/:address/graduation serves, the words a holder reads, and the forms that become the
// bodies of the graduate routes. Pure and free of React. Integers that can exceed 2^53 are decimal strings.
//
// Rules of the program (programs/cross_graduate, docs/evidence/W3D-D10.md): a cross whose creator set the governed-graduation rule opens a pool only on the venue
// holders chose. The creator fixes a charter before the first order (quorum 10 to 100 percent of the live supply, a voting window of 3 to 30 days, an optional
// minimum organic volume and the key allowed to attest it). Once the cross is finalized the creator opens a round (at most three, one at a time); a holder locks
// tokens behind a venue until the window ends; anyone finalizes after the window and publishes the outcome of a round that passed.
import { isAddress } from '@solana/kit';
import type { ReleaseNote } from './new-programs';
import { formatAtoms, parseAtoms, shortAddress } from './units';

export const VENUES = ['damm_v2', 'dlmm', 'raydium_cpmm', 'metadao_futarchy'] as const;
export type Venue = (typeof VENUES)[number];
export const VENUE_LABEL: Record<string, string> = { damm_v2: 'Meteora DAMM v2', dlmm: 'Meteora DLMM', raydium_cpmm: 'Raydium CPMM', metadao_futarchy: 'MetaDAO futarchy DAO' };
/** The seeding route that opens each venue. */
export const SEED_ROUTE: Record<string, string> = { damm_v2: 'seed-damm-v2', dlmm: 'open-dlmm-pair', raydium_cpmm: 'seed-raydium-cpmm', metadao_futarchy: 'seed-futarchy-dao' };
export const venueLabel = (v: string | null | undefined): string => (v ? (VENUE_LABEL[v] ?? v) : 'no venue');

export type RoundStatus = 'voting' | 'awaiting-finalize' | 'passed' | 'failed';
export type Tally = { venue: string; venueNumber: number; locked: string };
export type RoundRead = {
  round: string;
  index: number;
  opensTs: string;
  closesTs: string;
  status: RoundStatus;
  quorumBps: number;
  lockedTotal: string;
  quorumNeeded: string | null;
  tallies: Tally[];
  volume: { required: string; posted: string | null; attester: string | null };
  winner: string | null;
  wouldPassNow: boolean | null;
  shortfall?: Record<string, unknown>;
};
export type CharterRead = { address: string; creator: string; quorumBps: number; windowSecs: string; minVolume: string; volumeAttester: string | null; roundsUsed: number; roundsLeft: number; active: boolean; passed: boolean };
export type OutcomeRead = { account: string; venue: string; venueNumber: number; round: number; publishedTs: string };
export type GraduationRead = {
  cross: string;
  governed: boolean;
  applies?: boolean;
  release: ReleaseNote;
  note?: string;
  venues: string[];
  outcomeAccount: string;
  charter?: CharterRead | null;
  supply?: string | null;
  rounds?: RoundRead[];
  outcome?: OutcomeRead | null;
  seeding?: { requiresOutcome: boolean; ready: boolean; outcome?: string; instruction?: string | null };
  mintAuthority?: string | null;
};
export type VoteRead = { round: string; cross: string; index: number; closesTs: string; finalized: boolean; passed: boolean; vote?: { voter: string; venue?: string; venueNumber?: number; locked: string; unlocksAt?: string; canWithdraw?: boolean } };

// ---------------------------------------------------------------------------------------------------- words

export const bpsText = (bps: number): string => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`;
export function stamp(secs: number): string {
  return `${new Date(secs * 1000).toISOString().replace('T', ' ').slice(0, 16)} UTC`;
}
export function humanLeft(secs: number): string {
  const s = Math.max(0, Math.floor(secs));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** The sentence under a round: where it is, and what happens next. */
export function roundLine(r: RoundRead, now: number): string {
  const closes = Number(r.closesTs);
  if (r.status === 'voting') return `Voting is open until ${stamp(closes)} (${humanLeft(closes - now)} left). Tokens locked behind a venue stay locked until then.`;
  if (r.status === 'awaiting-finalize') return `The window closed at ${stamp(closes)}. Anyone can finalize the round now; on the tally as it stands it ${r.wouldPassNow ? 'would pass' : 'would not pass'}.`;
  if (r.status === 'passed') return `The round passed${r.winner ? ` and chose ${venueLabel(r.winner)}` : ''}.`;
  return 'The round failed. The market stays without a graduation venue until the creator opens another round, up to three in all.';
}

/** Why a round that has not passed is short: quorum, the volume gate or a majority, in the program's own terms. */
export function shortfallText(r: RoundRead, decimals: number): string[] {
  const out: string[] = [];
  const locked = BigInt(r.lockedTotal);
  if (r.quorumNeeded !== null && locked < BigInt(r.quorumNeeded)) out.push(`Quorum: ${formatAtoms(locked, decimals)} locked of ${formatAtoms(BigInt(r.quorumNeeded), decimals)} needed (${bpsText(r.quorumBps)} of the live supply).`);
  if (BigInt(r.volume.required) > 0n && (r.volume.posted === null || BigInt(r.volume.posted) < BigInt(r.volume.required))) {
    out.push(r.volume.posted === null ? 'Organic volume: the charter asks for a minimum and no figure has been attested yet.' : 'Organic volume: the attested figure is below the charter’s minimum.');
  }
  const top = [...r.tallies].sort((a, b) => (BigInt(b.locked) > BigInt(a.locked) ? 1 : BigInt(b.locked) < BigInt(a.locked) ? -1 : 0));
  if (locked > 0n && top[0] && BigInt(top[0].locked) * 2n <= locked) out.push('Majority: no venue holds more than half of what is locked (a tie has no winner).');
  return out;
}

/** Share of the locked tokens behind a venue, in percent with two decimals; 0 when nothing is locked. */
export function shareOf(t: Tally, lockedTotal: string): number {
  const total = BigInt(lockedTotal);
  return total === 0n ? 0 : Number((BigInt(t.locked) * 10_000n) / total) / 100;
}

/** The round a person should look at: the one that is open, else the latest. */
export function currentRound(g: GraduationRead): RoundRead | null {
  const rounds = g.rounds ?? [];
  return rounds.find((r) => r.status === 'voting' || r.status === 'awaiting-finalize') ?? rounds[rounds.length - 1] ?? null;
}

export type CreatorStep = 'no-charter' | 'start-round' | 'round-open' | 'passed' | 'no-rounds-left';
/** What the creator can do next. */
export function creatorStep(g: GraduationRead): CreatorStep {
  const c = g.charter;
  if (!c) return 'no-charter';
  if (c.passed) return 'passed';
  if (c.active) return 'round-open';
  if (c.roundsLeft <= 0) return 'no-rounds-left';
  return 'start-round';
}

// ---------------------------------------------------------------------------------------------------- forms

export type CharterForm = { quorumPct: string; windowDays: string; minVolume: string; attester: string };
export const EMPTY_CHARTER: CharterForm = { quorumPct: '25', windowDays: '7', minVolume: '', attester: '' };
export type CharterErrors = Partial<Record<keyof CharterForm, string>>;

/** The body of POST /v1/tx/graduate-init-charter. The terms never change once set, so every bound the program has is checked here first. */
export function buildCharter(f: CharterForm, creator: string | null, cross: string, quoteDecimals: number | null): { body: Record<string, unknown> | null; errors: CharterErrors } {
  const errors: CharterErrors = {};
  const q = f.quorumPct.trim();
  const bps = /^\d{1,3}(\.\d{1,2})?$/.test(q) ? Math.round(Number(q) * 100) : null;
  if (bps === null || bps < 1_000 || bps > 10_000) errors.quorumPct = 'A quorum is 10 to 100 percent of the live supply, with at most two decimals.';
  const d = f.windowDays.trim();
  const days = /^\d{1,2}$/.test(d) ? Number(d) : null;
  if (days === null || days < 3 || days > 30) errors.windowDays = 'A voting window is a whole number of days, 3 to 30.';
  let minVolume: bigint | null = 0n;
  if (f.minVolume.trim() !== '') {
    minVolume = quoteDecimals === null ? null : parseAtoms(f.minVolume, quoteDecimals);
    if (minVolume === null) errors.minVolume = quoteDecimals === null ? 'The quote token’s decimals have not been read yet.' : `A number of quote tokens with at most ${quoteDecimals} decimals.`;
  }
  const attester = f.attester.trim();
  if (attester !== '' && !isAddress(attester)) errors.attester = 'This is not a Solana address.';
  else if (minVolume !== null && minVolume > 0n && attester === '') errors.attester = 'A minimum volume needs someone to attest it: name the attester.';
  if (Object.keys(errors).length > 0 || !creator || bps === null || days === null || minVolume === null) return { body: null, errors };
  return { body: { creator, cross, quorumBps: bps, windowSecs: days * 86_400, ...(minVolume > 0n ? { minVolume: minVolume.toString() } : {}), ...(attester ? { volumeAttester: attester } : {}) }, errors };
}

export type VoteForm = { venue: string; amount: string };
export type VoteErrors = Partial<Record<keyof VoteForm, string>>;
/** The body of POST /v1/tx/graduate-cast-vote. A wallet can add to its stake but not change venue, so a locked venue is the only one accepted. */
export function buildVote(f: VoteForm, voter: string | null, cross: string, round: number, decimals: number | null, held: bigint | null, lockedVenue: string | null): { body: Record<string, unknown> | null; errors: VoteErrors } {
  const errors: VoteErrors = {};
  if (!f.venue) errors.venue = 'Choose the venue you want the market to open on.';
  else if (lockedVenue && f.venue !== lockedVenue) errors.venue = `This wallet already locked tokens behind ${venueLabel(lockedVenue)}; a stake can grow but cannot change venue.`;
  const amount = decimals === null ? null : parseAtoms(f.amount, decimals);
  if (f.amount.trim() === '' || amount === null || amount === 0n) errors.amount = decimals === null ? 'The token’s decimals have not been read yet.' : `A number of tokens above zero with at most ${decimals} decimals.`;
  else if (held !== null && amount > held) errors.amount = `This wallet holds ${formatAtoms(held, decimals ?? 0)}.`;
  if (Object.keys(errors).length > 0 || !voter || amount === null) return { body: null, errors };
  return { body: { voter, cross, venue: f.venue, amount: amount.toString(), round }, errors };
}

export const shortWho = (a: string | null): string => (a ? shortAddress(a) : 'nobody');
