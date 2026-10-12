// The buyer's side of the `exact` scheme on Solana: builds the SPL token transfer the requirements describe, signs it as
// the transfer authority only (the fee payer's slot stays empty for the facilitator) and wraps it as a payment payload.
import {
  type Address,
  type TransactionSigner,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';
import { getSetComputeUnitLimitInstruction, getSetComputeUnitPriceInstruction } from '@solana-program/compute-budget';
import { fetchMint, findAssociatedTokenPda, getTransferCheckedInstruction } from '@solana-program/token-2022';
import { DEFAULT_COMPUTE_UNIT_LIMIT, DEFAULT_COMPUTE_UNIT_PRICE_MICROLAMPORTS, MAX_COMPUTE_UNIT_LIMIT, MAX_MEMO_BYTES, MEMO_PROGRAM_ADDRESS, TOKEN_2022_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS, X402_VERSION } from './constants.js';
import type { SvmRpc } from './network.js';
import type { PaymentPayload, PaymentRequirements, ResourceInfo } from './types.js';

export type BuildPaymentOptions = {
  rpc: SvmRpc;
  /** The paying wallet. It signs as transfer authority and owns the source token account. */
  signer: TransactionSigner;
  requirements: PaymentRequirements;
  resource?: ResourceInfo;
  computeUnitLimit?: number;
  computeUnitPriceMicroLamports?: bigint;
};

/** Builds the payment payload for one requirement. Nothing is sent; the facilitator broadcasts after verifying it. */
export async function buildExactPayment(o: BuildPaymentOptions): Promise<PaymentPayload> {
  const { rpc, signer, requirements: r } = o;
  const mint = await fetchMint(rpc as never, r.asset as Address);
  const tokenProgram = mint.programAddress;
  if (tokenProgram !== TOKEN_PROGRAM_ADDRESS && tokenProgram !== TOKEN_2022_PROGRAM_ADDRESS) throw new Error('the asset is not owned by the SPL Token or Token-2022 program');
  const [source] = await findAssociatedTokenPda({ mint: r.asset as Address, owner: signer.address, tokenProgram });
  const [destination] = await findAssociatedTokenPda({ mint: r.asset as Address, owner: r.payTo as Address, tokenProgram });

  const transfer = getTransferCheckedInstruction({ source, mint: r.asset as Address, destination, authority: signer, amount: BigInt(r.amount), decimals: mint.data.decimals }, { programAddress: tokenProgram });
  // The server's memo ties this payment to one challenge. Without one, a random nonce keeps identical payments distinct.
  const memoText = r.extra.memo ?? Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('hex');
  const memoData = new TextEncoder().encode(memoText);
  if (memoData.byteLength > MAX_MEMO_BYTES) throw new Error(`the memo is larger than ${MAX_MEMO_BYTES} bytes`);
  const memo = { programAddress: MEMO_PROGRAM_ADDRESS, accounts: [] as const, data: memoData };

  // Memo v3 costs about 350 compute units per byte on top of a fixed cost (measured in test/payments.test.ts), so the limit follows the memo.
  const computeUnitLimit = o.computeUnitLimit ?? Math.min(MAX_COMPUTE_UNIT_LIMIT, DEFAULT_COMPUTE_UNIT_LIMIT + 400 * memoData.byteLength);
  const { value: latest } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(r.extra.feePayer as Address, m),
    (m) =>
      appendTransactionMessageInstructions(
        [
          getSetComputeUnitLimitInstruction({ units: computeUnitLimit }),
          getSetComputeUnitPriceInstruction({ microLamports: o.computeUnitPriceMicroLamports ?? DEFAULT_COMPUTE_UNIT_PRICE_MICROLAMPORTS }),
          transfer,
          memo,
        ],
        m,
      ),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latest, m),
  );
  const signed = await partiallySignTransactionMessageWithSigners(message);
  return {
    x402Version: X402_VERSION,
    ...(o.resource ? { resource: o.resource } : {}),
    accepted: r,
    payload: { transaction: getBase64EncodedWireTransaction(signed) },
  };
}
