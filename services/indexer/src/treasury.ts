// Indexer for the ownership-coin treasury program (programs/treasury, ADR-0014 and the extension of ADR-0470 to ADR-0476).
//
// Same discipline as the cross_core indexer: events are attributed by the invoke stack (a data line counts only while the treasury
// program is on top, so a look-alike payload written by another program is ignored), a failed transaction changes nothing, one
// database transaction per chain transaction, and a signature already ingested is a no-op. The poller reads at `finalized` and keeps
// its own cursor in the shared `cursors` table under `rpc:<treasury program>`.
//
// The first release emitted five events; the extension emits twenty more. A treasury on the first release never emits them, so
// nothing here depends on them, and the tables they feed stay empty for it. Three events name a proposal or a grant instead of the
// treasury (a vote, an execution, a milestone): they are attributed through the proposals and grants already indexed.
//
// Not in the events, so not indexed: the attestation being renewed (`record_attested` emits nothing) and the current period's spend
// window. The API reads those from the treasury account itself.
import type { Address, Signature } from '@solana/kit';
import type pg from 'pg';
import {
  ASSIGNMENT_RECORDED_EVENT_DISCRIMINATOR,
  ATTESTATION_LAPSED_EVENT_DISCRIMINATOR,
  DISCLOSURE_POSTED_EVENT_DISCRIMINATOR,
  DISCLOSURE_REQUESTED_EVENT_DISCRIMINATOR,
  DISTRIBUTION_CLAIMED_EVENT_DISCRIMINATOR,
  DISTRIBUTION_DEPOSITED_EVENT_DISCRIMINATOR,
  GRANT_CREATED_EVENT_DISCRIMINATOR,
  GRANT_EXPIRED_EVENT_DISCRIMINATOR,
  LIQUIDATION_STARTED_EVENT_DISCRIMINATOR,
  MILESTONE_RELEASED_EVENT_DISCRIMINATOR,
  NAV_REDEEMED_EVENT_DISCRIMINATOR,
  PROPOSAL_CREATED_EVENT_DISCRIMINATOR,
  PROPOSAL_EXECUTED_EVENT_DISCRIMINATOR,
  REDEEMED_EVENT_DISCRIMINATOR,
  ROUND_MISSED_EVENT_DISCRIMINATOR,
  ROUND_PAID_EVENT_DISCRIMINATOR,
  SPENT_EVENT_DISCRIMINATOR,
  STAKED_EVENT_DISCRIMINATOR,
  TRANCHE_RELEASED_EVENT_DISCRIMINATOR,
  TREASURY_CREATED_EVENT_DISCRIMINATOR,
  TREASURY_EXTENDED_EVENT_DISCRIMINATOR,
  TREASURY_PROGRAM_ADDRESS,
  UNCLAIMED_SWEPT_EVENT_DISCRIMINATOR,
  UNSTAKED_EVENT_DISCRIMINATOR,
  VOTED_EVENT_DISCRIMINATOR,
  VOTE_RECLAIMED_EVENT_DISCRIMINATOR,
  type AssignmentRecordedEvent,
  type AttestationLapsedEvent,
  type DisclosurePostedEvent,
  type DisclosureRequestedEvent,
  type DistributionClaimedEvent,
  type DistributionDepositedEvent,
  type GrantCreatedEvent,
  type GrantExpiredEvent,
  type LiquidationStartedEvent,
  type MilestoneReleasedEvent,
  type NavRedeemedEvent,
  type ProposalCreatedEvent,
  type ProposalExecutedEvent,
  type RedeemedEvent,
  type RoundMissedEvent,
  type RoundPaidEvent,
  type SpentEvent,
  type StakedEvent,
  type TrancheReleasedEvent,
  type TreasuryCreatedEvent,
  type TreasuryExtendedEvent,
  type UnclaimedSweptEvent,
  type UnstakedEvent,
  type VoteReclaimedEvent,
  type VotedEvent,
  getAssignmentRecordedEventDecoder,
  getAttestationLapsedEventDecoder,
  getDisclosurePostedEventDecoder,
  getDisclosureRequestedEventDecoder,
  getDistributionClaimedEventDecoder,
  getDistributionDepositedEventDecoder,
  getGrantCreatedEventDecoder,
  getGrantExpiredEventDecoder,
  getLiquidationStartedEventDecoder,
  getMilestoneReleasedEventDecoder,
  getNavRedeemedEventDecoder,
  getProposalCreatedEventDecoder,
  getProposalExecutedEventDecoder,
  getRedeemedEventDecoder,
  getRoundMissedEventDecoder,
  getRoundPaidEventDecoder,
  getSpentEventDecoder,
  getStakedEventDecoder,
  getTrancheReleasedEventDecoder,
  getTreasuryCreatedEventDecoder,
  getTreasuryExtendedEventDecoder,
  getUnclaimedSweptEventDecoder,
  getUnstakedEventDecoder,
  getVoteReclaimedEventDecoder,
  getVotedEventDecoder,
} from '@opening-cross/treasury-client';
import { UnattributableLogs, toJson } from './decode.js';
import type { ChainTx } from './ingest.js';
import type { IndexerRpc as Rpc } from './rpc.js';
import { recordMovement } from './treasury-movements.js';

