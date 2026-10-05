// One keeper pass against devnet with getProgramAccounts discovery. Prints the plan for every
// cross first, then executes it with KEEPER_KEYPAIR and prints the signatures.
import { readFileSync } from 'node:fs';
import {
  type Address, appendTransactionMessageInstructions, createKeyPairSignerFromBytes, createSolanaRpcSubscriptions, createTransactionMessage,
  fetchEncodedAccount, getSignatureFromTransaction, pipe, sendAndConfirmTransactionFactory, setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash, signTransactionMessageWithSigners,
} from '@solana/kit';
import { CrossState, getCrossDecoder } from '@opening-cross/cross-core-client';
import { createIndexerRpc } from '@opening-cross/indexer';
import { fromProgramAccounts } from '../src/discovery.js';
import { runOnce } from '../src/keeper.js';

const rpc = createIndexerRpc(process.env.RPC_URL ?? 'https://api.devnet.solana.com');
const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions: createSolanaRpcSubscriptions(process.env.WS_URL ?? 'wss://api.devnet.solana.com') });
const payer = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(process.env.KEEPER_KEYPAIR!, 'utf8'))));
const discovery = fromProgramAccounts(rpc);
const fetch = async (a: Address) => { const x = await fetchEncodedAccount(rpc, a, { commitment: 'confirmed' }); return x.exists ? x.data : null; };
const show = async () => {
  for (const c of await discovery.crosses()) {
    const d = getCrossDecoder().decode((await fetch(c))!);
    console.log(c, CrossState[d.state], 'ordersOpen', d.ordersOpen, 'revealEnd', d.revealEndTs.toString(), 'orders found', (await discovery.orders(c)).length);
  }
};
await show();
const res = await runOnce({
  payer, ...discovery, fetch,
  now: async () => BigInt(await rpc.getBlockTime(await rpc.getSlot({ commitment: 'confirmed' }).send()).send()),
  send: async (ixs) => {
    const { value: bh } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
    const tx = await signTransactionMessageWithSigners(pipe(createTransactionMessage({ version: 0 }), (m) => setTransactionMessageFeePayerSigner(payer, m), (m) => setTransactionMessageLifetimeUsingBlockhash(bh, m), (m) => appendTransactionMessageInstructions(ixs, m)));
    await sendAndConfirm(tx as Parameters<typeof sendAndConfirm>[0], { commitment: 'confirmed' });
    return getSignatureFromTransaction(tx);
  },
});
console.log(JSON.stringify(res, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
await show();
