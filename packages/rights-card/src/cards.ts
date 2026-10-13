// Rights cards for an ownership-coin treasury (programs/treasury, ADR-0014).
//
// A card says what a holder, the team or any stranger can rely on, or cannot. Every statement is one of two kinds:
//   - an enforced rule: cited to the instruction and the program error that enforce it (`enforcedBy`), or
//   - an absence: the program has no instruction that does the thing (`absence`). test/program.test.ts keeps the instruction
//     list below equal to the program source, so adding an instruction fails the build until the cards are re-derived.
// Nothing here promises anything the program does not do. The `now` line of a card is read from the facts passed in (chain state).
import { formatAtoms, formatDuration, formatTime } from './format.js';

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
export const PROGRAM_INSTRUCTIONS = ['create_treasury', 'spend', 'record_lapse', 'record_attested', 'trigger_liquidation', 'redeem'] as const;

const NO_INSTRUCTION = 'The program has six instructions (create_treasury, spend, record_lapse, record_attested, trigger_liquidation, redeem) and none of them';

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
      statement: `The allowance, period (${formatDuration(f.periodSecs)}), grace period (${formatDuration(f.graceSecs)}), attestation credential and schema, and the authority are written once at creation.`,
      now: null,
      enforcedBy: [],
      absence: `${NO_INSTRUCTION} writes any of them after creation.`,
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
      enforcedBy: [{ instruction: 'redeem', error: null, rule: 'the payout uses snapshot_vault, not the live vault balance' }],
      absence: `${NO_INSTRUCTION} takes a second snapshot.`,
    },
    {
      id: 'no-vote',
      kind: 'not-provided',
      title: 'Holding the coin gives no vote',
      statement:
        'Holders do not approve or veto spending, set the allowance, or choose the authority. Within the allowance and while attested, the authority needs nobody\'s approval. Spending above the allowance is not possible at all.',
      now: null,
      enforcedBy: [],
      absence: `${NO_INSTRUCTION} lets holders vote, propose or approve.`,
    },
    {
      id: 'no-income',
      kind: 'not-provided',
      title: 'The coin does not pay income while the treasury is active',
      statement:
        'Holding the coin entitles you to nothing from the vault before liquidation: no dividend, no buyback, no claim on revenue. The only claim the program creates is redemption after liquidation.',
      now: null,
      enforcedBy: [],
      absence: `${NO_INSTRUCTION} pays or reserves anything to holders other than redeem.`,
    },
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
      title: 'No lock or vesting on the team\'s own coins',
      statement: 'This program holds quote tokens and enforces the allowance. It does not lock, vest or restrict any holder\'s coins, the team\'s included.',
      now: null,
      enforcedBy: [],
      absence: `${NO_INSTRUCTION} locks or vests coins.`,
    },
    upgradeCard,
  ];
}
