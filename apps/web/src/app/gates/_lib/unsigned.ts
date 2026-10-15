'use client';

// Turns instructions from the gate client into an unsigned transaction the wallet signs and `signSendConfirm` lands. Signers
// the instructions name are placeholders (the wallet signs for them); only the fee payer's address matters here.
import {
  type Address,
  type Instruction,
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';
import type { Unsigned } from '@/lib/tx';
import { rpc } from './rpc';

const bytesToB64 = (b: Uint8Array) => btoa(Array.from(b, (x) => String.fromCharCode(x)).join(''));

/** A fee payer that will sign in the wallet: kit builds the message with it, the wallet's signature fills the slot later. */
export const walletSigner = (address: string) => createNoopSigner(address as Address);

export async function unsignedTransaction(instructions: Instruction[], feePayer: string): Promise<Unsigned> {
  const { value } = await rpc<{ value: { blockhash: string; lastValidBlockHeight: number } }>('getLatestBlockhash', [{ commitment: 'confirmed' }]);
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(walletSigner(feePayer), m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: value.blockhash as never, lastValidBlockHeight: BigInt(value.lastValidBlockHeight) }, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  return { transaction: bytesToB64(new Uint8Array(getTransactionEncoder().encode(compileTransaction(message)))), signers: [] };
}
