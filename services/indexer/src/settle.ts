// Indexer for the settlement adapters (programs/cross_settle): the venues a cleared cross opens, the partner payouts of a DBC continuation
// (ADR-0480, ADR-0481), the locked continuation (ADR-0482), batch-opened pools (ADR-0483), stock-quoted pairs (ADR-0485) and the greenshoe (ADR-0487).
//
// Same discipline as the other indexers: events are attributed by the invoke stack (a data line counts only while cross_settle is on top), a
// failed transaction changes nothing, one database transaction per chain transaction, a signature already ingested is a no-op, and the poller
// reads at `finalized` and keeps its own cursor under `rpc:<program>`. A program deployed before these paths simply never emits their events.
// Greenshoe events name the greenshoe, not the cross: they are attributed through the GreenshoeCreated that opened it.
import type { Address, Signature } from '@solana/kit';
import type pg from 'pg';
import {
  CROSS_SETTLE_PROGRAM_ADDRESS,
  DAMM_V2_SEEDED_EVENT_DISCRIMINATOR,
  DBC_MINT_BOUND_EVENT_DISCRIMINATOR,
  DBC_POOL_OPENED_EVENT_DISCRIMINATOR,
  DLMM_PAIR_OPENED_EVENT_DISCRIMINATOR,
  GREENSHOE_BID_PLACED_EVENT_DISCRIMINATOR,
  GREENSHOE_CREATED_EVENT_DISCRIMINATOR,
  GREENSHOE_FINISHED_EVENT_DISCRIMINATOR,
  GREENSHOE_LEVEL_SETTLED_EVENT_DISCRIMINATOR,
  PARTNER_FEE_CLAIMED_EVENT_DISCRIMINATOR,
  PARTNER_MIGRATION_FEE_WITHDRAWN_EVENT_DISCRIMINATOR,
  PARTNER_POOL_CREATION_FEE_CLAIMED_EVENT_DISCRIMINATOR,
  PARTNER_SURPLUS_WITHDRAWN_EVENT_DISCRIMINATOR,
  POL_FEES_CLAIMED_EVENT_DISCRIMINATOR,
  RAYDIUM_CPMM_SEEDED_EVENT_DISCRIMINATOR,
  type DammV2SeededEvent,
  type DbcMintBoundEvent,
  type DbcPoolOpenedEvent,
  type DlmmPairOpenedEvent,
  type GreenshoeBidPlacedEvent,
  type GreenshoeCreatedEvent,
  type GreenshoeFinishedEvent,
  type GreenshoeLevelSettledEvent,
  type PartnerFeeClaimedEvent,
  type PartnerMigrationFeeWithdrawnEvent,
  type PartnerPoolCreationFeeClaimedEvent,
  type PartnerSurplusWithdrawnEvent,
  type PolFeesClaimedEvent,
  type RaydiumCpmmSeededEvent,
  getDammV2SeededEventDecoder,
  getDbcMintBoundEventDecoder,
  getDbcPoolOpenedEventDecoder,
  getDlmmPairOpenedEventDecoder,
  getGreenshoeBidPlacedEventDecoder,
  getGreenshoeCreatedEventDecoder,
  getGreenshoeFinishedEventDecoder,
  getGreenshoeLevelSettledEventDecoder,
  getPartnerFeeClaimedEventDecoder,
  getPartnerMigrationFeeWithdrawnEventDecoder,
  getPartnerPoolCreationFeeClaimedEventDecoder,
  getPartnerSurplusWithdrawnEventDecoder,
  getPolFeesClaimedEventDecoder,
  getRaydiumCpmmSeededEventDecoder,
} from '@opening-cross/cross-settle-client';
import { UnattributableLogs, toJson } from './decode.js';
import type { ChainTx } from './ingest.js';
import type { IndexerRpc as Rpc } from './rpc.js';

export type SettleEventRecord =
  | { name: 'DbcPoolOpened'; data: DbcPoolOpenedEvent }
  | { name: 'DbcMintBound'; data: DbcMintBoundEvent }
  | { name: 'DammV2Seeded'; data: DammV2SeededEvent }
  | { name: 'DlmmPairOpened'; data: DlmmPairOpenedEvent }
  | { name: 'RaydiumCpmmSeeded'; data: RaydiumCpmmSeededEvent }
  | { name: 'PartnerFeeClaimed'; data: PartnerFeeClaimedEvent }
  | { name: 'PartnerSurplusWithdrawn'; data: PartnerSurplusWithdrawnEvent }
  | { name: 'PartnerMigrationFeeWithdrawn'; data: PartnerMigrationFeeWithdrawnEvent }
  | { name: 'PartnerPoolCreationFeeClaimed'; data: PartnerPoolCreationFeeClaimedEvent }
  | { name: 'PolFeesClaimed'; data: PolFeesClaimedEvent }
  | { name: 'GreenshoeCreated'; data: GreenshoeCreatedEvent }
  | { name: 'GreenshoeBidPlaced'; data: GreenshoeBidPlacedEvent }
  | { name: 'GreenshoeLevelSettled'; data: GreenshoeLevelSettledEvent }
  | { name: 'GreenshoeFinished'; data: GreenshoeFinishedEvent };

