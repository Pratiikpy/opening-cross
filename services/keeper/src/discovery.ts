// Candidate discovery. The indexer is the cheap path; the program-account scan needs no database
// and is what a keeper with only an RPC endpoint uses. Neither is trusted: the keeper re-reads
// every account it acts on.
import { type Address, type Base58EncodedBytes, getBase58Decoder } from '@solana/kit';
import type pg from 'pg';
import { CROSS_CORE_PROGRAM_ADDRESS, CROSS_DISCRIMINATOR, HALT_STATE_DISCRIMINATOR, LOCKUP_DISCRIMINATOR, ORDER_DISCRIMINATOR, SERIES_DISCRIMINATOR, haltStateAddress, lockupAddress } from '@opening-cross/cross-core-client';
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
    // Locked fills with something left to release. A lock indexed without its nonce cannot be addressed and is left to the owner.
    lockups: async (): Promise<Address[]> => {
      const { rows } = scope.creators
        ? await db.query(`SELECT l.cross_address, l.owner, l.nonce::text AS nonce FROM cross_locks l JOIN crosses c ON c.address = l.cross_address WHERE l.released < l.amount AND l.nonce IS NOT NULL AND c.creator = ANY($1) ORDER BY l.created_slot`, [scope.creators])
        : await db.query(`SELECT cross_address, owner, nonce::text AS nonce FROM cross_locks WHERE released < amount AND nonce IS NOT NULL ORDER BY created_slot`);
      return Promise.all(rows.map((r) => lockupAddress(r.cross_address as Address, r.owner as Address, BigInt(r.nonce as string))));
    },
    series: async (): Promise<Address[]> =>
      (scope.creators ? await db.query(`SELECT address FROM series WHERE authority = ANY($1) ORDER BY created_slot`, [scope.creators]) : await db.query(`SELECT address FROM series ORDER BY created_slot`)).rows.map((r) => r.address as Address),
    // The authority of a halt state is not in the index, so a scoped keeper watches the halt states of the mints of its own crosses only through the program scan.
    halts: async (): Promise<Address[]> => Promise.all((await db.query(`SELECT base_mint FROM halt_states ORDER BY base_mint`)).rows.map((r) => haltStateAddress(r.base_mint as Address))),
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
    // Accounts of one kind, by discriminator. A series names its authority first and a halt state its authority second, so a scope is a server-side filter for both;
    // a lockup names only its cross, so a scoped keeper checks the cross's creator when it reads the lockup (KeeperDeps.accept).
    lockups: (): Promise<Address[]> => scan(rpc, program, LOCKUP_DISCRIMINATOR as Uint8Array, []),
    series: async (): Promise<Address[]> => {
      const find = (creator?: Address) => scan(rpc, program, SERIES_DISCRIMINATOR as Uint8Array, creator ? [{ memcmp: { offset: 8n, bytes: creator as unknown as Base58EncodedBytes, encoding: 'base58' as const } }] : []);
      return scope.creators ? (await Promise.all(scope.creators.map((c) => find(c)))).flat() : find();
    },
    halts: async (): Promise<Address[]> => {
      const find = (creator?: Address) => scan(rpc, program, HALT_STATE_DISCRIMINATOR as Uint8Array, creator ? [{ memcmp: { offset: 40n, bytes: creator as unknown as Base58EncodedBytes, encoding: 'base58' as const } }] : []);
      return scope.creators ? (await Promise.all(scope.creators.map((c) => find(c)))).flat() : find();
    },
  };
}

async function scan(rpc: IndexerRpc, program: Address, disc: Uint8Array, more: { memcmp: { offset: bigint; bytes: Base58EncodedBytes; encoding: 'base58' } }[]): Promise<Address[]> {
  return (
    await rpc
      .getProgramAccounts(program, { commitment: 'confirmed', encoding: 'base64', dataSlice: { offset: 0, length: 0 }, filters: [{ memcmp: { offset: 0n, bytes: b58(disc), encoding: 'base58' } }, ...more] })
      .send()
  ).map((a) => a.pubkey);
}