export type TreasuryEventRecord =
  | { name: 'TreasuryCreated'; data: TreasuryCreatedEvent }
  | { name: 'Spent'; data: SpentEvent }
  | { name: 'AttestationLapsed'; data: AttestationLapsedEvent }
  | { name: 'LiquidationStarted'; data: LiquidationStartedEvent }
  | { name: 'Redeemed'; data: RedeemedEvent }
  | { name: 'TreasuryExtended'; data: TreasuryExtendedEvent }
  | { name: 'ProposalCreated'; data: ProposalCreatedEvent }
  | { name: 'Voted'; data: VotedEvent }
  | { name: 'VoteReclaimed'; data: VoteReclaimedEvent }
  | { name: 'ProposalExecuted'; data: ProposalExecutedEvent }
  | { name: 'NavRedeemed'; data: NavRedeemedEvent }
  | { name: 'Staked'; data: StakedEvent }
  | { name: 'Unstaked'; data: UnstakedEvent }
  | { name: 'DistributionDeposited'; data: DistributionDepositedEvent }
  | { name: 'DistributionClaimed'; data: DistributionClaimedEvent }
  | { name: 'RoundPaid'; data: RoundPaidEvent }
  | { name: 'RoundMissed'; data: RoundMissedEvent }
  | { name: 'TrancheReleased'; data: TrancheReleasedEvent }
  | { name: 'GrantCreated'; data: GrantCreatedEvent }
  | { name: 'MilestoneReleased'; data: MilestoneReleasedEvent }
  | { name: 'GrantExpired'; data: GrantExpiredEvent }
  | { name: 'DisclosurePosted'; data: DisclosurePostedEvent }
  | { name: 'DisclosureRequested'; data: DisclosureRequestedEvent }
  | { name: 'AssignmentRecorded'; data: AssignmentRecordedEvent }
  | { name: 'UnclaimedSwept'; data: UnclaimedSweptEvent };

