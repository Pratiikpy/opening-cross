// Signers for the wallet-agnostic part of the kit. A `Signer` signs one transaction's wire bytes; `many` may sign a whole
// multi-transaction action in one wallet prompt. The Wallet Standard adapter turns any Solana wallet that implements the
// `solana:signTransaction` feature into one, without this package depending on a wallet library.
import { ActionError, type Signer } from '@opening-cross/client';

export type { Signer };

/**
 * The part of a Wallet Standard `solana:signTransaction` feature the adapter uses. Pass `wallet.features['solana:signTransaction']`
 * and one of the wallet's accounts. The wallet's `signTransaction(...inputs)` takes one input per transaction and returns one
 * output per input.
 */
export type SolanaSignTransactionFeature = {
  signTransaction(...inputs: { transaction: Uint8Array; account: unknown; chain?: string; options?: unknown }[]): Promise<readonly { signedTransaction: Uint8Array }[]>;
};

export type WalletStandardAccount = { address: string; chains?: readonly string[] };

/**
 * Adapts a Wallet Standard wallet. `chain` is the Wallet Standard chain id of the cluster (`solana:devnet`, `solana:mainnet`,
 * `solana:localnet`...) and must be one the account supports.
 */
export function walletStandardSigner(feature: SolanaSignTransactionFeature, account: WalletStandardAccount, chain: string): Signer {
  if (account.chains && !account.chains.includes(chain)) throw new ActionError(`This wallet account does not support ${chain}.`, 'WALLET_ERROR');
  const signed = async (transactions: Uint8Array[]): Promise<Uint8Array[]> => {
    const out = await feature.signTransaction(...transactions.map((transaction) => ({ transaction, account, chain })));
    if (out.length !== transactions.length) throw new Error(`the wallet returned ${out.length} signed transactions for ${transactions.length}`);
    return out.map((o) => Uint8Array.from(o.signedTransaction));
  };
  const sign: Signer = async ({ transaction }) => ({ signedTransaction: (await signed([transaction]))[0]! });
  sign.many = signed;
  return sign;
}
