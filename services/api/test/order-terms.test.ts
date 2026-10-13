// Limit price and quantity of open orders, read from the commit_order instruction (the event does not carry them).
// The pure decode needs no database; the ingest and backfill checks need DATABASE_URL (own schema, dropped afterwards).
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { getBase58Decoder } from '@solana/kit';
import { CROSS_CORE_PROGRAM_ADDRESS, getCommitOrderInstructionDataEncoder } from '@opening-cross/cross-core-client';
import { type IndexerRpc, type TxBody, backfillOrderTerms, commitTerms, ingestTransaction, migrate } from '@opening-cross/indexer';

const b58 = getBase58Decoder();
const data = (over: { price: bigint; quantity: bigint; commitment?: Uint8Array }) =>
  b58.decode(getCommitOrderInstructionDataEncoder().encode({ nonce: 1n, side: 0, escrow: 2600n, commitment: over.commitment ?? new Uint8Array(32), price: over.price, quantity: over.quantity, orderBump: 255 }));

const OWNER = '11111111111111111111111111111111';
const CROSS = 'CrossAccount1111111111111111111111111111111';
const ORDER_A = 'OrderAccountA11111111111111111111111111111';
const ORDER_B = 'OrderAccountB11111111111111111111111111111';
const OTHER_PROGRAM = 'Other111111111111111111111111111111111111111';
// account list: owner, protocol, cross, order, ...
const keys = [OWNER, 'Protocol', CROSS, ORDER_A, ORDER_B, CROSS_CORE_PROGRAM_ADDRESS, OTHER_PROGRAM];
const commitIx = (order: number, d: string, program = 5) => ({ programIdIndex: program, accounts: [0, 1, 2, order], data: d });

describe('commitTerms', () => {
  it('reads the price and quantity of an open order from a top-level commit_order', () => {
    const tx: TxBody = { transaction: { message: { accountKeys: keys, instructions: [commitIx(3, data({ price: 2_000_000n, quantity: 1000n }))] } } };
    expect(commitTerms(tx)).toEqual(new Map([[ORDER_A, { price: 2_000_000n, quantity: 1000n }]]));
  });

  it('reads two orders committed in one transaction, and a commit made by CPI from another program', () => {
    const tx: TxBody = {
      transaction: { message: { accountKeys: keys, instructions: [commitIx(3, data({ price: 1_300_000n, quantity: 5n })), { programIdIndex: 6, accounts: [], data: '' }] } },
      meta: { innerInstructions: [{ instructions: [commitIx(4, data({ price: 1_500_000n, quantity: 9n }))] }] },
    };
    expect(commitTerms(tx)).toEqual(new Map([[ORDER_A, { price: 1_300_000n, quantity: 5n }], [ORDER_B, { price: 1_500_000n, quantity: 9n }]]));
  });

  it('gives nothing for a sealed commit, whose terms are zero until the reveal', () => {
    const tx: TxBody = { transaction: { message: { accountKeys: keys, instructions: [commitIx(3, data({ price: 0n, quantity: 0n, commitment: new Uint8Array(32).fill(7) }))] } } };
    expect(commitTerms(tx).size).toBe(0);
  });

  it('ignores the same bytes sent to a different program and any other cross_core instruction', () => {
    const d = data({ price: 1n, quantity: 1n });
    expect(commitTerms({ transaction: { message: { accountKeys: keys, instructions: [commitIx(3, d, 6)] } } }).size).toBe(0);
    expect(commitTerms({ transaction: { message: { accountKeys: keys, instructions: [commitIx(3, b58.decode(new Uint8Array(40).fill(9)))] } } }).size).toBe(0);
  });

  it('resolves accounts that live in an address lookup table', () => {
    const tx: TxBody = {
      transaction: { message: { accountKeys: [OWNER, CROSS_CORE_PROGRAM_ADDRESS], instructions: [{ programIdIndex: 1, accounts: [0, 0, 0, 2], data: data({ price: 7n, quantity: 3n }) }] } },
      meta: { loadedAddresses: { writable: [ORDER_A], readonly: [] } },
    };
    expect(commitTerms(tx).get(ORDER_A)).toEqual({ price: 7n, quantity: 3n });
  });
});

const url = process.env.DATABASE_URL;
if (!url) console.warn('order-terms.test.ts database checks SKIPPED: set DATABASE_URL to run them');

