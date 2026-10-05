// Keeper process. RPC_URL, WS_URL and KEEPER_KEYPAIR (a Solana CLI JSON keypair that pays fees)
// are required; DATABASE_URL switches discovery to the indexer. Runs a pass every PASS_MS.
import { readFileSync } from 'node:fs';
import {
  type Address,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  fetchEncodedAccount,
  getSignatureFromTransaction,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from '@solana/kit';
import pg from 'pg';
import { createIndexerRpc } from '@opening-cross/indexer';
import { fromIndexer, fromProgramAccounts } from './discovery.js';
import { runOnce } from './keeper.js';

const { RPC_URL, WS_URL, KEEPER_KEYPAIR, DATABASE_URL } = process.env;
if (!RPC_URL || !WS_URL || !KEEPER_KEYPAIR) {
  console.error('RPC_URL, WS_URL and KEEPER_KEYPAIR are required');
  process.exit(2);
}
const passMs = Number(process.env.PASS_MS ?? 10_000);
const rpc = createIndexerRpc(RPC_URL);
const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions: createSolanaRpcSubscriptions(WS_URL) });
const payer = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(KEEPER_KEYPAIR, 'utf8'))));
const discovery = DATABASE_URL ? fromIndexer(new pg.Pool({ connectionString: DATABASE_URL })) : fromProgramAccounts(rpc);

for (;;) {
  try {
    const res = await runOnce({
      payer,
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
      send: async (ixs) => {
        const { value: bh } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
        const tx = await signTransactionMessageWithSigners(
          pipe(createTransactionMessage({ version: 0 }), (m) => setTransactionMessageFeePayerSigner(payer, m), (m) => setTransactionMessageLifetimeUsingBlockhash(bh, m), (m) => appendTransactionMessageInstructions(ixs, m)),
        );
        await sendAndConfirm(tx as Parameters<typeof sendAndConfirm>[0], { commitment: 'confirmed' });
        return getSignatureFromTransaction(tx);
      },
    });
    if (res.done.length || res.failed.length) console.log(JSON.stringify({ at: new Date().toISOString(), ...res }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  } catch (e) {
    console.error(JSON.stringify({ at: new Date().toISOString(), error: String(e) }));
  }
  await new Promise((r) => setTimeout(r, passMs));
}
