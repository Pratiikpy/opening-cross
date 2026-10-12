// Builds exact-scheme payment transactions, correct ones and deliberately broken ones, without a chain, so every rule of
// verify.ts can be exercised on its own. A static blockhash is fine here: nothing is sent.
import {
  AccountRole,
  type Address,
  type Instruction,
  type KeyPairSigner,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  partiallySignTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';
import { getSetComputeUnitLimitInstruction, getSetComputeUnitPriceInstruction } from '@solana-program/compute-budget';
import { findAssociatedTokenPda, getTransferCheckedInstruction } from '@solana-program/token-2022';
import { LIGHTHOUSE_PROGRAM_ADDRESS, MEMO_PROGRAM_ADDRESS, TOKEN_2022_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS } from '../src/constants.js';
import { inspectTransaction } from '../src/inspect.js';
import type { PaymentRequirements } from '../src/types.js';

export const BLOCKHASH = { blockhash: '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi' as never, lastValidBlockHeight: 1_000_000n };

export type Parties = { payer: KeyPairSigner; feePayer: KeyPairSigner; mint: KeyPairSigner; recipient: KeyPairSigner };

export async function parties(): Promise<Parties> {
  const [payer, feePayer, mint, recipient] = await Promise.all([generateKeyPairSigner(), generateKeyPairSigner(), generateKeyPairSigner(), generateKeyPairSigner()]);
  return { payer, feePayer, mint, recipient };
}

export const requirementsFor = (p: Parties, over: Partial<PaymentRequirements> = {}, memo: string | undefined = 'oc402.v1.test'): PaymentRequirements => ({
  scheme: 'exact',
  network: 'solana:test',
  amount: '10000',
  asset: p.mint.address,
  payTo: p.recipient.address,
  maxTimeoutSeconds: 60,
  extra: { feePayer: p.feePayer.address, ...(memo === undefined ? {} : { memo }) },
  ...over,
});

export type Variant = {
  tokenProgram?: Address;
  amount?: bigint;
  /** Mint the transfer names, if not the required one. */
  mint?: Address;
  /** Destination owner, if not the required recipient. */
  destinationOwner?: Address;
  limit?: number;
  price?: bigint;
  memo?: string | null;
  /** Instructions appended after the memo. */
  extra?: Instruction[];
  /** Replaces the first three instructions entirely. */
  head?: Instruction[];
  feePayer?: Address;
  /** Authority of the transfer, if not the payer. */
  authority?: KeyPairSigner;
  skipPayerSignature?: boolean;
  /** A real blockhash, for transactions that are sent to a validator. */
  lifetime?: { blockhash: never; lastValidBlockHeight: bigint };
  decimals?: number;
  /** The official MPP client's order: price, then limit. */
  swapBudget?: boolean;
  /** The payer's source token account, if not the associated one. */
};

export async function paymentTransaction(p: Parties, req: PaymentRequirements, v: Variant = {}): Promise<{ base64: string; message: ReturnType<typeof inspectTransaction> }> {
  const tokenProgram = v.tokenProgram ?? TOKEN_PROGRAM_ADDRESS;
  const mint = v.mint ?? (req.asset as Address);
  const [source] = await findAssociatedTokenPda({ mint, owner: p.payer.address, tokenProgram });
  const [destination] = await findAssociatedTokenPda({ mint: req.asset as Address, owner: (v.destinationOwner ?? req.payTo) as Address, tokenProgram });
  const authority = v.authority ?? p.payer;
  const transfer = getTransferCheckedInstruction({ source, mint, destination, authority, amount: v.amount ?? BigInt(req.amount), decimals: v.decimals ?? 6 }, { programAddress: tokenProgram });
  const memoText = v.memo === undefined ? req.extra.memo : v.memo;
  const memo = memoText === null || memoText === undefined ? [] : [{ programAddress: MEMO_PROGRAM_ADDRESS, accounts: [], data: new TextEncoder().encode(memoText) } as Instruction];
  const limitIx = getSetComputeUnitLimitInstruction({ units: v.limit ?? 20_000 });
  const priceIx = getSetComputeUnitPriceInstruction({ microLamports: v.price ?? 1n });
  const head = v.head ?? (v.swapBudget ? [priceIx, limitIx, transfer] : [limitIx, priceIx, transfer]);
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer((v.feePayer ?? req.extra.feePayer) as Address, m),
    (m) => appendTransactionMessageInstructions([...head, ...memo, ...(v.extra ?? [])], m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(v.lifetime ?? BLOCKHASH, m),
  );
  let tx = compileTransaction(message);
  if (!v.skipPayerSignature) tx = await partiallySignTransaction([authority.keyPair], tx);
  const base64 = getBase64EncodedWireTransaction(tx);
  return { base64, message: inspectTransaction(base64) };
}

export const lighthouseInstruction = (account: Address): Instruction => ({ programAddress: LIGHTHOUSE_PROGRAM_ADDRESS as Address, accounts: [{ address: account, role: AccountRole.READONLY }], data: new Uint8Array([1, 2, 3]) });
export { TOKEN_2022_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS };
