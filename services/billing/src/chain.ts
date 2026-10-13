// The chain side of a subscription: the unsigned payment an issuer signs, and reading a payment back from a transaction. A payment is
// whatever moved BILLING_MINT into the revenue wallet's token account, read from the transaction's own token balances; the memo says
// which plan it is for and the signer of the transfer says who paid. Nothing is taken on trust from the request that reports it.
import {
  type Address,
  type Instruction,
  address,
  appendTransactionMessageInstructions,
  createNoopSigner,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';
import { getAddMemoInstruction } from '@solana-program/memo';
import { findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstruction, getTransferCheckedInstruction } from '@solana-program/token-2022';

export const MEMO_PREFIX = 'oc-sub:1:';

export interface BillingChain {
  /** The program that owns the mint (Token or Token-2022) and its decimals. */
  mint(mint: string): Promise<{ tokenProgram: string; decimals: number } | null>;
  latestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: bigint }>;
  /** A transaction as `getTransaction` returns it with `jsonParsed`, or null if the cluster does not have it. */
  transaction(signature: string): Promise<ParsedTransaction | null>;
}

export interface ParsedTransaction {
  slot: number;
  blockTime: number | null;
  meta: {
    err: unknown;
    preTokenBalances?: TokenBalance[];
    postTokenBalances?: TokenBalance[];
    innerInstructions?: { instructions: ParsedInstruction[] }[];
  } | null;
  transaction: { message: { accountKeys: (string | { pubkey: string })[]; instructions: ParsedInstruction[] } };
}
export interface TokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string };
}
export interface ParsedInstruction {
  program?: string;
  programId?: string;
  parsed?: string | { type?: string; info?: Record<string, unknown> };
}

export interface SubscriptionTarget {
  plan: string;
  priceUnits: bigint;
  issuer: string;
  mint: string;
  revenueWallet: string;
}

/** The unsigned payment: create the revenue wallet's token account if it is not there yet, transfer the plan price, record the plan in a memo. The issuer pays the fee. */
export async function buildSubscriptionTx(chain: BillingChain, t: SubscriptionTarget): Promise<{ transaction: string; lastValidBlockHeight: bigint; memo: string; from: string; to: string }> {
  const m = await chain.mint(t.mint);
  if (!m) throw new BillingError('the billing mint does not exist on this cluster');
  const tokenProgram = address(m.tokenProgram);
  const issuer = address(t.issuer);
  const [from] = await findAssociatedTokenPda({ owner: issuer, mint: address(t.mint), tokenProgram });
  const [to] = await findAssociatedTokenPda({ owner: address(t.revenueWallet), mint: address(t.mint), tokenProgram });
  const payer = createNoopSigner(issuer);
  const memo = `${MEMO_PREFIX}${t.plan}`;
  const ixs: Instruction[] = [
    getCreateAssociatedTokenIdempotentInstruction({ payer, ata: to, owner: address(t.revenueWallet), mint: address(t.mint), tokenProgram }),
    getTransferCheckedInstruction({ source: from, mint: address(t.mint), destination: to, authority: payer, amount: t.priceUnits, decimals: m.decimals }, { programAddress: tokenProgram }),
    getAddMemoInstruction({ memo }),
  ];
  const lifetime = await chain.latestBlockhash();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (x) => setTransactionMessageFeePayerSigner(payer, x),
    (x) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: lifetime.blockhash as never, lastValidBlockHeight: lifetime.lastValidBlockHeight }, x),
    (x) => appendTransactionMessageInstructions(ixs, x),
  );
  const tx = await partiallySignTransactionMessageWithSigners(message);
  return { transaction: getBase64EncodedWireTransaction(tx), lastValidBlockHeight: lifetime.lastValidBlockHeight, memo, from, to };
}

export class BillingError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 422 | 503 = 400) {
    super(message);
  }
}

export interface PaymentFacts {
  signature: string;
  issuer: string;
  plan: string;
  amountUnits: bigint;
  paidAt: number;
  slot: number;
}

function flatInstructions(tx: ParsedTransaction): ParsedInstruction[] {
  return [...tx.transaction.message.instructions, ...(tx.meta?.innerInstructions ?? []).flatMap((i) => i.instructions)];
}

/** Reads a payment out of a transaction, or explains why it is not one. The amount is the revenue token account's own balance change. */
export async function readPayment(tx: ParsedTransaction | null, signature: string, c: { mint: string; revenueWallet: string }): Promise<PaymentFacts> {
  if (!tx) throw new BillingError('the cluster has no such transaction (yet); if it was just sent, wait a few seconds and report it again', 404);
  if (!tx.meta) throw new BillingError('the transaction has no metadata', 422);
  if (tx.meta.err) throw new BillingError('that transaction failed on chain, so it paid nothing', 422);
  if (tx.blockTime === null) throw new BillingError('the transaction has no block time', 422);
  const pre = tx.meta.preTokenBalances ?? [];
  const post = tx.meta.postTokenBalances ?? [];
  const key = (b: TokenBalance) => b.accountIndex;
  const received = post.find((b) => b.mint === c.mint && b.owner === c.revenueWallet);
  if (!received) throw new BillingError(`the transaction did not move ${c.mint} to the revenue wallet`, 422);
  const before = pre.find((b) => key(b) === key(received))?.uiTokenAmount.amount ?? '0';
  const amount = BigInt(received.uiTokenAmount.amount) - BigInt(before);
  if (amount <= 0n) throw new BillingError('the revenue wallet received nothing in that transaction', 422);

  const ixs = flatInstructions(tx);
  const memoIx = ixs.find((i) => i.program === 'spl-memo' && typeof i.parsed === 'string' && (i.parsed as string).startsWith(MEMO_PREFIX));
  if (!memoIx) throw new BillingError(`the transaction carries no "${MEMO_PREFIX}<plan>" memo, so it is not a subscription payment`, 422);
  const plan = (memoIx.parsed as string).slice(MEMO_PREFIX.length);
  // The payer is the authority of the transfer into the revenue token account, found by that account's address.
  const dest = tx.transaction.message.accountKeys[received.accountIndex];
  const destAddress = typeof dest === 'string' ? dest : dest?.pubkey;
  const transfer = ixs.find((i) => {
    const p = i.parsed;
    return i.program === 'spl-token' && typeof p === 'object' && (p.type === 'transferChecked' || p.type === 'transfer') && p.info?.destination === destAddress;
  });
  const info = typeof transfer?.parsed === 'object' ? transfer.parsed.info : undefined;
  const issuer = (info?.authority ?? info?.multisigAuthority) as string | undefined;
  if (!issuer) throw new BillingError('the payer could not be read from the transfer', 422);
  return { signature, issuer, plan, amountUnits: amount, paidAt: tx.blockTime, slot: tx.slot };
}

export type { Address };
