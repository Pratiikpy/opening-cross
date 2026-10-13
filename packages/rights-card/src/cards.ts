// Rights cards for an ownership-coin treasury (programs/treasury, ADR-0014).
//
// A card says what a holder, the team or any stranger can rely on, or cannot. Every statement is one of two kinds:
//   - an enforced rule: cited to the instruction and the program error that enforce it (`enforcedBy`), or
//   - an absence: the program has no instruction that does the thing (`absence`). test/program.test.ts keeps the instruction
//     list below equal to the program source, so adding an instruction fails the build until the cards are re-derived.
// Nothing here promises anything the program does not do. The `now` line of a card is read from the facts passed in (chain state).
// A treasury may be extended once (`init_ext`): the cards for votes, NAV redemption, revenue rounds, staker distributions, team
// grants, disclosure requests, the assignment gate and the wind-down window appear only for a treasury that has that tail and
// enabled the feature, and say what the program does for that treasury's own parameters. Without the tail those instructions
// refuse (`NotExtended`) and the cards say so.
import { formatAtoms, formatDuration, formatTime } from './format.js';

/** The extension tail of a treasury, as the cards need it; a feature the team left off is null. */
export type ExtFacts = {
  voting: { votePeriodSecs: bigint; timelockSecs: bigint; quorumBps: number; thresholdBps: number; maxProposalBps: number; proposerMinBps: number } | null;
  nav: { periodSecs: bigint; capBps: number; open: boolean; insiders: string[] } | null;
  revenue: { shareBps: number; roundSecs: bigint; payGraceSecs: bigint; missedRounds: number; trancheAmount: bigint } | null;
  disclosure: { periodSecs: bigint; requestMinBps: number; openRequestTs: bigint | null; lastDisclosureTs: bigint | null; disclosures: number } | null;
  /** Null when the treasury does not require an IP and asset assignment. */
  assignment: { assigned: boolean } | null;
  windDown: { windowSecs: bigint; recovery: string; windStart: bigint | null; swept: boolean } | null;
  /** The shortest lockup a team grant may have. */
  minLockupSecs: bigint;
  /** Coins staked for distributions, and coins escrowed in team grants and not yet released (atoms). */
  totalStaked: bigint;
  grantsUnreleased: bigint;
  /** Seconds over which a deposit streams to stakers; 0 pays out at once. */
  streamSecs: bigint;
};

export type TreasuryFacts = {
  state: 'Active' | 'Liquidating';
  authority: string;
  quoteDecimals: number;
  allowance: bigint;
  periodSecs: bigint;
  periodStart: bigint;
  spentInPeriod: bigint;
  graceSecs: bigint;
  lapsedSince: bigint | null;
  snapshotVault: bigint;
  snapshotSupply: bigint;
  /** Quote tokens in the vault now. */
  vaultBalance: bigint;
  /** Coin supply now. */
  coinSupply: bigint;
  /** The coin mint's mint authority now; null once revoked. */
  coinMintAuthority: string | null;
  /** Whether the attestation the program checks is live at `now`; 'unknown' when it could not be read. */
  attestation: 'live' | 'not-live' | 'unknown';
  /** The treasury program's upgrade authority; null if it can never be upgraded, 'unknown' if it could not be read. */
  programUpgradeAuthority: string | null | 'unknown';
  /** Unix seconds. */
  now: bigint;
  /** The extension tail; absent or null for a treasury that was never extended. */
  ext?: ExtFacts | null;
};

export type CardKind = 'protects' | 'entitles' | 'not-provided' | 'caveat';

export type Enforcement = {
  /** The program instruction (snake_case, as in the source) whose code enforces the rule. */
  instruction: string;
  /** The `TreasuryError` variant it fails with when the rule is broken; null where the rule is a calculation, not a refusal. */
  error: string | null;
  rule: string;
};

export type RightsCard = {
  id: string;
  kind: CardKind;
  title: string;
  /** What the rule is, in terms of the treasury's own parameters. */
  statement: string;
  /** Read from chain state at the time of the request; null when there is nothing live to say. */
  now: string | null;
  enforcedBy: Enforcement[];
  /** For a card about something the program does not do: why it cannot, from the instruction list. */
  absence: string | null;
};

