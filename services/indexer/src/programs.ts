// Indexer for the seven Wave 3D programs (cross_mandate, cross_conviction, cross_basket, cross_listing, cross_bounty, cross_backing, cross_graduate; ADR-0650 to ADR-0656): their
// events into one append-only log and the state a reader scans (migration 019).
//
// Same discipline as the other indexers: an event is attributed by the invoke stack (a data line counts only while one of these programs is on top, so the cross_core events a
// mandate causes are left to the core indexer), a failed transaction changes nothing, one database transaction per chain transaction, a signature already ingested is a no-op, and
// the poller reads at `finalized` and keeps a cursor per program under `rpc:<program>`. On a cluster where a program is not deployed the poller finds no signatures and every
// table stays empty: that is the normal state until the operations key is funded (docs/HUMAN_TASKS.md H27, H43), not an error.
import type { Address, Signature } from '@solana/kit';
import { findBondPda } from '@opening-cross/cross-listing-client';
import type pg from 'pg';
import { UnattributableLogs } from './decode.js';
import type { ChainTx } from './ingest.js';
import type { IndexerRpc as Rpc } from './rpc.js';
import { listSince } from './settle.js';
import { EVENT_CODECS, PROGRAM_IDS, type ProgramName } from './programs-events.js';

export { EVENT_CODECS, PROGRAM_IDS, type ProgramName };
export const PROGRAM_NAMES = Object.keys(PROGRAM_IDS) as ProgramName[];

export type ProgramEvent = { program: ProgramName; name: string; data: Record<string, unknown> };

const BY_ID = new Map<string, ProgramName>(Object.entries(PROGRAM_IDS).map(([name, id]) => [id, name as ProgramName]));
const INVOKE = /^Program (\w+) invoke \[\d+\]$/;
const EXIT = /^Program (\w+) (success|failed)/;
const DATA = 'Program data: ';

/** The events written while one of the seven programs is the innermost running program. */
export function decodeProgramLogs(logs: readonly string[]): ProgramEvent[] {
  const stack: string[] = [];
  const out: ProgramEvent[] = [];
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
    if (!line.startsWith(DATA)) continue;
    const program = BY_ID.get(stack.at(-1) ?? '');
    if (!program) continue;
    const bytes = Uint8Array.from(Buffer.from(line.slice(DATA.length), 'base64'));
    const codec = EVENT_CODECS.find((c) => c.program === program && bytes.length >= 8 && c.discriminator.every((b, i) => bytes[i] === b));
    if (!codec) continue;
    out.push({ program, name: codec.name, data: codec.decoder.decode(bytes) as Record<string, unknown> });
  }
  return out;
}

/** JSON-safe form of a payload: bigints become decimal strings, byte arrays become hex. */
export function payloadJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v instanceof Uint8Array ? Buffer.from(v).toString('hex') : v)));
}

const str = (v: unknown): string => (typeof v === 'bigint' ? v.toString() : String(v));
const some = (v: unknown): string | null => (v && typeof v === 'object' && (v as { __option?: string }).__option === 'Some' ? str((v as { value: unknown }).value) : null);

/** The account an event is about: what its history is filed under. */
export function subjectOf(ev: ProgramEvent): string | null {
  const d = ev.data;
  for (const k of ['mandate', 'lock', 'basket', 'listing', 'bounty', 'round', 'outcome', 'charter', 'policy', 'venue', 'bond', 'mint']) if (typeof d[k] === 'string') return d[k] as string;
  return null;
}
export function crossOfEvent(ev: ProgramEvent): string | null {
  return typeof ev.data.cross === 'string' ? (ev.data.cross as string) : null;
}