const DECODERS: [Uint8Array, SettleEventRecord['name'], { decode(b: Uint8Array): unknown }][] = [
  [DBC_POOL_OPENED_EVENT_DISCRIMINATOR as Uint8Array, 'DbcPoolOpened', getDbcPoolOpenedEventDecoder()],
  [DBC_MINT_BOUND_EVENT_DISCRIMINATOR as Uint8Array, 'DbcMintBound', getDbcMintBoundEventDecoder()],
  [DAMM_V2_SEEDED_EVENT_DISCRIMINATOR as Uint8Array, 'DammV2Seeded', getDammV2SeededEventDecoder()],
  [DLMM_PAIR_OPENED_EVENT_DISCRIMINATOR as Uint8Array, 'DlmmPairOpened', getDlmmPairOpenedEventDecoder()],
  [RAYDIUM_CPMM_SEEDED_EVENT_DISCRIMINATOR as Uint8Array, 'RaydiumCpmmSeeded', getRaydiumCpmmSeededEventDecoder()],
  [PARTNER_FEE_CLAIMED_EVENT_DISCRIMINATOR as Uint8Array, 'PartnerFeeClaimed', getPartnerFeeClaimedEventDecoder()],
  [PARTNER_SURPLUS_WITHDRAWN_EVENT_DISCRIMINATOR as Uint8Array, 'PartnerSurplusWithdrawn', getPartnerSurplusWithdrawnEventDecoder()],
  [PARTNER_MIGRATION_FEE_WITHDRAWN_EVENT_DISCRIMINATOR as Uint8Array, 'PartnerMigrationFeeWithdrawn', getPartnerMigrationFeeWithdrawnEventDecoder()],
  [PARTNER_POOL_CREATION_FEE_CLAIMED_EVENT_DISCRIMINATOR as Uint8Array, 'PartnerPoolCreationFeeClaimed', getPartnerPoolCreationFeeClaimedEventDecoder()],
  [POL_FEES_CLAIMED_EVENT_DISCRIMINATOR as Uint8Array, 'PolFeesClaimed', getPolFeesClaimedEventDecoder()],
  [GREENSHOE_CREATED_EVENT_DISCRIMINATOR as Uint8Array, 'GreenshoeCreated', getGreenshoeCreatedEventDecoder()],
  [GREENSHOE_BID_PLACED_EVENT_DISCRIMINATOR as Uint8Array, 'GreenshoeBidPlaced', getGreenshoeBidPlacedEventDecoder()],
  [GREENSHOE_LEVEL_SETTLED_EVENT_DISCRIMINATOR as Uint8Array, 'GreenshoeLevelSettled', getGreenshoeLevelSettledEventDecoder()],
  [GREENSHOE_FINISHED_EVENT_DISCRIMINATOR as Uint8Array, 'GreenshoeFinished', getGreenshoeFinishedEventDecoder()],
];

const INVOKE = /^Program (\w+) invoke \[\d+\]$/;
const EXIT = /^Program (\w+) (success|failed)/;
const DATA = 'Program data: ';

/** cross_settle events written while cross_settle is the innermost running program (a venue's own events, written during its CPI, do not count). */
export function decodeSettleLogs(logs: readonly string[], program: Address = CROSS_SETTLE_PROGRAM_ADDRESS): SettleEventRecord[] {
  const stack: string[] = [];
  const out: SettleEventRecord[] = [];
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
    out.push({ name: match[1], data: match[2].decode(bytes) } as SettleEventRecord);
  }
  return out;
}

async function crossOf(db: pg.PoolClient, ev: SettleEventRecord): Promise<string | null> {
  const d = ev.data as Record<string, unknown>;
  if (typeof d.cross === 'string') return d.cross;
  if (typeof d.greenshoe === 'string') return ((await db.query('SELECT cross_address FROM settle_greenshoes WHERE greenshoe = $1', [d.greenshoe])).rows[0]?.cross_address as string | undefined) ?? null;
  return null;
}