describe.skipIf(!url)('order terms in the index', () => {
  const schema = `t_${randomBytes(6).toString('hex')}`;
  let admin: pg.Client;
  let db: pg.Pool;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    db = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
    await migrate(db);
    await db.query(
      `INSERT INTO crosses (address, creator, kind, supply_mode, disclosure, base_mint, quote_mint, open_ts, close_ts, reveal_end_ts, protocol_fee_bps, integrator_fee_bps, state, created_slot, updated_slot)
       VALUES ('C','X',0,0,1,'B','Q',0,1,1,0,0,'Live',1,1)`,
    );
  });
  afterAll(async () => {
    await db?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  it('backfills the terms of an open order indexed without them, leaves sealed orders alone, and reports what remains', async () => {
    await db.query(
      `INSERT INTO orders (cross_address, idx, address, owner, side, escrow, sealed, status, created_slot, updated_slot) VALUES
         ('C',0,'ORD1','w1',0,2600,false,'revealed',1,1), ('C',1,'ORD2','w2',0,40,true,'committed',1,1), ('C',2,'ORD3','w3',0,10,false,'revealed',1,1)`,
    );
    for (const [i, o] of ['ORD1', 'ORD2', 'ORD3'].entries()) {
      await db.query(`INSERT INTO events (signature, seq, slot, name, cross_address, payload) VALUES ($1,0,1,'OrderCommitted','C',$2)`, [`sig${i}`, JSON.stringify({ order: o })]);
    }
    const calls: string[] = [];
    const rpc = {
      getTransaction: (sig: string) => ({
        send: async () => {
          calls.push(sig);
          if (sig === 'sig2') return null; // a transaction the node cannot return
          return { transaction: { message: { accountKeys: [OWNER, 'P', CROSS, 'ORD1', ORDER_B, CROSS_CORE_PROGRAM_ADDRESS], instructions: [commitIx(3, data({ price: 2_000_000n, quantity: 1000n }))] } } };
        },
      }),
    } as unknown as IndexerRpc;

    const first = await backfillOrderTerms(db, rpc);
    expect(first).toEqual({ updated: 1, remaining: 0 }); // ORD3's transaction held nothing, so it is set aside, not counted as waiting
    const { rows } = await db.query('SELECT address, price, quantity FROM orders ORDER BY idx');
    expect(rows).toEqual([{ address: 'ORD1', price: '2000000', quantity: '1000' }, { address: 'ORD2', price: null, quantity: null }, { address: 'ORD3', price: null, quantity: null }]);

    calls.length = 0;
    expect(await backfillOrderTerms(db, rpc)).toEqual({ updated: 0, remaining: 0 });
    expect(calls).toEqual([]); // nothing left to read, and the unresolved order is not retried every poll
  });

  it('stores the terms of an open order the moment its commit transaction is ingested', async () => {
    // A CrossCreated + OrderCommitted pair is simplest to supply as already-decoded rows; ingestTransaction decodes real logs,
    // so here the terms path is exercised through the same INSERT by committing a transaction whose logs hold the event.
    const { ORDER_COMMITTED_EVENT_DISCRIMINATOR, getOrderCommittedEventEncoder } = await import('@opening-cross/cross-core-client');
    const REAL_CROSS = '11111111111111111111111111111111';
    const REAL_ORDER = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
    const REAL_OWNER = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
    await db.query(
      `INSERT INTO crosses (address, creator, kind, supply_mode, disclosure, base_mint, quote_mint, open_ts, close_ts, reveal_end_ts, protocol_fee_bps, integrator_fee_bps, state, created_slot, updated_slot)
       VALUES ($1,'X',0,0,1,'B','Q',0,1,1,0,0,'Live',1,1)`,
      [REAL_CROSS],
    );
    const ev = getOrderCommittedEventEncoder().encode({ cross: REAL_CROSS, order: REAL_ORDER, owner: REAL_OWNER, side: 0, escrow: 2600n, index: 7, sealed: false } as never);
    const log = `Program data: ${Buffer.from(ev).toString('base64')}`;
    expect(ORDER_COMMITTED_EVENT_DISCRIMINATOR.length).toBe(8);
    const applied = await ingestTransaction(db, {
      signature: 'live-sig',
      slot: 9n,
      blockTime: null,
      logs: [`Program ${CROSS_CORE_PROGRAM_ADDRESS} invoke [1]`, log],
      err: null,
      terms: new Map([[REAL_ORDER, { price: 1_300_000n, quantity: 2000n }]]),
    });
    expect(applied).toBe(1);
    const { rows } = await db.query(`SELECT price, quantity, status FROM orders WHERE address = $1`, [REAL_ORDER]);
    expect(rows).toEqual([{ price: '1300000', quantity: '2000', status: 'revealed' }]);
  });
});