const DECODERS: [Uint8Array, TreasuryEventRecord['name'], { decode(b: Uint8Array): unknown }][] = [
  [TREASURY_CREATED_EVENT_DISCRIMINATOR as Uint8Array, 'TreasuryCreated', getTreasuryCreatedEventDecoder()],
  [SPENT_EVENT_DISCRIMINATOR as Uint8Array, 'Spent', getSpentEventDecoder()],
  [ATTESTATION_LAPSED_EVENT_DISCRIMINATOR as Uint8Array, 'AttestationLapsed', getAttestationLapsedEventDecoder()],
  [LIQUIDATION_STARTED_EVENT_DISCRIMINATOR as Uint8Array, 'LiquidationStarted', getLiquidationStartedEventDecoder()],
  [REDEEMED_EVENT_DISCRIMINATOR as Uint8Array, 'Redeemed', getRedeemedEventDecoder()],
  [TREASURY_EXTENDED_EVENT_DISCRIMINATOR as Uint8Array, 'TreasuryExtended', getTreasuryExtendedEventDecoder()],
  [PROPOSAL_CREATED_EVENT_DISCRIMINATOR as Uint8Array, 'ProposalCreated', getProposalCreatedEventDecoder()],
  [VOTED_EVENT_DISCRIMINATOR as Uint8Array, 'Voted', getVotedEventDecoder()],
  [VOTE_RECLAIMED_EVENT_DISCRIMINATOR as Uint8Array, 'VoteReclaimed', getVoteReclaimedEventDecoder()],
  [PROPOSAL_EXECUTED_EVENT_DISCRIMINATOR as Uint8Array, 'ProposalExecuted', getProposalExecutedEventDecoder()],
  [NAV_REDEEMED_EVENT_DISCRIMINATOR as Uint8Array, 'NavRedeemed', getNavRedeemedEventDecoder()],
  [STAKED_EVENT_DISCRIMINATOR as Uint8Array, 'Staked', getStakedEventDecoder()],
  [UNSTAKED_EVENT_DISCRIMINATOR as Uint8Array, 'Unstaked', getUnstakedEventDecoder()],
  [DISTRIBUTION_DEPOSITED_EVENT_DISCRIMINATOR as Uint8Array, 'DistributionDeposited', getDistributionDepositedEventDecoder()],
  [DISTRIBUTION_CLAIMED_EVENT_DISCRIMINATOR as Uint8Array, 'DistributionClaimed', getDistributionClaimedEventDecoder()],
  [ROUND_PAID_EVENT_DISCRIMINATOR as Uint8Array, 'RoundPaid', getRoundPaidEventDecoder()],
  [ROUND_MISSED_EVENT_DISCRIMINATOR as Uint8Array, 'RoundMissed', getRoundMissedEventDecoder()],
  [TRANCHE_RELEASED_EVENT_DISCRIMINATOR as Uint8Array, 'TrancheReleased', getTrancheReleasedEventDecoder()],
  [GRANT_CREATED_EVENT_DISCRIMINATOR as Uint8Array, 'GrantCreated', getGrantCreatedEventDecoder()],
  [MILESTONE_RELEASED_EVENT_DISCRIMINATOR as Uint8Array, 'MilestoneReleased', getMilestoneReleasedEventDecoder()],
  [GRANT_EXPIRED_EVENT_DISCRIMINATOR as Uint8Array, 'GrantExpired', getGrantExpiredEventDecoder()],
  [DISCLOSURE_POSTED_EVENT_DISCRIMINATOR as Uint8Array, 'DisclosurePosted', getDisclosurePostedEventDecoder()],
  [DISCLOSURE_REQUESTED_EVENT_DISCRIMINATOR as Uint8Array, 'DisclosureRequested', getDisclosureRequestedEventDecoder()],
  [ASSIGNMENT_RECORDED_EVENT_DISCRIMINATOR as Uint8Array, 'AssignmentRecorded', getAssignmentRecordedEventDecoder()],
  [UNCLAIMED_SWEPT_EVENT_DISCRIMINATOR as Uint8Array, 'UnclaimedSwept', getUnclaimedSweptEventDecoder()],
];

const INVOKE = /^Program (\w+) invoke \[\d+\]$/;
const EXIT = /^Program (\w+) (success|failed)/;
const DATA = 'Program data: ';

