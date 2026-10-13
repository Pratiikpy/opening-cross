'use client';

import { registerWallet } from '@wallet-standard/core';
import { useEffect, useState } from 'react';
import { PASSKEY_WALLET_NAME, hasPasskeyMarker, passkeySupport, setPasskeyMode, signMessageBytes, signWire, unlock } from '@/lib/holder-passkey';
import { CHAIN } from '@/lib/wallet';

const ICON = `data:image/svg+xml;base64,${typeof btoa === 'function' ? btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="5" fill="#0b0b0f"/><circle cx="10" cy="10" r="4" fill="none" stroke="#fff" stroke-width="2"/><path d="M13 13l7 7m-3-3l2-2" stroke="#fff" stroke-width="2" fill="none"/></svg>') : ''}` as `data:image/svg+xml;base64,${string}`;

type Account = { address: string; publicKey: Uint8Array; chains: readonly `${string}:${string}`[]; features: readonly string[]; label?: string };
type Listener = (p: { accounts?: readonly Account[] }) => void;

let registered = false;

/** Registers the passkey wallet with the Wallet Standard, once per page, so it appears in the wallet list beside the installed wallets. */
function register() {
  if (registered || typeof window === 'undefined') return;
  if (!passkeySupport({ credentials: navigator.credentials, secure: window.isSecureContext, PublicKeyCredential: window.PublicKeyCredential }).ok) return;
  registered = true;
  let accounts: Account[] = [];
  const listeners = new Set<Listener>();
  const emit = () => listeners.forEach((l) => l({ accounts }));
  const accountOf = (address: string, publicKey: Uint8Array): Account => Object.freeze({ address, publicKey, chains: [CHAIN], features: ['solana:signTransaction', 'solana:signMessage'], label: PASSKEY_WALLET_NAME });

  const wallet = {
    version: '1.0.0' as const,
    name: PASSKEY_WALLET_NAME,
    icon: ICON,
    chains: [CHAIN] as const,
    get accounts() {
      return accounts;
    },
    features: {
      'standard:connect': {
        version: '1.0.0' as const,
        connect: async (input?: { silent?: boolean }) => {
          // A passkey is never used without the person present: a silent reconnect after a reload returns nothing.
          if (input?.silent) return { accounts: [] as Account[] };
          const k = await unlock();
          const pub = Uint8Array.from(new Uint8Array(await crypto.subtle.exportKey('raw', k.keyPair.publicKey)));
          accounts = [accountOf(k.address, pub)];
          emit();
          return { accounts };
        },
      },
      'standard:disconnect': {
        version: '1.0.0' as const,
        disconnect: async () => {
          accounts = [];
          emit();
        },
      },
      'standard:events': {
        version: '1.0.0' as const,
        on: (event: string, listener: Listener) => {
          if (event !== 'change') return () => undefined;
          listeners.add(listener);
          return () => void listeners.delete(listener);
        },
      },
      'solana:signTransaction': {
        version: '1.0.0' as const,
        supportedTransactionVersions: ['legacy', 0] as const,
        signTransaction: async (...inputs: { account: Account; transaction: Uint8Array }[]) => {
          // Every request asks the passkey again: the key exists only while this request is being signed.
          const k = await unlock();
          if (inputs.some((i) => i.account.address !== k.address)) throw new Error('That passkey belongs to a different wallet than the one connected.');
          const out = [];
          for (const i of inputs) out.push({ signedTransaction: await signWire(k.keyPair, i.transaction) });
          return out;
        },
      },
      'solana:signMessage': {
        version: '1.0.0' as const,
        signMessage: async (...inputs: { account: Account; message: Uint8Array }[]) => {
          const k = await unlock();
          if (inputs.some((i) => i.account.address !== k.address)) throw new Error('That passkey belongs to a different wallet than the one connected.');
          const out = [];
          for (const i of inputs) out.push({ signedMessage: i.message, signature: await signMessageBytes(k.keyPair, i.message) });
          return out;
        },
      },
    },
  };
  registerWallet(wallet as never);
}

/** Mounted once for the whole app (providers.tsx): puts the passkey wallet in the wallet list where the browser can make passkeys. */
export function PasskeyWalletRegistrar() {
  useEffect(register, []);
  return null;
}

/** The card on the portfolio page that says what the passkey wallet is and is not, and lets a person pick a new or an existing passkey. */
export function PasskeyCard() {
  const [supported, setSupported] = useState<boolean | null>(null);
  const [existing, setExisting] = useState(false);
  useEffect(() => {
    setSupported(passkeySupport({ credentials: navigator.credentials, secure: window.isSecureContext, PublicKeyCredential: window.PublicKeyCredential }).ok);
    setExisting(hasPasskeyMarker());
  }, []);
  if (supported === null) return null;
  return (
    <section aria-labelledby="passkey-h" className="rounded-[var(--radius-card)] border border-border p-5" data-testid="passkey-card">
      <h2 id="passkey-h" className="font-medium">
        Passkey wallet <span className="ml-1 rounded-full border border-border-strong px-2 py-0.5 font-mono text-[11px] uppercase tracking-wider text-muted">devnet preview</span>
      </h2>
      {supported ? (
        <>
          <p className="mt-2 text-sm text-muted">
            No extension and no seed phrase: a wallet that lives in a passkey. Choose <span className="font-medium text-ink">{PASSKEY_WALLET_NAME}</span> in Connect wallet, and your fingerprint, face or device PIN opens it. The key is made from the passkey each time you sign and is never stored.
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted">
            <li>The same passkey is the same wallet on every device it syncs to. If every copy of the passkey is deleted, the wallet cannot be recovered.</li>
            <li>It asks for your fingerprint, face or PIN on every signature, so a claim of several orders asks several times.</li>
            <li>Test network only. It has not been audited: do not put anything of value in it.</li>
          </ul>
          <fieldset className="mt-3">
            <legend className="text-sm font-medium">Next time I connect</legend>
            <div className="mt-1.5 flex flex-wrap gap-3">
              {([['auto', existing ? 'Use my passkey on this device' : 'Make a passkey'], ['existing', 'Use a passkey from another device']] as const).map(([v, label]) => (
                <label key={v} className="flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border border-border px-3 text-sm has-[:checked]:border-border-strong has-[:checked]:bg-surface">
                  <input type="radio" name="passkey-mode" defaultChecked={v === 'auto'} onChange={() => setPasskeyMode(v)} className="size-4 accent-[var(--accent-fill)]" />
                  {label}
                </label>
              ))}
            </div>
          </fieldset>
        </>
      ) : (
        <p className="mt-2 text-sm text-muted">This browser cannot make passkeys on this page (it needs a secure page and a browser that supports them), so the passkey wallet is not offered here.</p>
      )}
      <p className="mt-3 text-xs text-muted">Sign-in with an email or a social account needs an account with a wallet provider and is not switched on.</p>
    </section>
  );
}
