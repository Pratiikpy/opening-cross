// Settles the seeded open-book cross once its call window has closed, and prints the on-chain clearing price.
//
//   RPC_URL=http://127.0.0.1:8899 WS_URL=ws://127.0.0.1:8900 SEED=/tmp/oc-e2e.json tsx src/settle-open.ts
import { readFileSync } from 'node:fs';
import {
  type Address,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  fetchEncodedAccount,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from '@solana/kit';
import { buildSettleBook, getCrossDecoder } from '@opening-cross/sdk';

const rpc = createSolanaRpc(process.env.RPC_URL ?? 'http://127.0.0.1:8899');
const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions: createSolanaRpcSubscriptions(process.env.WS_URL ?? 'ws://127.0.0.1:8900') });
const seed = JSON.parse(readFileSync(process.env.SEED ?? '/tmp/oc-e2e.json', 'utf8')) as { crosses: { open: Address }; wallets: Record<string, { secret: number[] }> };
const payer = await createKeyPairSignerFromBytes(Uint8Array.from(seed.wallets.buyer!.secret));

const read = async () => {
  const acct = await fetchEncodedAccount(rpc, seed.crosses.open);
  if (!acct.exists) throw new Error('open cross missing');
  return { address: seed.crosses.open, data: getCrossDecoder().decode(acct.data) };
};
const view = await read();
for (;;) {
  const now = (await rpc.getBlockTime(await rpc.getSlot().send()).send()) ?? 0n;
  if (BigInt(now) > view.data.revealEndTs) break;
  await new Promise((r) => setTimeout(r, 2_000));
}
for (const ix of await buildSettleBook(view)) {
  const { value: bh } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
  const tx = await signTransactionMessageWithSigners(pipe(createTransactionMessage({ version: 0 }), (m) => setTransactionMessageFeePayerSigner(payer, m), (m) => setTransactionMessageLifetimeUsingBlockhash(bh, m), (m) => appendTransactionMessageInstructions([ix], m)));
  await sendAndConfirm(tx as Parameters<typeof sendAndConfirm>[0], { commitment: 'confirmed' });
}
const after = await read();
console.log(JSON.stringify({ state: after.data.state, clearing: after.data.clearing.__option === 'Some' ? { price: after.data.clearing.value.price.toString(), matched: after.data.clearing.value.matched.toString() } : null }));
process.exit(0);