/** Treasury events written while the treasury program is the innermost running program. */
export function decodeTreasuryLogs(logs: readonly string[], program: Address = TREASURY_PROGRAM_ADDRESS): TreasuryEventRecord[] {
  const stack: string[] = [];
  const out: TreasuryEventRecord[] = [];
  for (const line of logs) {
    if (line === 'Log truncated') throw new UnattributableLogs('log output was truncated by the runtime');
    const inv = INVOKE.exec(line);
    if (inv) {
      stack.push(inv[1]!);
      continue;
    }
    const ex = EXIT.exec(line);
    if (ex) {
      if (stack.at(-1) !== ex[1]) throw new UnattributableLogs(`unbalanced exit for ${ex[1]}`);
      stack.pop();
      continue;
    }
    if (!line.startsWith(DATA) || stack.at(-1) !== program) continue;
    const bytes = Uint8Array.from(Buffer.from(line.slice(DATA.length), 'base64'));
    const match = DECODERS.find(([d]) => bytes.length >= 8 && d.every((b, i) => bytes[i] === b));
    if (!match) continue;
    out.push({ name: match[1], data: match[2].decode(bytes) } as TreasuryEventRecord);
  }
  return out;
}

/** The treasury an event belongs to: named in the event, or found through the proposal or grant it names. Null when the index has not seen that proposal or grant. */
async function treasuryOf(db: pg.PoolClient, ev: TreasuryEventRecord): Promise<string | null> {
  const d = ev.data as Record<string, unknown>;
  if (typeof d.treasury === 'string') return d.treasury;
  if (typeof d.proposal === 'string') return ((await db.query('SELECT treasury FROM treasury_proposals WHERE proposal = $1', [d.proposal])).rows[0]?.treasury as string | undefined) ?? null;
  if (typeof d.grant === 'string') return ((await db.query('SELECT treasury FROM treasury_grants WHERE grant_address = $1', [d.grant])).rows[0]?.treasury as string | undefined) ?? null;
  return null;
}

