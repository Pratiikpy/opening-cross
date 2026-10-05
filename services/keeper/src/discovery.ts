// Candidate discovery. The indexer is the cheap path; the program-account scan needs no database
// and is what a keeper with only an RPC endpoint uses. Neither is trusted: the keeper re-reads
// every account it acts on.
import { type Address, type Base58EncodedBytes, getBase58Decoder } from '@solana/kit';
import type pg from 'pg';
import { CROSS_CORE_PROGRAM_ADDRESS, CROSS_DISCRIMINATOR, ORDER_DISCRIMINATOR } from '@opening-cross/cross-core-client';
import type { IndexerRpc } from '@opening-cross/indexer';

export function fromIndexer(db: pg.Pool) {
  return {
    crosses: async () => (await db.query(`SELECT address FROM crosses WHERE state <> 'Finalized' ORDER BY created_slot`)).rows.map((r) => r.address as Address),
    orders: async (cross: Address) =>
      (await db.query(`SELECT address FROM orders WHERE cross_address = $1 AND status IN ('committed', 'revealed') ORDER BY idx`, [cross])).rows.map((r) => r.address as Address),
  };
}

const b58 = (bytes: Uint8Array) => getBase58Decoder().decode(bytes) as Base58EncodedBytes;

export function fromProgramAccounts(rpc: IndexerRpc, program: Address = CROSS_CORE_PROGRAM_ADDRESS) {
  return {
    crosses: async () =>
      (await rpc.getProgramAccounts(program, { commitment: 'confirmed', encoding: 'base64', dataSlice: { offset: 0, length: 0 }, filters: [{ memcmp: { offset: 0n, bytes: b58(CROSS_DISCRIMINATOR as Uint8Array), encoding: 'base58' } }] }).send()).map((a) => a.pubkey),
    orders: async (cross: Address) =>
      (
        await rpc
          .getProgramAccounts(program, {
            commitment: 'confirmed',
            encoding: 'base64',
            dataSlice: { offset: 0, length: 0 },
            filters: [
              { memcmp: { offset: 0n, bytes: b58(ORDER_DISCRIMINATOR as Uint8Array), encoding: 'base58' } },
              { memcmp: { offset: 8n, bytes: cross as unknown as Base58EncodedBytes, encoding: 'base58' } },
            ],
          })
          .send()
      ).map((a) => a.pubkey),
  };
}
