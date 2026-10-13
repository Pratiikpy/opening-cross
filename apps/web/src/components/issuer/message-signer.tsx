'use client';

import { useSignMessage } from '@solana/react';
import type { UiWalletAccount } from '@wallet-standard/ui';
import { type MessageSigner, hex } from '@/lib/issuer-board';

/** Whether the connected wallet can sign a plain message. Signing a record needs it; sending a transaction does not. */
export const canSignMessage = (account: UiWalletAccount): boolean => account.features.includes('solana:signMessage');

function Inner({ account, children }: { account: UiWalletAccount; children: (sign: MessageSigner) => React.ReactNode }) {
  const signMessage = useSignMessage(account);
  const sign: MessageSigner = async (message) => {
    const { signature } = await signMessage({ message: new TextEncoder().encode(message) });
    return hex(new Uint8Array(signature));
  };
  return <>{children(sign)}</>;
}

/**
 * Gives its children a function that signs a message with the connected wallet. A wallet that cannot sign messages gets a plain
 * explanation instead, because the hook underneath would throw for it.
 */
export function WithMessageSigner({ account, children }: { account: UiWalletAccount; children: (sign: MessageSigner) => React.ReactNode }) {
  if (!canSignMessage(account))
    return (
      <p role="alert" className="text-sm text-accent-text">
        This wallet cannot sign messages, which publishing a signed record needs. Use a wallet that supports signing messages (Phantom, Backpack and Solflare do).
      </p>
    );
  return <Inner account={account}>{children}</Inner>;
}
