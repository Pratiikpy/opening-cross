// A real Postgres in the test process (PGlite) carrying the indexer's own migrations, so the SQL the holder routes run is
// executed by Postgres itself, not by a stand-in.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const migration = (name: string) => readFileSync(fileURLToPath(new URL(`../../../indexer/migrations/${name}`, import.meta.url)), 'utf8');

export async function holderDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(migration('001_init.sql'));
  await db.exec(migration('006_calendar.sql'));
  return db;
}

export async function addCross(db: PGlite, c: { address: string; state: string; open: number; close: number; base?: string; quote?: string; price?: string | null; matched?: string | null; createdSlot?: number }) {
  await db.query(
    `INSERT INTO crosses (address, creator, kind, supply_mode, disclosure, base_mint, quote_mint, open_ts, close_ts, reveal_end_ts, protocol_fee_bps, integrator_fee_bps, state, clearing_price, matched, created_slot, updated_slot)
     VALUES ($1, 'creator', 0, 0, 0, $2, $3, $4, $5, $5, 30, 0, $6, $7, $8, $9, $9)`,
    [c.address, c.base ?? 'BaseMint11111111111111111111111111111111111', c.quote ?? 'QuoteMint1111111111111111111111111111111111', c.open, c.close, c.state, c.price ?? null, c.matched ?? null, c.createdSlot ?? 1],
  );
}

export async function addOrder(db: PGlite, o: { cross: string; idx: number; address: string; owner: string; side?: number; status: string; escrow?: string; price?: string | null; quantity?: string | null; fill?: string | null; baseOut?: string | null; quoteOut?: string | null; slot?: number }) {
  await db.query(
    `INSERT INTO orders (cross_address, idx, address, owner, side, escrow, sealed, price, quantity, status, fill, quote_out, base_out, fee, created_slot, updated_slot)
     VALUES ($1, $2, $3, $4, $5, $6, false, $7, $8, $9, $10, $11, $12, 0, $13, $13)`,
    [o.cross, o.idx, o.address, o.owner, o.side ?? 0, o.escrow ?? '1000000', o.price ?? null, o.quantity ?? null, o.status, o.fill ?? null, o.quoteOut ?? null, o.baseOut ?? null, o.slot ?? 1],
  );
}
