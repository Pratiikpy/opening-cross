// Mobile Wallet Adapter, as the specification and @solana-mobile/mobile-wallet-adapter-protocol 3.x define it:
//   transact(async (wallet) => { await wallet.authorize({ identity, chain, auth_token? });
//                                 const { signed_payloads } = await wallet.signTransactions({ payloads }); })
// A session is stateful (spec 0.3): authorize puts it in the authorized state, and signTransactions then needs no token.
// Passing a stored auth_token to authorize reauthorizes silently; a rejected token must be discarded.
// Payloads are base64 transactions, which is exactly what the API's /v1/tx/* routes return.
import { Platform } from 'react-native';
import { type WalletAccountLike, accountAddress, chainFor } from './address';
import { NETWORK } from './config';

export const APP_IDENTITY = { name: 'Opening Bell', uri: 'https://github.com/Pratiikpy/opening-cross' } as const;

export type Session = { address: string; authToken: string; label?: string };

export class WalletUnavailableError extends Error {}

/** One wallet session: authorize (silently, if a token is held), then run `use` with the sign function. */
export async function withWallet<T>(stored: string | null, use: (wallet: { sign: (payloads: string[]) => Promise<string[]> }, session: Session) => Promise<T>): Promise<{ result: T; session: Session }> {
  if (Platform.OS !== 'android') throw new WalletUnavailableError('Mobile Wallet Adapter works on Android only. Use a connected Android device or emulator with a wallet installed.');
  const { transact } = await import('@solana-mobile/mobile-wallet-adapter-protocol');
  let session: Session | null = null;
  const result = await transact(async (wallet) => {
    const auth = await wallet.authorize({ identity: APP_IDENTITY, chain: chainFor(NETWORK), ...(stored ? { auth_token: stored } : {}) });
    const first = auth.accounts[0];
    if (!first) throw new WalletUnavailableError('The wallet did not authorise any account.');
    session = { address: accountAddress(first as WalletAccountLike), authToken: auth.auth_token, ...(first.label ? { label: first.label } : {}) };
    return use({ sign: async (payloads) => (await wallet.signTransactions({ payloads })).signed_payloads }, session);
  });
  return { result, session: session as unknown as Session };
}

/** Releases the authorization at the wallet when the user disconnects. Best effort: the token is discarded either way. */
export async function deauthorize(authToken: string): Promise<void> {
  if (Platform.OS !== 'android') return;
  const { transact } = await import('@solana-mobile/mobile-wallet-adapter-protocol');
  await transact(async (wallet) => {
    await wallet.deauthorize({ auth_token: authToken });
  });
}
