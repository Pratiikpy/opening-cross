// Pure address and chain helpers for the wallet layer (no React Native imports, so they run under plain Node in tests).
import { base64ToBytes } from './base64';

/** The chain identifier the wallet is asked to use (spec: solana:mainnet, solana:testnet, solana:devnet). */
export const chainFor = (network: 'devnet' | 'mainnet-beta' | 'testnet'): 'solana:mainnet' | 'solana:testnet' | 'solana:devnet' =>
  network === 'mainnet-beta' ? 'solana:mainnet' : network === 'testnet' ? 'solana:testnet' : 'solana:devnet';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58Encode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i]!;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j]! << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  return '1'.repeat(zeros) + digits.reverse().map((d) => B58[d]).join('');
}

/** The shape of an account the wallet returns: a base64 address (MWA) or a wallet-standard account with a public key. */
export type WalletAccountLike = { address: string; publicKey?: Uint8Array };

/** The account's address as base58. MWA returns it base64-encoded; a wallet-standard account carries a public key. */
export function accountAddress(a: WalletAccountLike): string {
  if (a.publicKey && a.publicKey.length === 32) return base58Encode(a.publicKey);
  const bytes = base64ToBytes(a.address);
  if (bytes.length !== 32) throw new Error('The wallet returned an account address that is not 32 bytes.');
  return base58Encode(bytes);
}
