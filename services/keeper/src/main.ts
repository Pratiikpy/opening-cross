// Keeper process. RPC_URL and KEEPER_KEYPAIR (a Solana CLI JSON keypair that pays fees) are required;
// DATABASE_URL switches discovery to the indexer. Runs a pass every PASS_MS. Transactions are landed over
// plain HTTP (see send.ts), so no WebSocket endpoint is needed.
import { readFileSync } from 'node:fs';
import { type Address, createKeyPairSignerFromBytes, fetchEncodedAccount } from '@solana/kit';
import pg from 'pg';
import { createIndexerRpc } from '@opening-cross/indexer';
import { fromIndexer, fromProgramAccounts } from './discovery.js';
import { runOnce } from './keeper.js';
import { pollingSender } from './send.js';

const { RPC_URL, KEEPER_KEYPAIR, DATABASE_URL } = process.env;
if (!RPC_URL || !KEEPER_KEYPAIR) {
  console.error('RPC_URL and KEEPER_KEYPAIR are required');
  process.exit(2);
}
const passMs = Number(process.env.PASS_MS ?? 10_000);
// KEEPER_CREATORS (comma-separated addresses) limits this keeper to crosses made by those creators.
const creators = process.env.KEEPER_CREATORS ? new Set(process.env.KEEPER_CREATORS.split(',').map((a) => a.trim()).filter(Boolean)) : null;
const rpc = createIndexerRpc(RPC_URL);
const payer = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(KEEPER_KEYPAIR, 'utf8'))));
const send = pollingSender(rpc, payer);
const discovery = DATABASE_URL ? fromIndexer(new pg.Pool({ connectionString: DATABASE_URL })) : fromProgramAccounts(rpc);

for (;;) {
  try {
    const res = await runOnce({
      payer,
      ...(creators ? { accept: (c: { creator: string }) => creators.has(c.creator) } : {}),
      ...discovery,
      now: async () => {
        const slot = await rpc.getSlot({ commitment: 'confirmed' }).send();
        const t = await rpc.getBlockTime(slot).send();
        return BigInt(t);
      },
      fetch: async (a: Address) => {
        const x = await fetchEncodedAccount(rpc, a, { commitment: 'confirmed' });
        return x.exists ? x.data : null;
      },
      send,
    });
    if (res.done.length || res.failed.length) console.log(JSON.stringify({ at: new Date().toISOString(), ...res }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  } catch (e) {
    console.error(JSON.stringify({ at: new Date().toISOString(), error: String(e) }));
  }
  await new Promise((r) => setTimeout(r, passMs));
}
