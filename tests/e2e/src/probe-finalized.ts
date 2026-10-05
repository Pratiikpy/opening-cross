// Diagnostic: for every signature getSignaturesForAddress returns at `finalized`, fetch the
// transaction at `finalized` and report any the node cannot return.
import { createSolanaRpc } from '@solana/kit';
import { CROSS_CORE_PROGRAM_ADDRESS } from '@opening-cross/sdk';

const rpc = createSolanaRpc(process.env.RPC_URL ?? 'http://127.0.0.1:8899');
const sigs = await rpc.getSignaturesForAddress(CROSS_CORE_PROGRAM_ADDRESS, { commitment: 'finalized', limit: 1000 }).send();
let bad = 0;
for (const s of sigs) {
  try {
    const tx = await rpc.getTransaction(s.signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0, encoding: 'json' }).send();
    if (!tx) { bad++; console.log('null', s.signature, s.slot, s.confirmationStatus); }
  } catch (e) {
    bad++;
    console.log('error', s.signature, s.slot, s.confirmationStatus, s.err ? 'failed-tx' : 'ok-tx', String(e).slice(0, 200));
  }
}
console.log(JSON.stringify({ signatures: sigs.length, unreadable: bad }));
