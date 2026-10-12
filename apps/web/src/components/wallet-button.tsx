'use client';

import type { UiWallet } from '@wallet-standard/ui';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { CHAIN, useConnect, useDisconnect, useWallet } from '@/lib/wallet';
import { shortAddress } from '@/lib/units';
import { useDismissableDetails } from './nav';

export function WalletButton() {
  const { wallet, account, wallets, clear } = useWallet();
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  if (wallet && account) return <AccountMenu wallet={wallet} address={account.address} onDisconnected={clear} />;
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="rounded-full bg-ink px-4 py-2 text-sm font-medium text-bg transition-opacity hover:opacity-90">
        Connect wallet
      </button>
      <dialog
        ref={dialog}
        onClose={() => setOpen(false)}
        onClick={(e) => {
          // A click on the backdrop lands on the dialog element itself, not on its content.
          if (e.target === e.currentTarget) setOpen(false);
        }}
        aria-labelledby="wallet-title"
        className="m-auto w-[min(92vw,420px)] rounded-[var(--radius-card)] border border-border bg-bg p-0 text-ink backdrop:bg-black/50"
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <h2 id="wallet-title" className="font-medium">
            Connect a wallet
          </h2>
          <button type="button" onClick={() => setOpen(false)} aria-label="Close" className="grid size-8 place-items-center rounded-full text-muted hover:bg-surface hover:text-ink">
            ×
          </button>
        </div>
        <div className="p-5">
          {wallets.length === 0 ? (
            <div className="space-y-3 text-sm text-muted">
              <p>No Solana wallet that supports {CHAIN.replace('solana:', '')} was found in this browser.</p>
              <p>
                Install{' '}
                <a className="text-accent-text underline" href="https://phantom.com/download">
                  Phantom
                </a>
                ,{' '}
                <a className="text-accent-text underline" href="https://backpack.app/download">
                  Backpack
                </a>{' '}
                or{' '}
                <a className="text-accent-text underline" href="https://solflare.com/download">
                  Solflare
                </a>
                , then reload this page.
              </p>
            </div>
          ) : (
            <ul className="space-y-2">
              {wallets.map((w) => (
                <li key={w.name}>
                  <WalletOption wallet={w} onConnected={() => setOpen(false)} />
                </li>
              ))}
            </ul>
          )}
          <p className="mt-5 text-xs text-muted">Opening Bell never sees your keys. Your wallet shows every transaction before you approve it.</p>
        </div>
      </dialog>
    </>
  );
}

function AccountMenu({ wallet, address, onDisconnected }: { wallet: UiWallet; address: string; onDisconnected: () => void }) {
  const pathname = usePathname();
  const menu = useDismissableDetails([pathname]);
  return (
    <details ref={menu} className="relative">
      <summary
        className="flex cursor-pointer list-none items-center gap-2 rounded-full border border-border px-3 py-2 font-mono text-xs hover:border-border-strong [&::-webkit-details-marker]:hidden"
        title={address}
        aria-label={`Connected as ${address}`}
      >
        <span className="size-1.5 rounded-full bg-positive" aria-hidden="true" />
        {shortAddress(address)}
      </summary>
      <div className="absolute right-0 z-50 mt-2 w-56 rounded-[var(--radius-card)] border border-border bg-bg p-3 shadow-lg">
        <p className="text-xs text-muted">Connected with {wallet.name}</p>
        <p className="mt-1 break-all font-mono text-xs">{address}</p>
        <Link href="/orders" prefetch={false} className="mt-3 block rounded-full border border-border px-3 py-2 text-center text-sm hover:border-border-strong">
          My orders
        </Link>
        <div className="mt-2">
          <Disconnect wallet={wallet} onDone={onDisconnected} />
        </div>
      </div>
    </details>
  );
}

function WalletOption({ wallet, onConnected }: { wallet: UiWallet; onConnected: () => void }) {
  const { select } = useWallet();
  const [connecting, connect] = useConnect(wallet);
  const [error, setError] = useState<string | null>(null);
  return (
    <div>
      <button
        type="button"
        disabled={connecting}
        onClick={async () => {
          setError(null);
          try {
            const accounts = await connect();
            const first = accounts.find((a) => a.chains.includes(CHAIN)) ?? accounts[0];
            if (!first) throw new Error('The wallet returned no account.');
            select(wallet, first);
            onConnected();
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
          }
        }}
        className="flex w-full items-center gap-3 rounded-lg border border-border px-4 py-3 text-left text-sm transition-colors hover:border-border-strong disabled:opacity-60"
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- wallet icons are data URIs supplied by the wallet */}
        <img src={wallet.icon} alt="" width={24} height={24} className="rounded" />
        <span className="font-medium">{wallet.name}</span>
        <span className="ml-auto text-xs text-muted">{connecting ? 'Connecting…' : ''}</span>
      </button>
      {error ? (
        <p role="alert" className="mt-1 text-xs text-accent-text">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function Disconnect({ wallet, onDone }: { wallet: UiWallet; onDone: () => void }) {
  const [busy, disconnect] = useDisconnect(wallet);
  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        try {
          await disconnect();
        } finally {
          onDone();
        }
      }}
      className="w-full rounded-full border border-border px-3 py-2 text-sm text-muted hover:border-border-strong hover:text-ink"
    >
      Disconnect
    </button>
  );
}
