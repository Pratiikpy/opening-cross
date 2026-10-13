// What a coin holder can do with a treasury's extension, from the reads under GET /v1/treasuries/:address/*. Pure: nothing here reads the
// network. Every action is offered only when (a) the deployed program has the extension, (b) this treasury was extended, (c) the treasury
// switched that feature on, and (d) the state the reads show lets the action run. The API still makes the same checks before it builds a
// transaction and the program makes them again; this decides what the page offers.
import type { Release } from './holder-programs';
import { clock } from './holder-rules';
import { duration } from './treasury';
import { formatAtoms } from './units';

export type ExtRead =
  | { treasury: string; extended: false; note: string }
  | {
      treasury: string;
      extended: true;
      state: 'active' | 'liquidating';
      terms: {
        governance: { votePeriodSecs: string; timelockSecs: string; quorumBps: number; thresholdBps: number; maxProposalBps: number; proposerMinBps: number } | null;
        nav: { periodSecs: string; capBps: number; insiders: string[] } | null;
        distributions: { streamSecs: string };
        revenue: { shareBps: number; credential: string; schema: string; roundSecs: string; start: string; payGraceSecs: string; trancheMinRevenue: string; trancheAmount: string } | null;
        grants: { minLockupSecs: string };
        disclosure: { periodSecs: string; requestMinBps: number } | null;
        assignment: { credential: string; schema: string } | null;
        windDown: { windowSecs: string; recovery: string } | null;
      };
      live: {
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
      balances: { vault: string; coinVault: string | null; distVault: string | null; coinSupply: string };
    };

export type ProposalStatus = 'voting' | 'failed' | 'timelock' | 'executable' | 'expired' | 'executed';
export type Proposal = {
  id: string;
  proposer: string;
  kind: 'spend' | 'open-nav' | 'close-nav';
  amount: string;
  destination: string | null;
  descHash: string;
  createdAt: string;
  voteEndsAt: string;
  executableAt: string;
  expiresAt: string;
  yes: string;
  no: string;
  quorumNeeded: string;
  status: ProposalStatus;
  vote?: { voter: string; yes: string; no: string } | null;
};
export type ProposalsRead = { treasury: string; count: string; proposals: Proposal[] };
export type Position = { treasury: string; owner: string; held: string; staked: string; claimable: string; totalStaked: string };
export type Milestone = { index: number; bps: number; requiresAttestation: boolean; released: boolean; amount: string };
export type Grant = { id: string; address: string; beneficiary: string; total: string; released: string; lockupEnd: string; expiresAt: string; burned: boolean; status: 'locked' | 'releasing' | 'expirable' | 'expired'; milestones: Milestone[] };
export type GrantsRead = { treasury: string; count: string; grants: Grant[] };
export type Round = { round: string; endsAt: string; payDeadline: string; status: 'open' | 'awaiting-payment' | 'late' | 'paid' | 'missed'; revenue: string | null; due: string | null; trancheReleased: string | null; attestation: string; attested: boolean };
export type RoundsRead = { treasury: string; rounds: Round[]; note?: string };

/** Where a treasury stands for a holder: whether the extension can be used at all. */
export type Availability =
  | { kind: 'live' }
  /** The program on this network is the first release. */
  | { kind: 'first-release' }
  /** The program has the extension but this treasury never called init_ext. */
  | { kind: 'not-extended' }
  /** The program release could not be read, so nothing is claimed. */
  | { kind: 'unknown'; extended: boolean };

export function availability(release: Release, ext: ExtRead | null): Availability {
  if (release === 'first-release') return { kind: 'first-release' };
  if (ext === null) return { kind: 'unknown', extended: false };
  if (!ext.extended) return release === 'extended' ? { kind: 'not-extended' } : { kind: 'unknown', extended: false };
  return { kind: 'live' };
}

export const COPY: Record<'first-release' | 'not-extended', string> = {
  'first-release':
    'Votes, redemption at NAV, distributions, revenue rounds, grants and disclosure requests are built and proved on LiteSVM and a local validator. The treasury program deployed on this network is still the first release, so it cannot perform them yet. They go live when the upgrade is funded (H27); nothing is offered here until then.',
  'not-extended': 'This treasury was created without the extension, so it has no votes, distributions, grants or revenue rounds. Its team can switch them on once; the terms are then fixed.',
};

export type HolderAction =
  | { id: 'vote'; proposal: Proposal; enabled: boolean; why: string | null }
  | { id: 'reclaim-vote'; proposal: Proposal; enabled: boolean; why: string | null }
  | { id: 'execute'; proposal: Proposal; enabled: boolean; why: string | null };

const BPS = 10_000n;

/** Whether the proposal needs more than a vote from this wallet: it can be voted on, the locked coins reclaimed, or it executed by anyone. */
export function proposalActions(p: Proposal, position: Position | null, hasVoted: boolean, now: bigint): HolderAction[] {
  const out: HolderAction[] = [];
  const held = position ? BigInt(position.held) : 0n;
  if (p.status === 'voting') out.push({ id: 'vote', proposal: p, enabled: held > 0n, why: held > 0n ? null : 'This wallet holds no coins of the treasury, so it has nothing to vote with.' });
  if (hasVoted && now >= BigInt(p.voteEndsAt)) out.push({ id: 'reclaim-vote', proposal: p, enabled: true, why: null });
  if (p.status === 'executable') out.push({ id: 'execute', proposal: p, enabled: true, why: null });
  return out;
}

export const KIND_TEXT: Record<Proposal['kind'], string> = { spend: 'Spend above the allowance', 'open-nav': 'Open a NAV redemption window', 'close-nav': 'Close the NAV redemption window' };
export const STATUS_TEXT: Record<ProposalStatus, string> = {
  voting: 'Voting is open',
  failed: 'Failed: no quorum or no strict majority',
  timelock: 'Passed, waiting out the timelock',
  executable: 'Passed and ready to execute',
  expired: 'Expired: it was not executed in time',
  executed: 'Executed',
};

/** Votes as a share of the total weight that voted, rounded down to a tenth of a percent; null when nobody voted. */
export function yesShare(p: Pick<Proposal, 'yes' | 'no'>): string | null {
  const yes = BigInt(p.yes);
  const total = yes + BigInt(p.no);
  if (total === 0n) return null;
  return `${Number((yes * 1000n) / total) / 10}%`;
}

/** The basis points of the supply a holder has, to compare with a minimum share (`requestMinBps`, `proposerMinBps`). */
export const shareBps = (held: bigint, supply: bigint): bigint => (supply === 0n ? 0n : (held * BPS) / supply);

export type DisclosureView = {
  state: 'not-enabled' | 'open' | 'requested' | 'overdue';
  text: string;
  canRequest: boolean;
  why: string | null;
};

/** The disclosure request: enabled by the terms, open to a holder with at least `requestMinBps` of the supply, answered by the team before the deadline. */
export function disclosureView(ext: Extract<ExtRead, { extended: true }>, held: bigint, now: bigint): DisclosureView {
  const d = ext.terms.disclosure;
  if (!d) return { state: 'not-enabled', text: 'This treasury’s team did not switch on disclosure requests.', canRequest: false, why: null };
  const supply = BigInt(ext.balances.coinSupply);
  const requested = ext.live.disclosureRequestOpenSince;
  if (requested) {
    const deadline = BigInt(ext.live.disclosureDeadline ?? '0');
    const overdue = now > deadline;
    return {
      state: overdue ? 'overdue' : 'requested',
      text: overdue
        ? `A holder asked for a disclosure on ${clock(requested)}. The team’s deadline, ${clock(deadline)}, has passed without one, so the program now refuses team outflows until it posts.`
        : `A holder asked for a disclosure on ${clock(requested)}. The team must post one by ${clock(deadline)}.`,
      canRequest: false,
      why: 'A request is already open.',
    };
  }
  const need = d.requestMinBps;
  const have = shareBps(held, supply);
  const ok = have >= BigInt(need);
  return {
    state: 'open',
    text: `A holder of at least ${Number((need / 100).toFixed(2))}% of the supply can ask the team to post a disclosure. The team then has ${duration(d.periodSecs)}; while it is overdue the program refuses team outflows.`,
    canRequest: ok,
    why: ok ? null : `This wallet holds ${Number((Number(have) / 100).toFixed(2))}% of the supply; the minimum is ${Number((need / 100).toFixed(2))}%.`,
  };
}

export const quoteText = (atoms: string | bigint, decimals: number): string => `${formatAtoms(BigInt(atoms), decimals)} quote`;
export const coinText = (atoms: string | bigint, decimals: number): string => `${formatAtoms(BigInt(atoms), decimals)} coins`;

const pct = (bps: number): string => `${Number((bps / 100).toFixed(2))}%`;
const dur = (secs: string | bigint): string => duration(String(secs));

/** What the treasury's extension gives holders, as sentences, from the terms that were fixed when it was extended. A feature the team left off is not mentioned as available. */
export function termsLines(ext: Extract<ExtRead, { extended: true }>): { id: string; text: string }[] {
  const t = ext.terms;
  const out: { id: string; text: string }[] = [];
  if (t.governance) {
    const g = t.governance;
    out.push({
      id: 'votes',
      text: `Votes. A holder of at least ${pct(g.proposerMinBps)} of the supply can propose a spend above the allowance, or opening or closing the NAV window. Coins locked in a vote stay locked for ${dur(g.votePeriodSecs)}; a proposal passes with at least ${pct(g.quorumBps)} of the supply voting and a strict majority above ${pct(g.thresholdBps)}, waits out a timelock of ${dur(g.timelockSecs)}, and then anyone can execute it, for at most ${pct(g.maxProposalBps)} of the vault. There is no delegation.`,
    });
  }
  if (t.nav) {
    out.push({ id: 'nav', text: `Redemption at NAV. While a window is open (after a passed vote, or automatically after a missed revenue round) a holder can burn coins for a pro rata share of the vault. Each window lasts ${dur(t.nav.periodSecs)} and can redeem at most ${pct(t.nav.capBps)} of the supply. Insiders cannot redeem, and team spending is frozen meanwhile.` });
  }
  out.push({ id: 'dist', text: `Distributions. Coins you stake earn a share of every deposit of quote tokens${BigInt(t.distributions.streamSecs) > 0n ? `, which streams to stakers over ${dur(t.distributions.streamSecs)}` : ''}. Unstaking is never blocked. Holders who do not stake are not paid.` });
  if (t.revenue) {
    const r = t.revenue;
    out.push({ id: 'revenue', text: `Revenue rounds. The team owes ${pct(r.shareBps)} of attested revenue to stakers each ${dur(r.roundSecs)}, with ${dur(r.payGraceSecs)} to pay. A round nobody paid by then can be marked missed by anyone, and a missed round opens the NAV window.` });
  }
  if (BigInt(t.grants.minLockupSecs) > 0n || BigInt(ext.live.grants) > 0n) out.push({ id: 'grants', text: `Team grants. A grant is locked for at least ${dur(t.grants.minLockupSecs)}, then released in milestones to its beneficiary. An unreleased grant that passes its expiry is burned, and unreleased grant coins do not count toward quorum.` });
  if (t.disclosure) out.push({ id: 'disclosure', text: `Disclosure requests. A holder of at least ${pct(t.disclosure.requestMinBps)} of the supply can ask the team to post a disclosure; it has ${dur(t.disclosure.periodSecs)}, and until it does the program refuses team outflows.` });
  if (t.assignment) out.push({ id: 'assignment', text: `Assignment gate. The team cannot take money out until an attestation records that the company’s IP and assets are assigned to the entity the coin represents${ext.live.assigned ? ' (recorded)' : ' (not recorded yet)'}.` });
  if (t.windDown) out.push({ id: 'wind', text: `Wind-down. After liquidation, redemption stays open for ${dur(t.windDown.windowSecs)}; only then can anyone sweep what is left, once, to the recovery account fixed in advance.` });
  return out;
}
