// Shared set-up for the off-chain route tests: a throwaway Postgres schema (skipped when DATABASE_URL is unset), an in-memory
// chain of accounts, and a cross account built from a zeroed buffer with chosen fields.
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { type Address, generateKeyPairSigner } from '@solana/kit';
import { CROSS_CORE_PROGRAM_ADDRESS, CROSS_DISCRIMINATOR, getCrossDecoder, getCrossEncoder } from '@opening-cross/sdk';
import { migrate } from '@opening-cross/indexer';

export type Account = { data: Uint8Array; owner: Address };

export const databaseUrl = process.env.DATABASE_URL;

export async function openSchema(): Promise<{ db: pg.Pool; close: () => Promise<void> }> {
  const schema = `t_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: databaseUrl });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  const db = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  await migrate(db);
  return {
    db,
    close: async () => {
      await db.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    },
  };
}

export class Chain {
  readonly accounts = new Map<string, Account>();
  readonly reads: string[] = [];
  read = async (a: Address): Promise<Account | null> => {
    this.reads.push(a);
    return this.accounts.get(a) ?? null;
  };
  set(a: string, acct: Account) {
    this.accounts.set(a, acct);
  }
  delete(a: string) {
    this.accounts.delete(a);
  }
  /** Puts a cross account on chain with the given fields over a zeroed one; returns its address. */
  async putCross(over: Record<string, unknown> = {}, address?: Address): Promise<Address> {
    const a = address ?? (await generateKeyPairSigner()).address;
    this.set(a, { owner: CROSS_CORE_PROGRAM_ADDRESS as Address, data: crossBytes(over) });
    return a;
  }
}

export function crossBytes(over: Record<string, unknown> = {}): Uint8Array {
  const z = new Uint8Array(4096);
  z.set(CROSS_DISCRIMINATOR as Uint8Array, 0);
  return new Uint8Array(getCrossEncoder().encode({ ...getCrossDecoder().decode(z), priceScale: 1_000_000n, ...over } as never));
}

export async function newAddress(): Promise<Address> {
  return (await generateKeyPairSigner()).address;
}

export function insertCross(db: pg.Pool, a: string, o: { state?: string; kind?: number; closeTs?: bigint; protocolFee?: bigint | null; slot?: number } = {}) {
  const close = o.closeTs ?? 1_800_000_100n;
  return db.query(
    `INSERT INTO crosses (address, creator, kind, supply_mode, disclosure, base_mint, quote_mint, open_ts, close_ts, reveal_end_ts, protocol_fee_bps, integrator_fee_bps, state, protocol_fee, created_slot, updated_slot)
     VALUES ($1,'creator',$2,0,1,'baseMint','quoteMint',$3,$4,$4,5,0,$5,$6,$7,$7)`,
    [a, o.kind ?? 1, (close - 100n).toString(), close.toString(), o.state ?? 'Finalized', o.protocolFee === undefined ? null : o.protocolFee?.toString() ?? null, o.slot ?? 1],
  );
}

export function insertOrder(db: pg.Pool, cross: string, idx: number, owner: string, side: 'buy' | 'sell', price: bigint, quantity: bigint, status = 'revealed') {
  return db.query(
    `INSERT INTO orders (cross_address, idx, address, owner, side, escrow, sealed, status, price, quantity, created_slot, updated_slot)
     VALUES ($1,$2,$3,$4,$5,1,false,$6,$7,$8,1,1)`,
    [cross, idx, `${cross}-o${idx}`, owner, side === 'buy' ? 0 : 1, status, price.toString(), quantity.toString()],
  );
}
