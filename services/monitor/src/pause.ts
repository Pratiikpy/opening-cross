// The guardian's pause, through the program's own instruction (cross_core `set_paused`). Nothing else is built here: no unpause, no
// other instruction. The signer must be the protocol's guardian or admin; the program checks that, not this file.
import {
  type Address,
  type KeyPairSigner,
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
import { CROSS_CORE_PROGRAM_ADDRESS, getProtocolDecoder, protocolAddress } from '@opening-cross/sdk';
import { getSetPausedInstructionAsync } from '@opening-cross/cross-core-client';
import type { PauseAction } from './engine.js';

export function guardianPause(rpcUrl: string, signer: KeyPairSigner, o: { confirmMs?: number } = {}): PauseAction {
  const rpc = createSolanaRpc(rpcUrl);
  return {
    async isPaused() {
      const a = await rpc.getAccountInfo(await protocolAddress(), { encoding: 'base64', commitment: 'confirmed' }).send();
      if (!a.value || a.value.owner !== CROSS_CORE_PROGRAM_ADDRESS) throw new Error('the protocol account is missing');
      return getProtocolDecoder().decode(Uint8Array.from(Buffer.from(a.value.data[0], 'base64'))).paused;
    },
    async pause() {
      const ix = await getSetPausedInstructionAsync({ signer, paused: true });
      for (let attempt = 0; attempt < 3; attempt++) {
        const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
        const tx = await signTransactionMessageWithSigners(
          pipe(createTransactionMessage({ version: 0 }), (m) => setTransactionMessageFeePayerSigner(signer, m), (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m), (m) => appendTransactionMessageInstructions([ix], m)),
        );
        const signature = getSignatureFromTransaction(tx);
        await rpc.sendTransaction(getBase64EncodedWireTransaction(tx), { encoding: 'base64', preflightCommitment: 'confirmed' }).send();
        const deadline = Date.now() + (o.confirmMs ?? 45_000);
        while (Date.now() < deadline) {
          const st = (await rpc.getSignatureStatuses([signature]).send()).value[0];
          if (st?.err) throw new Error(`the pause transaction failed on chain: ${JSON.stringify(st.err, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}`);
          if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) return { signature };
          await new Promise((r) => setTimeout(r, 1_000));
        }
      }
      throw new Error('the pause transaction was not confirmed after three blockhash lifetimes');
    },
  };
}

export type { Address };
