// The size of a transaction, measured the way the network measures it: the wire bytes of a signed transaction.
//
// A legacy or version-0 transaction is at most 1,232 bytes. LiteSVM does not enforce the limit, so a builder that works in a test
// can still be refused by a cluster; `create_cross` plus `set_rules` is the pair that came closest (ADR-0450, W2D-cross-core-build).
// The measure counts one 64-byte signature slot per required signer and the message as the API compiles it (version 0, no lookup
// tables), with a placeholder blockhash, which is the same length as a real one.
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

/** The largest transaction the network accepts, in bytes. */
export const TRANSACTION_LIMIT_BYTES = 1_232;

const PLACEHOLDER_BLOCKHASH = '11111111111111111111111111111111';

/** Wire size in bytes of a transaction with these instructions and `feePayer` paying. */
export function wireSize(feePayer: Address, instructions: readonly Instruction[]): number {
  const tx = compileTransaction(
    pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(createNoopSigner(feePayer), m),
      (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: PLACEHOLDER_BLOCKHASH as never, lastValidBlockHeight: 1n }, m),
      (m) => appendTransactionMessageInstructions([...instructions], m),
    ),
  );
  return getTransactionEncoder().encode(tx).length;
}

/** Throws `TransactionTooLarge` when the instructions do not fit one transaction. Returns the size otherwise. */
export function assertFits(feePayer: Address, instructions: readonly Instruction[], what = 'transaction'): number {
  const size = wireSize(feePayer, instructions);
  if (size > TRANSACTION_LIMIT_BYTES) throw new Error(`TransactionTooLarge: the ${what} is ${size} bytes; a transaction holds at most ${TRANSACTION_LIMIT_BYTES}`);
  return size;
}
