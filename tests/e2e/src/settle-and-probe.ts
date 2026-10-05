// Diagnostic: settles the seeded crosses after their windows, then asks the node for every
// cross_core transaction it lists, at finalized and confirmed, and prints any it cannot return
// together with the raw RPC error.
import { readFileSync } from 'node:fs';
import {
  type Address,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
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
import { CROSS_CORE_PROGRAM_ADDRESS, buildSettleBook, getCrossDecoder } from '@opening-cross/sdk';

const URL = process.env.RPC_URL ?? 'http://127.0.0.1:8899';
const rpc = createSolanaRpc(URL);
const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions: createSolanaRpcSubscriptions('ws://127.0.0.1:8900') });
const seed = JSON.parse(readFileSync(process.env.SEED ?? '/tmp/oc-e2e.json', 'utf8'));
const payer = await createKeyPairSignerFromBytes(Uint8Array.from(seed.wallets.buyer.secret));

for (const address of Object.values(seed.crosses) as Address[]) {
  const acct = await fetchEncodedAccount(rpc, address);
  if (!acct.exists) continue;
  const view = { address, data: getCrossDecoder().decode(acct.data) };
  for (const ix of await buildSettleBook(view)) {
    const { value: bh } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
    const tx = await signTransactionMessageWithSigners(pipe(createTransactionMessage({ version: 0 }), (m) => setTransactionMessageFeePayerSigner(payer, m), (m) => setTransactionMessageLifetimeUsingBlockhash(bh, m), (m) => appendTransactionMessageInstructions([ix], m)));
    await sendAndConfirm(tx as Parameters<typeof sendAndConfirm>[0], { commitment: 'confirmed' });
    console.log('sent', getSignatureFromTransaction(tx));
  }
}
await new Promise((r) => setTimeout(r, 25_000)); // let everything finalize
const sigs = await rpc.getSignaturesForAddress(CROSS_CORE_PROGRAM_ADDRESS, { commitment: 'finalized', limit: 1000 }).send();
for (const s of sigs) {
  for (const commitment of ['finalized', 'confirmed'] as const) {
    const body = { jsonrpc: '2.0', id: 1, method: 'getTransaction', params: [s.signature, { commitment, encoding: 'json', maxSupportedTransactionVersion: 0 }] };
    const r = (await (await fetch(URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json()) as { result?: unknown; error?: unknown };
    if (!r.result) console.log('UNREADABLE', commitment, s.signature, 'slot', s.slot, 'err', JSON.stringify(s.err), 'rpc', JSON.stringify(r.error ?? null));
  }
}
console.log(JSON.stringify({ listed: sigs.length }));
process.exit(0);