/** The instructions of the deployed program. test/program.test.ts keeps this equal to programs/treasury/src/lib.rs. */
export const PROGRAM_INSTRUCTIONS = [
  'create_treasury', 'spend', 'record_lapse', 'record_attested', 'trigger_liquidation', 'redeem',
  'init_ext', 'propose', 'vote', 'reclaim_vote', 'execute_proposal', 'nav_redeem',
  'stake', 'unstake', 'deposit_distribution', 'claim_distribution', 'pay_round', 'mark_missed', 'release_tranche',
  'create_grant', 'release_milestone', 'expire_grant', 'post_disclosure', 'request_disclosure', 'record_assignment', 'sweep_unclaimed',
] as const;

const NO_INSTRUCTION = `The program has ${PROGRAM_INSTRUCTIONS.length} instructions (listed in its source) and none of them`;

const pct = (bps: number): string => `${bps / 100}%`;

function allowanceLeft(f: TreasuryFacts): { left: bigint; resetsAt: bigint } {
  const periodEnd = f.periodStart + f.periodSecs;
  // The period rolls forward inside `spend`; until the next spend an elapsed period simply has its full allowance again.
  return f.now >= periodEnd
    ? { left: f.allowance, resetsAt: f.now + f.periodSecs - ((f.now - f.periodStart) % f.periodSecs) }
    : { left: f.allowance - f.spentInPeriod, resetsAt: periodEnd };
}

