// Lands one transaction over plain HTTP, the way a keeper must on a public cluster where WebSocket
// subscriptions drop and a node can lag behind the one that issued the blockhash: the first send is
// preflighted so a refused step fails at once with the program's logs; the signed bytes are then re-sent
// every few seconds and the signature polled until the transaction confirms or its blockhash expires, in
// which case it is rebuilt on a fresh blockhash. A transaction that lands with an error is reported as such.
import {
  type Instruction,
  type TransactionSigner,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from '@solana/kit';
import type { IndexerRpc } from '@opening-cross/indexer';

export type PollingSendOptions = {
  /** Seconds between re-broadcasts of the same signed bytes (default 4). */
  resendMs?: number;
  /** Poll interval (default 1500 ms). */
  pollMs?: number;
  /** Fresh-blockhash rebuilds before giving up (default 5). */
  attempts?: number;
  sleep?: (ms: number) => Promise<void>;
};

const lagging = (e: unknown) => String(e).includes('Blockhash not found') || String((e as { cause?: unknown })?.cause).includes('Blockhash not found');

export function pollingSender(rpc: IndexerRpc, payer: TransactionSigner, opts: PollingSendOptions = {}): (ixs: Instruction[]) => Promise<string> {
  const resendMs = opts.resendMs ?? 4_000;
  const pollMs = opts.pollMs ?? 1_500;
  const attempts = opts.attempts ?? 5;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  return async (ixs) => {
    for (let attempt = 0; attempt < attempts; attempt++) {
      const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
      const tx = await signTransactionMessageWithSigners(
        pipe(
          createTransactionMessage({ version: 0 }),
          (m) => setTransactionMessageFeePayerSigner(payer, m),
          (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
          (m) => appendTransactionMessageInstructions(ixs, m),
        ),
      );
      const signature = getSignatureFromTransaction(tx);
      const wire = getBase64EncodedWireTransaction(tx);
      let lastSent = Number.NEGATIVE_INFINITY;
      let preflighted = false;
      for (;;) {
        if (Date.now() - lastSent >= resendMs) {
          try {
            await rpc.sendTransaction(wire, { encoding: 'base64', skipPreflight: preflighted || attempt > 0, preflightCommitment: 'confirmed' }).send();
            preflighted = true;
            lastSent = Date.now();
          } catch (e) {
            if (!lagging(e)) throw e;
            await sleep(pollMs);
            continue;
          }
        }
        const status = (await rpc.getSignatureStatuses([signature]).send()).value[0];
        if (status?.err) throw new Error(`transaction ${signature} failed: ${JSON.stringify(status.err, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}`);
        if (status && (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')) return signature;
        if ((await rpc.getBlockHeight({ commitment: 'confirmed' }).send()) > blockhash.lastValidBlockHeight) break;
        await sleep(pollMs);
      }
      // The blockhash expired; the transaction may still have landed in its last slots.
      const last = (await rpc.getSignatureStatuses([signature], { searchTransactionHistory: true }).send()).value[0];
      if (last && !last.err && last.confirmationStatus) return signature;
    }
    throw new Error(`transaction did not land after ${attempts} blockhashes`);
  };
}