/** Returns how many events were newly applied (0 when the signature was already ingested or failed). */
export async function ingestSettleTransaction(db: pg.Pool, tx: ChainTx): Promise<number> {
  if (tx.err) return 0;
  const events = decodeSettleLogs(tx.logs);
  if (events.length === 0) return 0;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    let applied = 0;
    for (const [seq, ev] of events.entries()) {
      const cross = await crossOf(client, ev);
      const res = await client.query(
        `INSERT INTO settle_events (signature, seq, slot, block_time, name, cross_address, payload) VALUES ($1,$2,$3,to_timestamp($4),$5,$6,$7) ON CONFLICT DO NOTHING`,
        [tx.signature, seq, tx.slot.toString(), tx.blockTime?.toString() ?? null, ev.name, cross, JSON.stringify(toJson(ev.data))],
      );
      if (res.rowCount === 0) continue;
      await apply(client, ev, tx.slot.toString());
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

async function venue(db: pg.PoolClient, cross: string, name: string, pool: string, price: bigint, detail: unknown, slot: string) {
  await db.query(`INSERT INTO settle_venues (cross_address, venue, pool, clearing_price, detail, slot) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`, [cross, name, pool, price.toString(), JSON.stringify(toJson(detail)), slot]);
}

async function partner(db: pg.PoolClient, cross: string, slot: string, set: string, ...values: string[]) {
  await db.query(`INSERT INTO settle_partner (cross_address, updated_slot) VALUES ($1,$2) ON CONFLICT (cross_address) DO NOTHING`, [cross, slot]);
  await db.query(`UPDATE settle_partner SET ${set}, updated_slot = $2 WHERE cross_address = $1`, [cross, slot, ...values]);
}

async function apply(db: pg.PoolClient, ev: SettleEventRecord, slot: string): Promise<void> {
  switch (ev.name) {
    case 'DbcPoolOpened':
      return venue(db, ev.data.cross, 'dbc', ev.data.pool, ev.data.clearingPrice, { config: ev.data.config, baseMint: ev.data.baseMint, sqrtStartPrice: ev.data.sqrtStartPrice }, slot);
    case 'DbcMintBound':
      return; // kept in the event log; the cross's own BaseMintBound updates the cross
    case 'DammV2Seeded':
      return venue(db, ev.data.cross, 'damm_v2', ev.data.pool, ev.data.clearingPrice, { sqrtPrice: ev.data.sqrtPrice, liquidity: ev.data.liquidity }, slot);
    case 'DlmmPairOpened':
      return venue(db, ev.data.cross, 'dlmm', ev.data.lbPair, ev.data.clearingPrice, { activeId: ev.data.activeId, binStep: ev.data.binStep }, slot);
    case 'RaydiumCpmmSeeded':
      return venue(db, ev.data.cross, 'raydium_cpmm', ev.data.pool, ev.data.clearingPrice, { baseAmount: ev.data.baseAmount, quoteAmount: ev.data.quoteAmount }, slot);
    case 'PartnerFeeClaimed':
      return partner(db, ev.data.cross, slot, 'fee_base = fee_base + $3::numeric, fee_quote = fee_quote + $4::numeric, fee_claims = fee_claims + 1', ev.data.base.toString(), ev.data.quote.toString());
    case 'PartnerSurplusWithdrawn':
      return partner(db, ev.data.cross, slot, 'surplus_withdrawn = surplus_withdrawn + $3::numeric', ev.data.amount.toString());
    case 'PartnerMigrationFeeWithdrawn':
      return partner(db, ev.data.cross, slot, 'migration_fee = migration_fee + $3::numeric', ev.data.amount.toString());
    case 'PartnerPoolCreationFeeClaimed':
      return partner(db, ev.data.cross, slot, 'pool_creation_lamports = pool_creation_lamports + $3::numeric', ev.data.lamports.toString());
    case 'PolFeesClaimed':
      return partner(db, ev.data.cross, slot, 'pol_token_a = pol_token_a + $3::numeric, pol_token_b = pol_token_b + $4::numeric, pol_claims = pol_claims + 1', ev.data.tokenA.toString(), ev.data.tokenB.toString());
    case 'GreenshoeCreated': {
      const d = ev.data;
      await db.query(
        `INSERT INTO settle_greenshoes (greenshoe, cross_address, budget, start_ts, expires_ts, created_slot) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
        [d.greenshoe, d.cross, d.budget.toString(), d.startTs.toString(), d.expiresTs.toString(), slot],
      );
      // The event itself was stored before the greenshoe was known: attribute it now.
      await db.query(`UPDATE settle_events SET cross_address = $2 WHERE cross_address IS NULL AND payload ->> 'greenshoe' = $1`, [d.greenshoe, d.cross]);
      return;
    }
    case 'GreenshoeBidPlaced': {
      const d = ev.data;
      await db.query(`UPDATE settle_greenshoes SET bids = bids || $2::jsonb WHERE greenshoe = $1`, [d.greenshoe, JSON.stringify([{ level: d.level, binId: d.binId, amount: d.amount.toString(), limitOrder: d.limitOrder }])]);
      return;
    }
    case 'GreenshoeLevelSettled':
      await db.query(`UPDATE settle_greenshoes SET settled_levels = settled_levels || $2::jsonb WHERE greenshoe = $1`, [ev.data.greenshoe, JSON.stringify([ev.data.level])]);
      return;
    case 'GreenshoeFinished':
      await db.query(`UPDATE settle_greenshoes SET finished = true, burned = $2, returned = $3 WHERE greenshoe = $1`, [ev.data.greenshoe, ev.data.burned.toString(), ev.data.returned.toString()]);
      return;
  }
}

/** Signatures newer than `until` (exclusive), newest first. */
export async function listSince(rpc: Rpc, program: Address, until: Signature | undefined) {
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

/** One pass: every finalized cross_settle transaction after the stored cursor, oldest first; the cursor advances only after each commits. */
export async function pollSettleOnce(db: pg.Pool, rpc: Rpc, program: Address = CROSS_SETTLE_PROGRAM_ADDRESS, source = `rpc:${program}`): Promise<number> {
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
    applied += await ingestSettleTransaction(db, {
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