/** Returns how many events were newly applied (0 when the signature was already ingested or failed). */
export async function ingestProgramTransaction(db: pg.Pool, tx: ChainTx): Promise<number> {
  if (tx.err) return 0;
  const events = decodeProgramLogs(tx.logs);
  if (events.length === 0) return 0;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    let applied = 0;
    for (const [seq, ev] of events.entries()) {
      const res = await client.query(
        `INSERT INTO program_events (signature, seq, slot, block_time, program, name, subject, cross_address, payload) VALUES ($1,$2,$3,to_timestamp($4),$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
        [tx.signature, seq, tx.slot.toString(), tx.blockTime?.toString() ?? null, ev.program, ev.name, subjectOf(ev), crossOfEvent(ev), JSON.stringify(payloadJson(ev.data))],
      );
      if (res.rowCount === 0) continue;
      await apply(client, tx.signature + ':' + seq, ev, tx.slot.toString());
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

type Limits = { maxPerOrder: bigint; totalCap: bigint; maxShareBps: number; expiresAt: bigint; allow: { kind: number; key: string }[] };
const allowJson = (l: Limits) => JSON.stringify(l.allow.map((a) => ({ kind: Number(a.kind), key: a.key })));

async function apply(db: pg.PoolClient, key: string, ev: ProgramEvent, slot: string): Promise<void> {
  const d = ev.data as Record<string, any>;
  const q = (text: string, params: unknown[]) => db.query(text, params);
  switch (`${ev.program}:${ev.name}`) {
    // ------------------------------------------------------------------ cross_mandate
    case 'cross_mandate:MandateCreated': {
      const l = d.limits as Limits;
      await q(
        `INSERT INTO mandates (address, owner, agent, quote_mint, max_per_order, total_cap, max_share_bps, expires_at, allow, created_slot, updated_slot) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10) ON CONFLICT (address) DO NOTHING`,
        [d.mandate, d.owner, d.agent, d.quoteMint, str(l.maxPerOrder), str(l.totalCap), l.maxShareBps, str(l.expiresAt), allowJson(l), slot],
      );
      return;
    }
    case 'cross_mandate:MandateFunded':
      await q(`UPDATE mandates SET funded = funded + $2::numeric, funded_lamports = funded_lamports + $3::numeric, updated_slot = $4 WHERE address = $1`, [d.mandate, str(d.amount), str(d.lamports), slot]);
      return;
    case 'cross_mandate:LimitsChanged': {
      const l = d.limits as Limits;
      await q(`UPDATE mandates SET max_per_order = $2, total_cap = $3, max_share_bps = $4, expires_at = $5, allow = $6, updated_slot = $7 WHERE address = $1`, [d.mandate, str(l.maxPerOrder), str(l.totalCap), l.maxShareBps, str(l.expiresAt), allowJson(l), slot]);
      return;
    }
    case 'cross_mandate:MandateRevoked':
      await q(`UPDATE mandates SET revoked = true, updated_slot = $2 WHERE address = $1`, [d.mandate, slot]);
      return;
    case 'cross_mandate:MandateWithdrawn':
      await q(`UPDATE mandates SET withdrawn = withdrawn + $2::numeric, updated_slot = $3 WHERE address = $1`, [d.mandate, str(d.amount), slot]);
      return;
    case 'cross_mandate:MandateOrderPlaced':
      await q(`INSERT INTO mandate_orders (order_address, mandate, cross_address, escrow, slot) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (order_address) DO NOTHING`, [d.order, d.mandate, d.cross, str(d.escrow), slot]);
      await q(`UPDATE mandates SET committed = $2, orders = orders + 1, updated_slot = $3 WHERE address = $1`, [d.mandate, str(d.committed), slot]);
      return;
    case 'cross_mandate:MandateLamportsWithdrawn':
    case 'cross_mandate:MandateSwept':
      return; // kept in the log

    // ------------------------------------------------------------------ cross_conviction
    case 'cross_conviction:Locked':
      await q(`INSERT INTO conviction_locks (lock, holder, mint, amount, locked_at, unlock_ts, created_slot, updated_slot) VALUES ($1,$2,$3,$4,$5,$6,$7,$7) ON CONFLICT (lock) DO NOTHING`, [d.lock, d.holder, d.mint, str(d.amount), str(d.lockedAt), str(d.unlockTs), slot]);
      return;
    case 'cross_conviction:Unlocked':
      await q(`UPDATE conviction_locks SET unlocked = true, updated_slot = $2 WHERE lock = $1`, [d.lock, slot]);
      return;
    case 'cross_conviction:BadgeCreated':
      await q(`INSERT INTO conviction_badges (holder, mint, badge_mint, slot) VALUES ($1,$2,$3,$4) ON CONFLICT (holder, mint) DO NOTHING`, [d.holder, d.mint, d.badgeMint, slot]);
      return;
    case 'cross_conviction:BadgeClaimed':
      await q(`UPDATE conviction_locks SET badge_claimed = true, token_days = $2, updated_slot = $3 WHERE lock = $1`, [d.lock, str(d.tokenDays), slot]);
      return;

    // ------------------------------------------------------------------ cross_basket
    case 'cross_basket:BasketCreated':
      await q(
        `INSERT INTO baskets (address, creator, share_mint, components, created_slot, updated_slot) VALUES ($1,$2,$3,$4,$5,$5) ON CONFLICT (address) DO NOTHING`,
        [d.basket, d.creator, d.shareMint, JSON.stringify((d.components as { mint: string; tokenProgram: string; unitsPerShare: bigint }[]).map((c) => ({ mint: c.mint, tokenProgram: c.tokenProgram, unitsPerShare: str(c.unitsPerShare) }))), slot],
      );
      return;
    case 'cross_basket:SharesMinted':
      await q(`UPDATE baskets SET minted = minted + $2::numeric, updated_slot = $3 WHERE address = $1`, [d.basket, str(d.shares), slot]);
      return;
    case 'cross_basket:SharesRedeemed':
      await q(`UPDATE baskets SET redeemed = redeemed + $2::numeric, updated_slot = $3 WHERE address = $1`, [d.basket, str(d.shares), slot]);
      return;

    // ------------------------------------------------------------------ cross_listing
    case 'cross_listing:VenueCreated':
      await q(`INSERT INTO listing_venues (venue, creator, bond_mint, min_bond, release_delay_secs, slash_to, created_slot) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (venue) DO NOTHING`, [d.venue, d.creator, d.bondMint, str(d.minBond), str(d.releaseDelaySecs), d.slashTo, slot]);
      return;
    case 'cross_listing:BondDeposited':
    case 'cross_listing:BondWithdrawn':
      await q(
        `INSERT INTO listing_bonds (bond, lister, amount, updated_slot) VALUES ($1,$2,$3,$4) ON CONFLICT (bond) DO UPDATE SET amount = EXCLUDED.amount, updated_slot = EXCLUDED.updated_slot`,
        [d.bond, d.lister, str(d.total), slot],
      );
      return;
    case 'cross_listing:Listed': {
      await q(`INSERT INTO listing_listings (listing, venue, lister, cross_address, amount, created_slot) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (listing) DO NOTHING`, [d.listing, d.venue, d.lister, d.cross, str(d.amount), slot]);
      // The bond events name the bond and its lister but not the venue: the first listing says which venue the bond is on.
      const [bond] = await findBondPda({ venue: d.venue as Address, lister: d.lister as Address });
      await q(`UPDATE listing_bonds SET venue = $2 WHERE bond = $1 AND venue IS NULL`, [bond, d.venue]);
      return;
    }
    case 'cross_listing:ListingReleased':
      await q(`UPDATE listing_listings SET status = 'released', settled_slot = $2 WHERE listing = $1`, [d.listing, slot]);
      return;
    case 'cross_listing:ListingSlashed':
      await q(`UPDATE listing_listings SET status = 'slashed', slashed_to = $2, settled_slot = $3 WHERE listing = $1`, [d.listing, d.to, slot]);
      return;

    // ------------------------------------------------------------------ cross_bounty
    case 'cross_bounty:BountyCreated':
      await q(`INSERT INTO bounties (address, sponsor, arbiter, reward_mint, expires_at, rewards, created_slot, updated_slot) VALUES ($1,$2,$3,$4,$5,$6,$7,$7) ON CONFLICT (address) DO NOTHING`, [d.bounty, d.sponsor, d.arbiter, d.rewardMint, str(d.expiresAt), JSON.stringify((d.rewards as bigint[]).map(str)), slot]);
      return;
    case 'cross_bounty:BountyFunded':
      await q(`UPDATE bounties SET funded = funded + $2::numeric, updated_slot = $3 WHERE address = $1`, [d.bounty, str(d.amount), slot]);
      return;
    case 'cross_bounty:InvariantPaid':
      await q(`UPDATE bounties SET paid = paid + $2::numeric, paid_mask = paid_mask | $3, updated_slot = $4 WHERE address = $1`, [d.bounty, str(d.amount), 1 << Number(d.invariant), slot]);
      await q(`INSERT INTO bounty_payouts (bounty, seq_key, kind, invariant, cross_address, recipient, amount, slot) VALUES ($1,$2,'invariant',$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`, [d.bounty, key, Number(d.invariant), d.cross, d.claimant, str(d.amount), slot]);
      return;
    case 'cross_bounty:Awarded':
      await q(`UPDATE bounties SET awarded = awarded + $2::numeric, updated_slot = $3 WHERE address = $1`, [d.bounty, str(d.amount), slot]);
      await q(`INSERT INTO bounty_payouts (bounty, seq_key, kind, recipient, amount, evidence, slot) VALUES ($1,$2,'award',$3,$4,$5,$6) ON CONFLICT DO NOTHING`, [d.bounty, key, d.to, str(d.amount), Buffer.from(d.evidence as Uint8Array).toString('hex'), slot]);
      return;
    case 'cross_bounty:BountyWithdrawn':
      await q(`UPDATE bounties SET withdrawn = withdrawn + $2::numeric, updated_slot = $3 WHERE address = $1`, [d.bounty, str(d.amount), slot]);
      return;

    // ------------------------------------------------------------------ cross_backing
    case 'cross_backing:PolicyCreated':
      await q(`INSERT INTO backing_policies (policy, mint, attester, min_coverage_bps, max_age_secs, created_slot) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (policy) DO NOTHING`, [d.policy, d.mint, d.attester, d.minCoverageBps, str(d.maxAgeSecs), slot]);
      return;
    case 'cross_backing:Attested':
      await q(
        `INSERT INTO backing_attestations (mint, attester, backing_atoms, posted_ts, slot) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (mint) DO UPDATE SET attester = EXCLUDED.attester, backing_atoms = EXCLUDED.backing_atoms, posted_ts = EXCLUDED.posted_ts, slot = EXCLUDED.slot`,
        [d.mint, d.attester, str(d.backingAtoms), str(d.postedTs), slot],
      );
      return;
    case 'cross_backing:BackingFailed':
      await q(`INSERT INTO backing_failures (mint, checked_ts, reason, supply, slot) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [d.mint, str(d.checkedTs), Number(d.reason), str(d.supply), slot]);
      return;

    // ------------------------------------------------------------------ cross_graduate
    case 'cross_graduate:CharterCreated':
      await q(`INSERT INTO graduation_charters (charter, cross_address, quorum_bps, window_secs, min_volume, volume_attester, created_slot) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (charter) DO NOTHING`, [d.charter, d.cross, d.quorumBps, str(d.windowSecs), str(d.minVolume), some(d.volumeAttester), slot]);
      return;
    case 'cross_graduate:RoundStarted':
      await q(`INSERT INTO graduation_rounds (round, cross_address, idx, closes_ts, created_slot, updated_slot) VALUES ($1,$2,$3,$4,$5,$5) ON CONFLICT (round) DO NOTHING`, [d.round, d.cross, Number(d.index), str(d.closesTs), slot]);
      return;
    case 'cross_graduate:VoteCast': {
      await q(
        `INSERT INTO graduation_votes (round, voter, venue, amount, slot) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (round, voter) DO UPDATE SET amount = graduation_votes.amount + EXCLUDED.amount, slot = EXCLUDED.slot`,
        [d.round, d.voter, Number(d.venue), str(d.amount), slot],
      );
      await q(
        `UPDATE graduation_rounds SET tallies = jsonb_set(tallies, ARRAY[($2::int)::text], to_jsonb(((tallies ->> ($2::int))::numeric + $3::numeric)::text)), locked_total = $4, updated_slot = $5 WHERE round = $1`,
        [d.round, Number(d.venue), str(d.amount), str(d.lockedTotal), slot],
      );
      return;
    }
    case 'cross_graduate:VolumePosted':
      await q(`UPDATE graduation_rounds SET volume_quote = $2, updated_slot = $3 WHERE round = $1`, [d.round, str(d.volumeQuote), slot]);
      return;
    case 'cross_graduate:RoundFinalized':
      await q(`UPDATE graduation_rounds SET finalized = true, passed = $2, winner = $3, locked_total = $4, supply = $5, updated_slot = $6 WHERE round = $1`, [d.round, d.passed, d.passed ? Number(d.winner) : null, str(d.lockedTotal), str(d.supply), slot]);
      return;
    case 'cross_graduate:OutcomePublished':
      await q(`INSERT INTO graduation_outcomes (outcome, cross_address, venue, slot) VALUES ($1,$2,$3,$4) ON CONFLICT (outcome) DO NOTHING`, [d.outcome, d.cross, Number(d.venue), slot]);
      return;
    case 'cross_graduate:VoteWithdrawn':
      await q(`UPDATE graduation_votes SET amount = 0, withdrawn = true, slot = $3 WHERE round = $1 AND voter = $2`, [d.round, d.voter, slot]);
      return;
    default:
      return;
  }
}

