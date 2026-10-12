// Candidate discovery. The indexer is the cheap path; the program-account scan needs no database
// and is what a keeper with only an RPC endpoint uses. Neither is trusted: the keeper re-reads
// every account it acts on.
import { type Address, type Base58EncodedBytes, getBase58Decoder } from '@solana/kit';
import type pg from 'pg';
import { CROSS_CORE_PROGRAM_ADDRESS, CROSS_DISCRIMINATOR, ORDER_DISCRIMINATOR } from '@opening-cross/cross-core-client';
import type { IndexerRpc } from '@opening-cross/indexer';

/** `creators` limits discovery to crosses made by those creators, so a scoped keeper never reads anyone else's. */
export type DiscoveryScope = { creators?: readonly Address[] };

export function fromIndexer(db: pg.Pool, scope: DiscoveryScope = {}) {
  return {
    crosses: async () =>
      (
        scope.creators
          ? await db.query(`SELECT address FROM crosses WHERE state <> 'Finalized' AND creator = ANY($1) ORDER BY created_slot`, [scope.creators])
          : await db.query(`SELECT address FROM crosses WHERE state <> 'Finalized' ORDER BY created_slot`)
      ).rows.map((r) => r.address as Address),
    orders: async (cross: Address) =>
      (await db.query(`SELECT address FROM orders WHERE cross_address = $1 AND status IN ('committed', 'revealed') ORDER BY idx`, [cross])).rows.map((r) => r.address as Address),
  };
}

const b58 = (bytes: Uint8Array) => getBase58Decoder().decode(bytes) as Base58EncodedBytes;

export function fromProgramAccounts(rpc: IndexerRpc, program: Address = CROSS_CORE_PROGRAM_ADDRESS, scope: DiscoveryScope = {}) {
  return {
    // The creator is the first field after the 8-byte discriminator, so a scope is a server-side filter.
    crosses: async () => {
      const scan = async (creator?: Address) =>
        (
          await rpc
            .getProgramAccounts(program, {
              commitment: 'confirmed',
              encoding: 'base64',
              dataSlice: { offset: 0, length: 0 },
              filters: [
                { memcmp: { offset: 0n, bytes: b58(CROSS_DISCRIMINATOR as Uint8Array), encoding: 'base58' } },
                ...(creator ? [{ memcmp: { offset: 8n, bytes: creator as unknown as Base58EncodedBytes, encoding: 'base58' as const } }] : []),
              ],
            })
            .send()
        ).map((a) => a.pubkey);
      return scope.creators ? (await Promise.all(scope.creators.map((c) => scan(c)))).flat() : scan();
    },
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
