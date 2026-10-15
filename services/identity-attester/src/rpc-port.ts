// ChainPort over a Solana JSON-RPC endpoint. Transactions are sent over HTTP and re-broadcast until they confirm or their
// blockhash expires (public clusters drop transactions and lag between nodes), the same way the keeper does.
import {
  type Address,
  type Instruction,
  type Rpc,
  type SolanaRpcApi,
  type TransactionSigner,
  appendTransactionMessageInstructions,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from '@solana/kit';
import { SAS_PROGRAM_ADDRESS } from '@opening-cross/cross-gate-client';
import type { ChainPort } from './sas.js';

const b64 = (s: string) => Uint8Array.from(Buffer.from(s, 'base64'));
const lagging = (e: unknown) => String(e).includes('Blockhash not found') || String((e as { cause?: unknown })?.cause).includes('Blockhash not found');
const show = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));

export function rpcChainPort(url: string, signer: TransactionSigner, opts: { sleep?: (ms: number) => Promise<void>; pollMs?: number; resendMs?: number } = {}): ChainPort & { rpc: Rpc<SolanaRpcApi> } {
  const rpc = createSolanaRpc(url);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = opts.pollMs ?? 1_500;
  const resendMs = opts.resendMs ?? 4_000;
  return {
    rpc,
    async getAccount(address: Address) {
      const { value } = await rpc.getAccountInfo(address, { encoding: 'base64', commitment: 'confirmed' }).send();
      return value ? { data: b64(value.data[0]), owner: value.owner } : null;
    },
    async listAttestations(credential: Address, schema: Address) {
      const res = await rpc
        .getProgramAccounts(SAS_PROGRAM_ADDRESS, {
          encoding: 'base64',
          commitment: 'confirmed',
          filters: [
            { memcmp: { offset: 33n, bytes: credential as never, encoding: 'base58' } },
            { memcmp: { offset: 65n, bytes: schema as never, encoding: 'base58' } },
          ],
        })
        .send();
      return (res as unknown as { pubkey: Address; account: { data: [string, string] } }[]).map((r) => ({ address: r.pubkey, data: b64(r.account.data[0]) }));
    },
    async send(ixs: Instruction[]) {
      for (let attempt = 0; attempt < 5; attempt++) {
        const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
        const tx = await signTransactionMessageWithSigners(
          pipe(
            createTransactionMessage({ version: 0 }),
            (m) => setTransactionMessageFeePayerSigner(signer, m),
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
          if (status?.err) throw new Error(`transaction ${signature} failed: ${show(status.err)}`);
          if (status && (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')) return signature;
          if ((await rpc.getBlockHeight({ commitment: 'confirmed' }).send()) > blockhash.lastValidBlockHeight) break;
          await sleep(pollMs);
        }
        const last = (await rpc.getSignatureStatuses([signature], { searchTransactionHistory: true }).send()).value[0];
        if (last && !last.err && last.confirmationStatus) return signature;
      }
      throw new Error('transaction did not land after 5 blockhashes');
    },
  };
}
