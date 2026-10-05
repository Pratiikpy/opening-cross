'use client';

// Wallet connection over the Wallet Standard: every installed Solana wallet (Phantom, Backpack,
// Solflare, …) registers itself and appears here without wallet-specific code. The app never
// holds a key. The chosen wallet and account are remembered in this browser only.
import { useConnect, useDisconnect, useWallets } from '@wallet-standard/react';
import type { StandardConnectFeature } from '@wallet-standard/features';
import type { UiWallet, UiWalletAccount } from '@wallet-standard/ui';
import { getWalletFeature } from '@wallet-standard/ui-features';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

export const CHAIN = (process.env.NEXT_PUBLIC_CHAIN ?? 'solana:devnet') as `solana:${string}`;
const STORAGE_KEY = 'opening-bell:wallet';

type WalletState = {
  wallets: readonly UiWallet[];
  wallet: UiWallet | null;
  account: UiWalletAccount | null;
  select: (wallet: UiWallet, account: UiWalletAccount) => void;
  clear: () => void;
};

const Ctx = createContext<WalletState | null>(null);

/** Wallets that can sign Solana transactions on the chain this deployment uses. */
function usable(w: UiWallet): boolean {
  return w.chains.includes(CHAIN) && w.features.includes('solana:signTransaction') && w.features.includes('standard:connect');
}

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const all = useWallets();
  const wallets = useMemo(() => all.filter(usable), [all]);
  const [choice, setChoice] = useState<{ wallet: string; account: string } | null>(null);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) setChoice(JSON.parse(saved) as { wallet: string; account: string });
    } catch {
      // No storage (private mode): the user simply reconnects.
    }
  }, []);

  const wallet = choice ? (wallets.find((w) => w.name === choice.wallet) ?? null) : null;

  // Restore the session after a reload: ask the saved wallet to reconnect without a prompt. Wallets
  // only grant this to sites the user approved before; otherwise it quietly returns no account.
  const restored = useRef<string | null>(null);
  useEffect(() => {
    if (!wallet || wallet.accounts.length > 0 || restored.current === wallet.name) return;
    restored.current = wallet.name;
    const feature = getWalletFeature(wallet, 'standard:connect') as StandardConnectFeature['standard:connect'];
    feature.connect({ silent: true }).catch(() => undefined);
  }, [wallet]);
  const account = wallet ? (wallet.accounts.find((a) => a.address === choice?.account) ?? null) : null;

  const select = useCallback((w: UiWallet, a: UiWalletAccount) => {
    const next = { wallet: w.name, account: a.address };
    setChoice(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Not persisted; still selected for this page.
    }
  }, []);
  const clear = useCallback(() => {
    setChoice(null);
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Nothing persisted.
    }
  }, []);

  const value = useMemo(() => ({ wallets, wallet, account, select, clear }), [wallets, wallet, account, select, clear]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWallet(): WalletState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useWallet must be used inside WalletProvider');
  return v;
}

export { useConnect, useDisconnect };
