'use client';

import { useSignTransaction } from '@solana/react';
import type { UiWalletAccount } from '@wallet-standard/ui';
import { CHAIN } from '@/lib/wallet';
import type { Signer } from '@/lib/tx';

/** The connected account's transaction signer, in the shape `signSendConfirm` takes. */
export function useSigner(account: UiWalletAccount): Signer {
  const sign = useSignTransaction(account, CHAIN);
  return async ({ transaction }) => {
    const out = await sign({ transaction });
    return { signedTransaction: new Uint8Array(out.signedTransaction) };
  };
}