export function rightsCards(f: TreasuryFacts): RightsCard[] {
  const q = (n: bigint) => `${formatAtoms(n, f.quoteDecimals)} quote`;
  const liquidating = f.state === 'Liquidating';
  const { left, resetsAt } = allowanceLeft(f);
  const graceEnd = f.lapsedSince === null ? null : f.lapsedSince + f.graceSecs;

  const spendNow = liquidating
    ? 'Spending is closed for good: the treasury is in liquidation.'
    : `${q(left)} of ${q(f.allowance)} is left this period; the allowance is whole again at ${formatTime(resetsAt)}.`;

  const attestNow = liquidating
    ? 'No longer relevant: the treasury is in liquidation.'
    : f.attestation === 'live'
      ? 'The attestation is live now, so the team can spend within the allowance.'
      : f.attestation === 'not-live'
        ? 'There is no live attestation now, so the team cannot spend.'
        : 'The attestation account could not be read just now.';

  const lapseNow = liquidating ? 'Liquidation has started.' : f.lapsedSince === null ? 'No lapse is recorded.' : `A lapse was recorded at ${formatTime(f.lapsedSince)}.`;

  const triggerNow = liquidating
    ? 'Liquidation has started.'
    : graceEnd === null
      ? 'Cannot be triggered: no lapse is recorded.'
      : f.now >= graceEnd
        ? `The grace period ended at ${formatTime(graceEnd)}: anyone can trigger liquidation now.`
        : `The grace period ends at ${formatTime(graceEnd)}; before then, liquidation is refused.`;

  let redeemNow: string;
  if (liquidating) {
    redeemNow = `Open. Snapshot: ${q(f.snapshotVault)} over ${f.snapshotSupply.toString()} coin atoms. Burning N coin atoms pays floor(${f.snapshotVault} × N ÷ ${f.snapshotSupply}) quote atoms.`;
  } else if (f.coinSupply > 0n) {
    redeemNow = `Closed until liquidation. If the snapshot were taken now (an estimate, not a promise: the vault and supply can change first), it would be ${q(f.vaultBalance)} over ${f.coinSupply.toString()} coin atoms.`;
  } else {
    redeemNow = 'Closed until liquidation.';
  }


  const x = f.ext ?? null;
  const extNow = x === null ? 'This treasury has not been extended.' : 'This treasury has been extended.';
  const extCards: RightsCard[] = [];

  if (x?.voting) {
    const v = x.voting;
    extCards.push({
      id: 'holder-votes',
      kind: 'entitles',
      title: 'Holders can vote to spend above the allowance',
      statement: `A holder of at least ${pct(v.proposerMinBps)} of the supply (or the authority) can propose a spend, or opening or closing the NAV window. Holders lock coins to vote for ${formatDuration(v.votePeriodSecs)}; the proposal passes with at least ${pct(v.quorumBps)} of the supply voting and a strict majority above ${pct(v.thresholdBps)}. After a timelock of ${formatDuration(v.timelockSecs)} anyone can execute it, within 14 days, to the destination named in the proposal and for at most ${pct(v.maxProposalBps)} of the vault. There is no delegation.`,
      now: liquidating ? 'The treasury is in liquidation: no new proposals or executions; voters can still reclaim their coins.' : null,
      enforcedBy: [
        { instruction: 'propose', error: 'NotHolder', rule: 'a proposer other than the authority must hold the minimum share of the supply' },
        { instruction: 'propose', error: 'WrongProposalId', rule: 'proposals are numbered in order' },
        { instruction: 'vote', error: 'VotingClosed', rule: 'votes after the vote period are refused' },
        { instruction: 'reclaim_vote', error: 'VotingOpen', rule: 'locked coins come back only after the vote ends' },
        { instruction: 'execute_proposal', error: 'TimelockPending', rule: 'no execution before the timelock ends' },
        { instruction: 'execute_proposal', error: 'ProposalFailed', rule: 'without quorum and a strict majority nothing executes' },
        { instruction: 'execute_proposal', error: 'OverProposalCap', rule: 'one proposal cannot move more than the per-proposal share of the vault' },
        { instruction: 'execute_proposal', error: 'WrongDestination', rule: 'the destination is fixed when the proposal is made' },
        { instruction: 'execute_proposal', error: 'ProposalExpired', rule: 'a passed proposal expires if it is not executed in time' },
        { instruction: 'execute_proposal', error: 'AlreadyExecuted', rule: 'a proposal executes once' },
      ],
      absence: null,
    });
  } else {
    extCards.push({
      id: 'no-vote',
      kind: 'not-provided',
      title: 'Holding the coin gives no vote',
      statement:
        x === null
          ? "Holders do not approve or veto spending, set the allowance, or choose the authority. Within the allowance and while attested, the authority needs nobody's approval. Spending above the allowance is not possible at all."
          : "This treasury was extended with voting switched off: holders do not approve or veto spending. Within the allowance and while attested, the authority needs nobody's approval; spending above the allowance is not possible.",
      now: extNow,
      enforcedBy: [
        {
          instruction: 'propose',
          error: x === null ? 'NotExtended' : 'Disabled',
          rule: x === null ? 'a proposal on a treasury that was never extended is refused' : 'a proposal on a treasury whose vote period is zero is refused',
        },
      ],
      absence: null,
    });
  }

  if (x?.nav) {
    const n = x.nav;
    extCards.push({
      id: 'nav-redemption',
      kind: 'entitles',
      title: 'While the NAV window is open, holders can redeem at net asset value',
      statement: `When the window is open (by a holder vote, or automatically after a revenue round is missed), a holder can burn coins for floor(vault × coins burned ÷ coin supply) quote tokens, up to ${pct(n.capBps)} of the supply in each ${formatDuration(n.periodSecs)} period. The authority and ${n.insiders.length} other listed key${n.insiders.length === 1 ? '' : 's'} cannot redeem this way. The team cannot spend while the window is open, so redemption is against an intact vault. Rounding is down, so a redemption never lowers the value of the coins that stay.`,
      now: liquidating ? 'Not available: the treasury is in liquidation (redemption is the snapshot redeem).' : n.open ? 'The NAV window is open now.' : 'The NAV window is closed now.',
      enforcedBy: [
        { instruction: 'nav_redeem', error: 'NavClosed', rule: 'refused while the window is closed' },
        { instruction: 'nav_redeem', error: 'NavLimit', rule: 'the per-period cap on burned coins' },
        { instruction: 'nav_redeem', error: 'InsiderExcluded', rule: 'insiders cannot redeem at NAV' },
        { instruction: 'nav_redeem', error: 'ZeroPayout', rule: 'a redemption that would pay nothing is refused' },
        { instruction: 'spend', error: 'NavMode', rule: 'the team cannot spend while the window is open' },
      ],
      absence: null,
    });
  }

  if (x?.revenue) {
    const r = x.revenue;
    extCards.push({
      id: 'revenue-rounds',
      kind: 'entitles',
      title: 'A share of verified revenue is owed to staked coins each round',
      statement: `Each ${formatDuration(r.roundSecs)} round, ${pct(r.shareBps)} of the revenue attested for that round is due into the stakers' pot. Anyone can pay it once the round is over, within ${formatDuration(r.payGraceSecs)}. A round not paid in time can be marked missed by anyone, which opens the NAV window and freezes the team's spending. The revenue figure is whatever the named attester signs: the program does not check it against any payment record.`,
      now: `${r.missedRounds} round${r.missedRounds === 1 ? '' : 's'} missed so far.${r.trancheAmount > 0n ? ` A tranche of ${q(r.trancheAmount)} can be released to the team once per round that met the revenue bar.` : ''}`,
      enforcedBy: [
        { instruction: 'pay_round', error: 'RoundOpen', rule: 'a round cannot be paid before it ends' },
        { instruction: 'pay_round', error: 'RoundClosed', rule: 'a round cannot be paid after the payment window' },
        { instruction: 'pay_round', error: 'NotAttested', rule: 'there is no payment without an attested revenue figure' },
        { instruction: 'pay_round', error: 'BadRevenueData', rule: 'the attested data must be a revenue figure' },
        { instruction: 'mark_missed', error: 'RoundNotLate', rule: 'a round is missed only after its payment window closed' },
        { instruction: 'release_tranche', error: 'TrancheNotEligible', rule: 'a tranche releases only for a paid round that met the revenue bar' },
      ],
      absence: null,
    });
  }

  if (x) {
    extCards.push({
      id: 'staker-distributions',
      kind: 'entitles',
      title: 'Staked coins share any quote tokens deposited for them',
      statement: `A holder can stake coins; anyone can deposit quote tokens, and they are shared among the staked coins exactly (an accumulator, rounded down, never paying out more than was deposited)${x.streamSecs > 0n ? `, streaming over ${formatDuration(x.streamSecs)} so a coin staked for a moment earns a moment's share` : ' at once'}. Unstaking and claiming are never blocked, including in liquidation. Coins that are not staked earn nothing from these deposits.`,
      now: `${x.totalStaked.toString()} coin atoms are staked now.`,
      enforcedBy: [
        { instruction: 'claim_distribution', error: 'NothingToClaim', rule: 'a claim with nothing earned is refused' },
        { instruction: 'stake', error: 'Liquidating', rule: 'no new stakes once liquidation has started' },
        { instruction: 'deposit_distribution', error: 'Liquidating', rule: 'no new deposits once liquidation has started' },
      ],
      absence: null,
    });
    extCards.push({
      id: 'team-grants',
      kind: 'protects',
      title: 'Team coins granted through the treasury are locked, and unearned ones are burned',
      statement: `The authority can escrow coins in the program as a grant with a lockup of at least ${formatDuration(x.minLockupSecs)} and milestone shares. Nothing releases before the lockup; an earn-out milestone also needs an attestation; the unearned rest is burned at expiry, so it cannot be sold; an unvested grant is left out of the liquidation snapshot. Coins the team holds outside a grant are not covered.`,
      now: `${x.grantsUnreleased.toString()} coin atoms are escrowed in unreleased grants.`,
      enforcedBy: [
        { instruction: 'create_grant', error: 'LockupTooShort', rule: 'a grant lockup below the treasury minimum is refused' },
        { instruction: 'create_grant', error: 'GrantInvalid', rule: 'milestone shares, expiry and amount must be consistent' },
        { instruction: 'release_milestone', error: 'MilestoneNotReady', rule: 'no release before the lockup ends' },
        { instruction: 'release_milestone', error: 'WrongBeneficiary', rule: "coins go only to the grant's beneficiary" },
        { instruction: 'release_milestone', error: 'AlreadyReleased', rule: 'a milestone releases once' },
        { instruction: 'expire_grant', error: 'GrantNotExpired', rule: 'unearned coins are burned only after expiry' },
      ],
      absence: null,
    });
  }

  if (x?.disclosure) {
    const d = x.disclosure;
    extCards.push({
      id: 'disclosure-requests',
      kind: 'protects',
      title: 'A holder can demand a disclosure, and the team cannot spend while it is overdue',
      statement: `A holder of at least ${pct(d.requestMinBps)} of the supply can request a disclosure. The authority then has ${formatDuration(d.periodSecs)} to post one (the program records its hash, time and count); while a request is overdue, every outflow to the team is refused. The program stores a hash only: it does not read or judge the document.`,
      now: d.openRequestTs === null ? `No request is open. ${d.disclosures} disclosure${d.disclosures === 1 ? '' : 's'} posted so far.` : `A request opened at ${formatTime(d.openRequestTs)} is waiting for a post.`,
      enforcedBy: [
        { instruction: 'request_disclosure', error: 'NotHolder', rule: 'only a holder of the minimum share can request' },
        { instruction: 'post_disclosure', error: 'Unauthorized', rule: 'only the authority can post' },
        { instruction: 'spend', error: 'DisclosureOverdue', rule: 'outflows to the team are refused while a request is overdue' },
      ],
      absence: null,
    });
  }

  if (x?.assignment) {
    extCards.push({
      id: 'assignment-gate',
      kind: 'protects',
      title: 'The team cannot spend until the IP and asset assignment is attested',
      statement:
        "This treasury requires an attestation, from the credential and schema fixed at extension, that the company's IP and assets are assigned to the entity the coin represents. Until it is recorded, every outflow to the team is refused. The program checks that the attestation exists; it does not read what it says.",
      now: x.assignment.assigned ? 'The assignment is recorded.' : 'The assignment is not recorded yet, so the team cannot spend.',
      enforcedBy: [
        { instruction: 'record_assignment', error: 'NotAttested', rule: 'recorded only against a live attestation' },
        { instruction: 'record_assignment', error: 'AlreadyAssigned', rule: 'recorded once' },
        { instruction: 'spend', error: 'AssignmentRequired', rule: 'outflows are refused until the assignment is recorded' },
      ],
      absence: null,
    });
  }

  if (x?.windDown) {
    const w = x.windDown;
    extCards.push({
      id: 'wind-down',
      kind: 'entitles',
      title: 'After liquidation, redemption stays open for a fixed window before any sweep',
      statement: `Redemption stays open for ${formatDuration(w.windowSecs)} after liquidation starts (the program refuses a window under 180 days). Only after it can anyone sweep what is left, once, to the recovery account fixed when the treasury was extended (${w.recovery}). After the sweep redemption is refused. The recovery account is the team's choice; funds are never pushed to holders, because redeeming burns the holder's own coins.`,
      now: w.swept ? 'The leftover was swept; redemption is closed.' : w.windStart === null ? 'The window starts when liquidation starts.' : `The window ends at ${formatTime(w.windStart + w.windowSecs)}.`,
      enforcedBy: [
        { instruction: 'sweep_unclaimed', error: 'NotLiquidating', rule: 'no sweep before liquidation' },
        { instruction: 'sweep_unclaimed', error: 'WindowOpen', rule: 'no sweep before the window ends' },
        { instruction: 'sweep_unclaimed', error: 'WrongRecovery', rule: 'the sweep goes only to the recovery account named in advance' },
        { instruction: 'sweep_unclaimed', error: 'AlreadySwept', rule: 'a sweep happens once' },
        { instruction: 'redeem', error: 'WoundDown', rule: 'redemption is refused after the sweep' },
      ],
      absence: null,
    });
  }

  extCards.push({
    id: 'extend-once',
    kind: 'caveat',
    title: 'The team can extend the treasury once, with limits',
    statement:
      'The authority can call init_ext one time to switch on votes, NAV redemption, revenue rounds, disclosure requests, the assignment gate and the wind-down sweep. Every setting is fixed afterwards. The program refuses weak settings (a vote under 3 days, a quorum under 10%, a majority under 50%, a sweep window under 180 days). The extension exists in the program source; a deployed program version without it has none of these instructions.',
    now: extNow,
    enforcedBy: [
      { instruction: 'init_ext', error: 'Unauthorized', rule: 'only the treasury authority can extend' },
      { instruction: 'init_ext', error: 'AlreadyExtended', rule: 'a treasury is extended once' },
      { instruction: 'init_ext', error: 'InvalidParams', rule: 'weak or half-configured settings are refused' },
    ],
    absence: null,
  });

  const up = f.programUpgradeAuthority;
  const upgradeCard: RightsCard = {
    id: 'program-upgradeable',
    kind: 'caveat',
    title: up === null ? 'The program cannot be changed' : 'These rules last only while the program is not replaced',
    statement:
      up === null
        ? 'The treasury program has no upgrade authority, so the rules on these cards are fixed for as long as the program exists.'
        : 'Every rule on these cards is a property of the deployed program code. A program with an upgrade authority can be replaced by whoever holds that key, and the new code could enforce different rules.',
    now: up === null ? 'No upgrade authority is set.' : up === 'unknown' ? 'The upgrade authority could not be read just now.' : `Upgrade authority: ${up}.`,
    enforcedBy: [],
    absence: 'This is a property of the program account on the loader, not of an instruction in the program.',
  };

  return [
    {
      id: 'spend-cap',
      kind: 'protects',
      title: 'The team can spend only a capped allowance',
      statement: `The treasury authority can move at most ${q(f.allowance)} out of the vault in each ${formatDuration(f.periodSecs)} period. Allowance not spent in a period does not carry over.`,
      now: spendNow,
      enforcedBy: [{ instruction: 'spend', error: 'OverAllowance', rule: 'a spend that takes the period total above the allowance is refused' }],
      absence: null,
    },
    {
      id: 'spend-gate',
      kind: 'protects',
      title: 'Spending needs a live attestation',
      statement:
        'The team can spend only while a Solana Attestation Service attestation for this treasury, from the credential and schema fixed at creation, exists and has not expired. The attesting party, not the team, renews it.',
      now: attestNow,
      enforcedBy: [
        { instruction: 'spend', error: 'NotAttested', rule: 'a spend with no live attestation is refused' },
        { instruction: 'spend', error: 'WrongAttestationAccount', rule: 'the attestation account passed must be the one derived from this treasury' },
      ],
      absence: null,
    },
    {
      id: 'only-the-team',
      kind: 'protects',
      title: 'Only the treasury authority can spend',
      statement: `Spending is signed by the treasury authority ${f.authority}. Nobody else can move the vault's funds before liquidation.`,
      now: null,
      enforcedBy: [{ instruction: 'spend', error: 'Unauthorized', rule: 'the signer must be the authority stored in the treasury account' }],
      absence: null,
    },
    {
      id: 'terms-fixed',
      kind: 'protects',
      title: 'The terms cannot be changed after creation',
      statement: `The allowance, period (${formatDuration(f.periodSecs)}), grace period (${formatDuration(f.graceSecs)}), attestation credential and schema, and the authority are written once at creation. The extension's settings, if the team adds them, are also written once (see the card on extending).`,
      now: null,
      enforcedBy: [],
      absence: `${NO_INSTRUCTION} rewrites any of them after creation.`,
    },
    {
      id: 'fixed-supply',
      kind: 'protects',
      title: 'The coin supply is fixed, so the snapshot cannot be diluted',
      statement:
        'A treasury can be created only over a coin whose mint authority has been revoked. A revoked mint authority cannot be set again, so no coins can be minted into a liquidation snapshot.',
      now: f.coinMintAuthority === null ? 'The coin mint has no mint authority now.' : `The coin mint's mint authority is ${f.coinMintAuthority}.`,
      enforcedBy: [{ instruction: 'create_treasury', error: 'SupplyNotFixed', rule: 'creation is refused while the coin mint still has a mint authority' }],
      absence: null,
    },
    {
      id: 'anyone-records-lapse',
      kind: 'entitles',
      title: 'Anyone can record that the attestation lapsed',
      statement: `Any wallet, holder or not, can record that the attestation is missing or expired. That starts a grace period of ${formatDuration(f.graceSecs)}. Anyone can also record that a live attestation is back, which clears the lapse.`,
      now: lapseNow,
      enforcedBy: [
        { instruction: 'record_lapse', error: 'StillAttested', rule: 'a lapse can be recorded only while there is no live attestation' },
        { instruction: 'record_attested', error: 'NotAttested', rule: 'a lapse is cleared only by a live attestation' },
      ],
      absence: null,
    },
    {
      id: 'anyone-triggers-liquidation',
      kind: 'entitles',
      title: 'Anyone can start liquidation after the grace period',
      statement: `If a recorded lapse lasts the full grace period of ${formatDuration(f.graceSecs)}, any wallet can move the treasury into liquidation. Before then, or with no lapse recorded, it is refused.`,
      now: triggerNow,
      enforcedBy: [
        { instruction: 'trigger_liquidation', error: 'NoLapse', rule: 'refused when no lapse is recorded' },
        { instruction: 'trigger_liquidation', error: 'GraceNotOver', rule: 'refused until the grace period after the recorded lapse has passed' },
      ],
      absence: null,
    },
    {
      id: 'redeem-pro-rata',
      kind: 'entitles',
      title: 'After liquidation, every holder can redeem pro rata',
      statement:
        'Once liquidation has started, a holder can burn coins for floor(snapshot vault × coins burned ÷ snapshot supply) quote tokens. The snapshot of the vault and the coin supply is taken at liquidation. Rounding is down, and the remainder stays in the vault.',
      now: redeemNow,
      enforcedBy: [
        { instruction: 'redeem', error: 'NotLiquidating', rule: 'refused before liquidation' },
        { instruction: 'redeem', error: null, rule: 'the payout is snapshot_vault × amount ÷ snapshot_supply, rounded down, paid from the vault after the coins are burned' },
      ],
      absence: null,
    },
    {
      id: 'liquidation-final',
      kind: 'protects',
      title: 'Liquidation cannot be undone',
      statement: 'Once liquidation starts, the team can no longer spend and a renewed attestation cannot revive the treasury. The only remaining path is redemption by holders.',
      now: liquidating ? 'This treasury is in liquidation.' : null,
      enforcedBy: [
        { instruction: 'spend', error: 'Liquidating', rule: 'spending is refused in liquidation' },
        { instruction: 'record_attested', error: 'Liquidating', rule: 'a renewed attestation cannot clear the state' },
      ],
      absence: null,
    },
    {
      id: 'late-deposits',
      kind: 'not-provided',
      title: 'Funds sent to the vault after the snapshot are not shared out',
      statement:
        'Redemption pays from the snapshot taken at liquidation. Quote tokens that arrive in the vault afterwards are not part of any holder\'s share, and the program has no way to distribute them.',
      now: null,
      enforcedBy: [
        { instruction: 'redeem', error: null, rule: 'the payout uses snapshot_vault, not the live vault balance' },
        { instruction: 'deposit_distribution', error: 'Liquidating', rule: 'no deposit for stakers once liquidation has started' },
      ],
      absence: `${NO_INSTRUCTION} takes a second snapshot.`,
    },
    ...extCards.filter((c) => c.id === 'holder-votes' || c.id === 'no-vote'),
    {
      id: 'no-income',
      kind: 'not-provided',
      title: x === null ? 'The coin does not pay income while the treasury is active' : 'Coins that are not staked earn nothing',
      statement:
        x === null
          ? 'Holding the coin entitles you to nothing from the vault before liquidation: no dividend, no buyback, no claim on revenue. The only claim the program creates is redemption after liquidation.'
          : 'Holding the coin alone entitles you to nothing from the vault before liquidation. Quote tokens deposited for stakers go to staked coins only, and a NAV redemption or a grant is the only other way coins are paid out of the treasury. There is no dividend to a wallet that does not stake and no buyback.',
      now: null,
      enforcedBy: [],
      absence:
        x === null
          ? `${NO_INSTRUCTION} pays or reserves anything to holders other than redeem; the extension instructions refuse with NotExtended.`
          : `${NO_INSTRUCTION} pays a wallet that did not stake, other than redeem, nav_redeem and a grant's own release.`,
    },
    ...extCards.filter((c) => c.id !== 'holder-votes' && c.id !== 'no-vote' && c.id !== 'extend-once'),
    {
      id: 'no-use-limit',
      kind: 'not-provided',
      title: 'The program does not limit what spent funds are used for',
      statement: 'A spend can go to any token account of the quote token. The allowance caps how much, not where it goes or what for.',
      now: null,
      enforcedBy: [],
      absence: 'spend accepts any destination token account of the quote mint and records only the amount and destination in its event.',
    },
    {
      id: 'attestation-content',
      kind: 'not-provided',
      title: 'The program does not read or judge the attested report',
      statement:
        'It checks that a live attestation exists for this treasury from the configured credential and schema. It does not read what the attestation says, so it cannot tell whether a report is true, complete or good. That judgement belongs to the party that attests.',
      now: null,
      enforcedBy: [],
      absence: 'the attestation parser reads the nonce, credential, schema and expiry only, never the attested data.',
    },
    {
      id: 'no-team-lock',
      kind: 'not-provided',
      title: x === null ? "No lock or vesting on the team's own coins" : 'No lock on team coins held outside a grant',
      statement:
        x === null
          ? "This program holds quote tokens and enforces the allowance. It does not lock, vest or restrict any holder's coins, the team's included."
          : "Only coins escrowed through a grant are locked. The program does not lock, vest or restrict any other coins, the team's included.",
      now: null,
      enforcedBy: [],
      absence: `${NO_INSTRUCTION} locks or vests coins other than create_grant's escrow${x === null ? ' (which refuses with NotExtended)' : ''}.`,
    },
    extCards.find((c) => c.id === 'extend-once')!,
    upgradeCard,
  ];
}
