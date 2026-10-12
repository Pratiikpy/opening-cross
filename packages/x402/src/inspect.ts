// Reads a transaction the way a verifier must: from its message bytes, without trusting any field the sender could
// have set to mislead. No RPC and no address lookup tables, so every account an instruction touches is visible here.
import { createHash } from 'node:crypto';
import { type Address, type SignatureBytes, getBase64Encoder, getCompiledTransactionMessageDecoder, getTransactionDecoder } from '@solana/kit';
import { MAX_TRANSACTION_BYTES } from './constants.js';
import { WireError } from './types.js';

export type InspectedInstruction = { program: Address; accounts: readonly Address[]; data: Uint8Array };

export type InspectedTransaction = {
  version: 'legacy' | 0;
  feePayer: Address;
  /** The accounts that must sign, in message order (the fee payer first). */
  signers: readonly Address[];
  signatures: Readonly<Record<string, SignatureBytes | null>>;
  instructions: readonly InspectedInstruction[];
  messageBytes: Uint8Array;
  /** sha256 of the message bytes, hex. Names a payment: two transactions with the same message are one payment. */
  messageHash: string;
  blockhash: string;
};

export function inspectTransaction(base64: string): InspectedTransaction {
  let wire: Uint8Array;
  try {
    wire = getBase64Encoder().encode(base64) as Uint8Array;
  } catch {
    throw new WireError('invalid_exact_svm_payload_transaction_could_not_be_decoded', 'the transaction is not base64');
  }
  if (wire.length > MAX_TRANSACTION_BYTES) throw new WireError('invalid_exact_svm_payload_transaction_could_not_be_decoded', `the transaction is larger than ${MAX_TRANSACTION_BYTES} bytes`);
  try {
    const tx = getTransactionDecoder().decode(wire);
    const message = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    if (message.version !== 'legacy' && message.version !== 0) throw new WireError('invalid_exact_svm_payload_transaction_version', `transaction version ${String(message.version)} is not supported; use legacy or v0`);
    if (message.version === 0 && message.addressTableLookups && message.addressTableLookups.length > 0) throw new WireError('invalid_exact_svm_payload_lookup_tables', 'address lookup tables are not accepted: every account must be visible in the message');
    const accounts = message.staticAccounts;
    const instructions = message.instructions.map((ix) => {
      const program = accounts[ix.programAddressIndex];
      if (!program) throw new WireError('invalid_exact_svm_payload_transaction_could_not_be_decoded', 'an instruction names a program outside the account list');
      const metas = (ix.accountIndices ?? []).map((i) => {
        const a = accounts[i];
        if (!a) throw new WireError('invalid_exact_svm_payload_transaction_could_not_be_decoded', 'an instruction names an account outside the account list');
        return a;
      });
      return { program, accounts: metas, data: new Uint8Array(ix.data ?? []) } satisfies InspectedInstruction;
    });
    const feePayer = accounts[0];
    if (!feePayer) throw new WireError('invalid_exact_svm_payload_transaction_could_not_be_decoded', 'the transaction has no accounts');
    const messageBytes = new Uint8Array(tx.messageBytes);
    return {
      version: message.version,
      feePayer,
      signers: accounts.slice(0, message.header.numSignerAccounts),
      signatures: tx.signatures,
      instructions,
      messageBytes,
      messageHash: createHash('sha256').update(messageBytes).digest('hex'),
      blockhash: String(message.lifetimeToken),
    };
  } catch (e) {
    if (e instanceof WireError) throw e;
    throw new WireError('invalid_exact_svm_payload_transaction_could_not_be_decoded', 'the transaction could not be decoded');
  }
}
