'use client';

import { PasskeyWalletRegistrar } from '@/components/portfolio/passkey-wallet';
import { WalletProvider } from '@/lib/wallet';

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <WalletProvider>
      <PasskeyWalletRegistrar />
      {children}
    </WalletProvider>
  );
}