/** One pass over one program: every finalized transaction after the stored cursor, oldest first; the cursor advances only after each commits. A program that is not on the cluster has no signatures. */
export async function pollProgramOnce(db: pg.Pool, rpc: Rpc, name: ProgramName): Promise<number> {
  const program = PROGRAM_IDS[name] as Address;
  const source = `rpc:${program}`;
  const { rows } = await db.query('SELECT last_signature FROM cursors WHERE source = $1', [source]);
  const until = (rows[0]?.last_signature ?? undefined) as Signature | undefined;
  const pending = await listSince(rpc, program, until);
  pending.reverse();
  let applied = 0;
  const opts = { maxSupportedTransactionVersion: 0, encoding: 'json' } as const;
  for (const s of pending) {
    const tx =
      (await rpc.getTransaction(s.signature, { ...opts, commitment: 'finalized' }).send().catch(() => null)) ??
      (await rpc.getTransaction(s.signature, { ...opts, commitment: 'confirmed' }).send());
    if (!tx) throw new Error(`getTransaction(${s.signature}) returned nothing at finalized or confirmed`);
    applied += await ingestProgramTransaction(db, {
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

/** All seven programs. A program the cluster does not have costs one empty signature query. */
export async function pollProgramsOnce(db: pg.Pool, rpc: Rpc, names: readonly ProgramName[] = PROGRAM_NAMES): Promise<number> {
  let applied = 0;
  for (const name of names) applied += await pollProgramOnce(db, rpc, name);
  return applied;
}
