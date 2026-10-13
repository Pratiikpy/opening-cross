// The checks `init_ext` makes (programs/treasury/src/ext.rs `ExtParams::validate` and `ops.rs`), run before a transaction is built, so a team
// reads the reason before signing. The program is the authority: this mirrors it.
import type { Address } from '@solana/kit';
import type { InitExtInstructionDataArgs } from './generated/instructions/initExt.js';

const DAY = 86_400n;
export const MIN_WINDOW_SECS = 180n * DAY;
export const MIN_VOTE_PERIOD_SECS = 3n * DAY;
export const MIN_TIMELOCK_SECS = DAY;
export const MIN_QUORUM_BPS = 1_000;
export const MIN_THRESHOLD_BPS = 5_000;
export const MIN_STREAM_SECS = 3_600n;
const ZERO = '11111111111111111111111111111111' as Address;

/** `refused`: the program rejects these parameters. `advice`: the program accepts them, but the treasury would be left unusable or unsafe. */
export type ExtIssue = { code: string; field: string; message: string; severity: 'refused' | 'advice' };

/** Every issue with `p`, for a treasury extended at unix time `now`. The program accepts the parameters when no issue has severity `refused`. */
export function checkExtParams(p: InitExtInstructionDataArgs, now: bigint): ExtIssue[] {
  const out: ExtIssue[] = [];
  const bad = (code: string, field: string, message: string, severity: ExtIssue['severity'] = 'refused') => out.push({ code, field, message, severity });
  const vote = BigInt(p.votePeriodSecs);
  if (vote !== 0n) {
    if (vote < MIN_VOTE_PERIOD_SECS) bad('VOTE_PERIOD', 'votePeriodSecs', 'a vote lasts at least three days');
    if (BigInt(p.timelockSecs) < MIN_TIMELOCK_SECS) bad('TIMELOCK', 'timelockSecs', 'a passed proposal waits at least one day before it can run');
    if (p.quorumBps < MIN_QUORUM_BPS || p.quorumBps > 10_000) bad('QUORUM', 'quorumBps', 'the quorum is between 10% and 100% of the supply');
    if (p.thresholdBps < MIN_THRESHOLD_BPS || p.thresholdBps >= 10_000) bad('THRESHOLD', 'thresholdBps', 'the majority is above 50% and below 100% of the votes cast');
    if (p.maxProposalBps <= 0 || p.maxProposalBps > 10_000) bad('PROPOSAL_CAP', 'maxProposalBps', 'a proposal may spend between 0.01% and 100% of the vault');
    if (p.proposerMinBps > 10_000) bad('PROPOSER_MIN', 'proposerMinBps', 'the proposer\'s minimum holding is at most 100% of the supply');
  }
  if (BigInt(p.navPeriodSecs) !== 0n && (p.navCapBps <= 0 || p.navCapBps > 10_000)) bad('NAV_CAP', 'navCapBps', 'a NAV window needs a per-period redemption cap between 0.01% and 100% of the supply');
  if (p.revShareBps !== 0) {
    if (p.revShareBps > 10_000) bad('REV_SHARE', 'revShareBps', 'the holders\' share of revenue is at most 100%');
    if (BigInt(p.roundSecs) <= 0n || BigInt(p.payGraceSecs) <= 0n) bad('ROUNDS', 'roundSecs', 'revenue rounds and their grace period have a length');
    if (BigInt(p.revStart) <= 0n) bad('REV_START', 'revStart', 'revenue rounds are counted from a start time');
    else if (BigInt(p.revStart) < now) bad('REV_START_PAST', 'revStart', 'the first revenue round starts now or later; one in the past would let anyone mark round zero missed at once');
  }
  if (BigInt(p.trancheAmount) !== 0n && p.revShareBps === 0) bad('TRANCHE', 'trancheAmount', 'a revenue tranche needs revenue rounds');
  if (BigInt(p.disclosurePeriodSecs) !== 0n) {
    if (BigInt(p.disclosurePeriodSecs) < DAY) bad('DISCLOSURE_PERIOD', 'disclosurePeriodSecs', 'the disclosure deadline is at least one day');
    if (p.requestMinBps > 10_000) bad('REQUEST_MIN', 'requestMinBps', 'the minimum holding to request a disclosure is at most 100% of the supply');
  }
  if (BigInt(p.windowSecs) !== 0n) {
    if (BigInt(p.windowSecs) < MIN_WINDOW_SECS) bad('WINDOW', 'windowSecs', 'the wind-down window is at least 180 days');
    if (p.recovery === ZERO) bad('RECOVERY', 'recovery', 'a wind-down names the account that receives what holders did not redeem');
  }
  if (BigInt(p.streamSecs) !== 0n && BigInt(p.streamSecs) < MIN_STREAM_SECS) bad('STREAM', 'streamSecs', 'a distribution stream is at least an hour: a shorter one is no defence against staking for one block to catch a deposit');
  if (BigInt(p.minLockupSecs) < 0n) bad('MIN_LOCKUP', 'minLockupSecs', 'the minimum grant lockup is not negative');
  if (p.assignRequired && (p.assignCredential === ZERO || p.assignSchema === ZERO)) bad('ASSIGNMENT', 'assignCredential', 'the assignment gate names counsel\'s credential and schema; with none, the gate can never open and the team can never spend', 'advice');
  if (p.revShareBps !== 0 && (p.revCredential === ZERO || p.revSchema === ZERO)) bad('REV_ATTESTER', 'revCredential', 'revenue rounds name the credential and schema of the attester; with none, no round can ever be paid and every round will be missed', 'advice');
  return out;
}