/** Returns how many events were newly applied (0 when the signature was already ingested or failed). */
export async function ingestTreasuryTransaction(db: pg.Pool, tx: ChainTx): Promise<number> {
  if (tx.err) return 0;
  const events = decodeTreasuryLogs(tx.logs);
  if (events.length === 0) return 0;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    let applied = 0;
    for (const [seq, ev] of events.entries()) {
      const treasury = await treasuryOf(client, ev);
      if (treasury === null) console.error(JSON.stringify({ at: new Date().toISOString(), warning: 'treasury event not attributable to an indexed treasury', event: ev.name, signature: tx.signature }));
      const res = await client.query(
        `INSERT INTO treasury_events (signature, seq, slot, block_time, name, treasury, payload)
         VALUES ($1, $2, $3, to_timestamp($4), $5, $6, $7) ON CONFLICT DO NOTHING`,
        [tx.signature, seq, tx.slot.toString(), tx.blockTime?.toString() ?? null, ev.name, treasury ?? '', JSON.stringify(toJson(ev.data))],
      );
      if (res.rowCount === 0) continue;
      await apply(client, ev, tx, treasury ?? '');
      // The event's movement of value, if it has one, in the same database transaction (ADR-0930).
      await recordMovement(client, { signature: tx.signature, seq, slot: tx.slot.toString(), blockTime: tx.blockTime?.toString() ?? null, treasury: treasury ?? '', name: ev.name, payload: toJson(ev.data) as Record<string, unknown> });
      applied++;
    }
    await client.query('COMMIT');
    return applied;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function apply(db: pg.PoolClient, ev: TreasuryEventRecord, tx: ChainTx, treasury: string): Promise<void> {
  const slot = tx.slot.toString();
  const at = tx.blockTime?.toString() ?? null;
  switch (ev.name) {
    case 'TreasuryCreated': {
      const d = ev.data;
      await db.query(
        `INSERT INTO treasuries (address, coin_mint, authority, allowance, period_secs, created_signature, created_slot, created_at, state, updated_slot)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'Active',$7) ON CONFLICT (address) DO NOTHING`,
        [d.treasury, d.coinMint, d.authority, d.allowance.toString(), d.periodSecs.toString(), tx.signature, slot, at],
      );
      return;
    }
    case 'Spent':
      await db.query(`UPDATE treasuries SET spent_total = spent_total + $2, spend_count = spend_count + 1, updated_slot = $3 WHERE address = $1`, [ev.data.treasury, ev.data.amount.toString(), slot]);
      return;
    case 'AttestationLapsed':
      await db.query(`UPDATE treasuries SET lapse_count = lapse_count + 1, last_lapse_at = $2, updated_slot = $3 WHERE address = $1`, [ev.data.treasury, ev.data.at.toString(), slot]);
      return;
    case 'LiquidationStarted':
      await db.query(`UPDATE treasuries SET state = 'Liquidating', liquidation_vault = $2, liquidation_supply = $3, liquidated_at = $4, updated_slot = $5 WHERE address = $1`, [ev.data.treasury, ev.data.vault.toString(), ev.data.supply.toString(), at, slot]);
      return;
    case 'Redeemed':
      await db.query(
        `UPDATE treasuries SET redeemed_burned = redeemed_burned + $2, redeemed_paid = redeemed_paid + $3, redemption_count = redemption_count + 1, updated_slot = $4 WHERE address = $1`,
        [ev.data.treasury, ev.data.burned.toString(), ev.data.paid.toString(), slot],
      );
      return;
    // ---- the extension
    case 'TreasuryExtended': {
      const d = ev.data;
      await db.query(
        `UPDATE treasuries SET extended = true, governance = $2, nav_enabled = $3, revenue_enabled = $4, disclosure_enabled = $5, assignment_required = $6, wind_down_enabled = $7, updated_slot = $8 WHERE address = $1`,
        [d.treasury, d.governance, d.nav, d.revenue, d.disclosure, d.assignmentRequired, d.windDown, slot],
      );
      return;
    }
    case 'ProposalCreated': {
      const d = ev.data;
      await db.query(
        `INSERT INTO treasury_proposals (proposal, treasury, id, proposer, kind, amount, destination, vote_end_ts, created_slot) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
        [d.proposal, d.treasury, d.id.toString(), d.proposer, d.kind, d.amount.toString(), d.destination, d.voteEndTs.toString(), slot],
      );
      await db.query(`UPDATE treasuries SET proposals_count = proposals_count + 1, updated_slot = $2 WHERE address = $1`, [d.treasury, slot]);
      return;
    }
    case 'Voted': {
      const d = ev.data;
      await db.query(`UPDATE treasury_proposals SET yes = $2, no = $3 WHERE proposal = $1`, [d.proposal, d.yes.toString(), d.no.toString()]);
      await db.query(
        `INSERT INTO treasury_votes (proposal, voter, yes, no, last_slot) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (proposal, voter) DO UPDATE SET yes = treasury_votes.yes + EXCLUDED.yes, no = treasury_votes.no + EXCLUDED.no, last_slot = EXCLUDED.last_slot`,
        [d.proposal, d.voter, d.support ? d.amount.toString() : '0', d.support ? '0' : d.amount.toString(), slot],
      );
      return;
    }
    case 'VoteReclaimed':
      await db.query(`UPDATE treasury_votes SET reclaimed = true, last_slot = $3 WHERE proposal = $1 AND voter = $2`, [ev.data.proposal, ev.data.voter, slot]);
      return;
    case 'ProposalExecuted': {
      const d = ev.data;
      await db.query(`UPDATE treasury_proposals SET executed = true, executed_slot = $2 WHERE proposal = $1`, [d.proposal, slot]);
      // kind 1 opens the NAV window, 2 closes it.
      if (d.kind === 1 || d.kind === 2) await db.query(`UPDATE treasuries SET nav_open = $2, updated_slot = $3 WHERE address = $1`, [treasury, d.kind === 1, slot]);
      return;
    }
    case 'NavRedeemed':
      await db.query(`UPDATE treasuries SET nav_burned = nav_burned + $2, nav_paid = nav_paid + $3, updated_slot = $4 WHERE address = $1`, [ev.data.treasury, ev.data.burned.toString(), ev.data.paid.toString(), slot]);
      return;
    case 'Staked':
    case 'Unstaked': {
      const d = ev.data;
      const delta = ev.name === 'Staked' ? d.amount : -d.amount;
      await db.query(
        `INSERT INTO treasury_stakers (treasury, owner, staked, last_slot) VALUES ($1,$2,$3,$4)
         ON CONFLICT (treasury, owner) DO UPDATE SET staked = treasury_stakers.staked + EXCLUDED.staked, last_slot = EXCLUDED.last_slot`,
        [d.treasury, d.owner, delta.toString(), slot],
      );
      await db.query(`UPDATE treasuries SET staked_total = $2, updated_slot = $3 WHERE address = $1`, [d.treasury, d.totalStaked.toString(), slot]);
      return;
    }
    case 'DistributionDeposited':
      await db.query(`UPDATE treasuries SET distributed_total = distributed_total + $2, updated_slot = $3 WHERE address = $1`, [ev.data.treasury, ev.data.amount.toString(), slot]);
      return;
    case 'DistributionClaimed': {
      const d = ev.data;
      await db.query(`UPDATE treasuries SET distribution_claimed = distribution_claimed + $2, updated_slot = $3 WHERE address = $1`, [d.treasury, d.amount.toString(), slot]);
      await db.query(
        `INSERT INTO treasury_stakers (treasury, owner, claimed, last_slot) VALUES ($1,$2,$3,$4)
         ON CONFLICT (treasury, owner) DO UPDATE SET claimed = treasury_stakers.claimed + EXCLUDED.claimed, last_slot = EXCLUDED.last_slot`,
        [d.treasury, d.owner, d.amount.toString(), slot],
      );
      return;
    }
    case 'RoundPaid': {
      const d = ev.data;
      await db.query(
        `INSERT INTO treasury_rounds (treasury, round, status, revenue, due, payer, slot) VALUES ($1,$2,'paid',$3,$4,$5,$6)
         ON CONFLICT (treasury, round) DO UPDATE SET status = 'paid', revenue = EXCLUDED.revenue, due = EXCLUDED.due, payer = EXCLUDED.payer, slot = EXCLUDED.slot`,
        [d.treasury, d.round.toString(), d.revenue.toString(), d.due.toString(), d.payer, slot],
      );
      await db.query(`UPDATE treasuries SET rounds_paid = rounds_paid + 1, updated_slot = $2 WHERE address = $1`, [d.treasury, slot]);
      return;
    }
    case 'RoundMissed': {
      const d = ev.data;
      await db.query(`INSERT INTO treasury_rounds (treasury, round, status, slot) VALUES ($1,$2,'missed',$3) ON CONFLICT (treasury, round) DO UPDATE SET status = 'missed', slot = EXCLUDED.slot`, [d.treasury, d.round.toString(), slot]);
      await db.query(`UPDATE treasuries SET rounds_missed = rounds_missed + 1, nav_open = (nav_open OR $2::boolean), updated_slot = $3 WHERE address = $1`, [d.treasury, d.navOpen, slot]);
      return;
    }
    case 'TrancheReleased': {
      const d = ev.data;
      await db.query(`UPDATE treasury_rounds SET tranche = $3 WHERE treasury = $1 AND round = $2`, [d.treasury, d.round.toString(), d.amount.toString()]);
      await db.query(`UPDATE treasuries SET tranche_released = tranche_released + $2, updated_slot = $3 WHERE address = $1`, [d.treasury, d.amount.toString(), slot]);
      return;
    }
    case 'GrantCreated': {
      const d = ev.data;
      await db.query(
        `INSERT INTO treasury_grants (grant_address, treasury, id, beneficiary, total, lockup_end, expiry_ts, created_slot) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
        [d.grant, d.treasury, d.id.toString(), d.beneficiary, d.total.toString(), d.lockupEnd.toString(), d.expiryTs.toString(), slot],
      );
      await db.query(`UPDATE treasuries SET grants_count = grants_count + 1, updated_slot = $2 WHERE address = $1`, [d.treasury, slot]);
      return;
    }
    case 'MilestoneReleased':
      await db.query(`UPDATE treasury_grants SET released = released + $2 WHERE grant_address = $1`, [ev.data.grant, ev.data.amount.toString()]);
      return;
    case 'GrantExpired':
      await db.query(`UPDATE treasury_grants SET burned = $2 WHERE grant_address = $1`, [ev.data.grant, ev.data.burned.toString()]);
      return;
    case 'DisclosurePosted':
      await db.query(`UPDATE treasuries SET disclosures = $2, last_disclosure_at = $3, disclosure_request_since = NULL, updated_slot = $4 WHERE address = $1`, [ev.data.treasury, ev.data.count, ev.data.at.toString(), slot]);
      return;
    case 'DisclosureRequested':
      await db.query(`UPDATE treasuries SET disclosure_request_since = $2, updated_slot = $3 WHERE address = $1`, [ev.data.treasury, ev.data.openSince.toString(), slot]);
      return;
    case 'AssignmentRecorded':
      await db.query(`UPDATE treasuries SET assigned = true, updated_slot = $2 WHERE address = $1`, [ev.data.treasury, slot]);
      return;
    case 'UnclaimedSwept':
      await db.query(`UPDATE treasuries SET swept = $2, updated_slot = $3 WHERE address = $1`, [ev.data.treasury, ev.data.amount.toString(), slot]);
      return;
  }
}

/** Signatures newer than `until` (exclusive), newest first. */
async function listSince(rpc: Rpc, program: Address, until: Signature | undefined) {
  const out: { signature: Signature; slot: bigint }[] = [];
  let before: Signature | undefined;
  for (;;) {
    const page = await rpc.getSignaturesForAddress(program, { commitment: 'finalized', limit: 1000, ...(until && { until }), ...(before && { before }) }).send();
    if (page.length === 0) break;
    for (const s of page) out.push({ signature: s.signature, slot: s.slot });
    before = page.at(-1)!.signature;
    if (page.length < 1000) break;
  }
  return out;
}

/**
 * One pass: ingest every finalized treasury-program transaction after the stored cursor, oldest first, advancing the cursor only
 * after each commits. Returns the number of events applied.
 */
export async function pollTreasuryOnce(db: pg.Pool, rpc: Rpc, program: Address = TREASURY_PROGRAM_ADDRESS, source = `rpc:${program}`): Promise<number> {
  const { rows } = await db.query('SELECT last_signature FROM cursors WHERE source = $1', [source]);
  const until = (rows[0]?.last_signature ?? undefined) as Signature | undefined;
  const pending = await listSince(rpc, program, until);
  pending.reverse();
  let applied = 0;
  const opts = { maxSupportedTransactionVersion: 0, encoding: 'json' } as const;
  for (const s of pending) {
    // The listing already said finalized, so the body is final; if the node cannot return it at that level, read it at confirmed.
    const tx =
      (await rpc.getTransaction(s.signature, { ...opts, commitment: 'finalized' }).send().catch(() => null)) ??
      (await rpc.getTransaction(s.signature, { ...opts, commitment: 'confirmed' }).send());
    if (!tx) throw new Error(`getTransaction(${s.signature}) returned nothing at finalized or confirmed`);
    applied += await ingestTreasuryTransaction(db, {
      signature: s.signature,
      slot: tx.slot,
      blockTime: tx.blockTime === null ? null : BigInt(tx.blockTime),
      logs: tx.meta?.logMessages ?? [],
      err: tx.meta?.err ?? null,
    });
    await db.query(
      `INSERT INTO cursors (source, last_signature, last_slot) VALUES ($1, $2, $3)
       ON CONFLICT (source) DO UPDATE SET last_signature = EXCLUDED.last_signature, last_slot = EXCLUDED.last_slot`,
      [source, s.signature, s.slot.toString()],
    );
  }
  return applied;
}
