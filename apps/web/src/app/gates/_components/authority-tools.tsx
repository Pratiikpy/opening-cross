'use client';

import type { UiWalletAccount } from '@wallet-standard/ui';
import { useEffect, useState } from 'react';
import { isAddress } from '@solana/kit';
import { TOKEN_2022 } from '@/lib/issuer-readiness';
import { useMint } from '@/lib/use-read';
import { parseAtoms } from '../../../lib/units';
import type { GateState } from '../_lib/chain';
import { utcDate } from '../_lib/form';
import {
  FLAG,
  Mode,
  allowWallet,
  blockWallet,
  countryNumeric,
  findConfigPda,
  findDeniedAddress,
  findPassAddress,
  findTermsAddress,
  getCreateConfigInstruction,
  getTermsDecoder,
  grantPassTerms,
  revokePassTerms,
} from '../_lib/gate-client';
import { readAccounts } from '../_lib/rpc';
import { walletSigner } from '../_lib/unsigned';
import { Notice } from './notice';
import { Field, RunButton } from './run-button';

const selectCls = 'mt-1 w-full rounded-[var(--radius-card)] border border-border-strong bg-bg px-3 py-2 text-sm';

/** What the chain says about one wallet under this gate: a pass, the terms it carries, a denial. */
type WalletFacts = { wallet: string; pass: boolean; denied: boolean; terms: { identity: Uint8Array; country: number; tier: number; flags: number } | null };

/** Block, unblock or close the pass of one wallet. A block is immediate: it denies the wallet and closes any pass in one transaction. */
export function WalletControls({ gate, account, onChanged }: { gate: GateState; account: UiWalletAccount; onChanged: () => void }) {
  const [wallet, setWallet] = useState('');
  const [read, setFacts] = useState<WalletFacts | null>(null);
  const [tick, setTick] = useState(0);
  const w = wallet.trim();
  const valid = isAddress(w);
  // Facts read for another wallet are not shown, but a re-read of the same wallet keeps the buttons (and their "Done" message) on screen.
  const facts = read !== null && read.wallet === w ? read : null;
  useEffect(() => {
    if (!valid) return;
    let live = true;
    void (async () => {
      const mint = gate.mint as never;
      const owner = w as never;
      const [pass] = await findPassAddress(mint, owner);
      const [terms] = await findTermsAddress(mint, owner);
      const [denied] = await findDeniedAddress(mint, owner);
      const [p, t, d] = await readAccounts([pass, terms, denied]);
      if (!live) return;
      const decoded = t ? getTermsDecoder().decode(t.data) : null;
      setFacts({ wallet: w, pass: p !== null, denied: d !== null, terms: decoded ? { identity: Uint8Array.from(decoded.identity), country: decoded.country, tier: decoded.tier, flags: decoded.flags } : null });
    })().catch(() => undefined);
    return () => {
      live = false;
    };
  }, [gate.mint, w, valid, tick]);
  const done = () => {
    setTick((t) => t + 1);
    onChanged();
  };
  const authority = walletSigner(account.address);
  const mint = gate.mint as never;
  return (
    <section aria-labelledby="wallet-controls" className="rounded-[var(--radius-card)] border border-border p-5 text-sm" data-testid="wallet-controls">
      <h2 id="wallet-controls" className="font-mono text-xs uppercase tracking-widest text-muted">
        Issuer: one wallet
      </h2>
      <p className="mt-2 text-muted">For a sanctions hit, a court order or a mistake. Blocking denies the wallet and closes its pass in one transaction; anyone else can close a denied wallet&apos;s pass too, but you do not have to wait for them.</p>
      <div className="mt-3">
        <Field id="control-wallet" label="Wallet address" value={wallet} onChange={setWallet} mono />
      </div>
      {w !== '' && !valid ? <p className="mt-2 text-xs text-accent-text">That is not a Solana address.</p> : null}
      {facts ? (
        <p className="mt-3 text-muted" data-testid="wallet-facts">
          {facts.pass ? 'Holds a pass' : 'Holds no pass'}
          {facts.terms ? `, country ${facts.terms.country || 'unknown'}, tier ${facts.terms.tier}` : ''}
          {facts.denied ? '. Currently blocked.' : '.'}
        </p>
      ) : null}
      {valid && facts ? (
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <RunButton
            account={account}
            label={facts.denied ? 'Already blocked' : facts.pass ? 'Block and close pass' : 'Block'}
            testId="block-wallet"
            variant="secondary"
            disabled={facts.denied && !facts.pass}
            onDone={done}
            build={() => blockWallet({ authority, mint, owner: w as never, reason: 1, holdsPass: facts.pass, ...(facts.terms ? { identity: facts.terms.identity } : {}) })}
          />
          <RunButton account={account} label="Lift the block" testId="allow-wallet" variant="secondary" disabled={!facts.denied} onDone={done} build={async () => [await allowWallet({ authority, mint, owner: w as never })]} />
          <RunButton
            account={account}
            label="Close the pass only"
            testId="revoke-pass"
            variant="secondary"
            disabled={!facts.pass}
            onDone={done}
            build={async () => [await revokePassTerms({ authority, mint, owner: w as never, ...(facts.terms ? { identity: facts.terms.identity } : {}) })]}
          />
        </div>
      ) : null}
    </section>
  );
}

/** The authority issues a pass with terms directly: for the team, a partner, an investor onboarded off line. Insiders carry the insider flag. */
export function GrantPass({ gate, account, onChanged }: { gate: GateState; account: UiWalletAccount; onChanged: () => void }) {
  const [owner, setOwner] = useState('');
  const [country, setCountry] = useState('');
  const [tier, setTier] = useState('1');
  const [flags, setFlags] = useState({ kyc: true, sanctions: false, accredited: false, insider: false });
  const [identity, setIdentity] = useState('');
  const [cap, setCap] = useState('');
  const [quoteDecimals, setQuoteDecimals] = useState('6');
  const [expiry, setExpiry] = useState('');
  const problems: string[] = [];
  if (owner.trim() !== '' && !isAddress(owner.trim())) problems.push('The wallet is not a Solana address.');
  if (country.trim() !== '' && countryNumeric(country.trim().toUpperCase()) === undefined) problems.push('The country is not an ISO 3166-1 code.');
  if (identity.trim() !== '' && !/^[0-9a-fA-F]{64}$/.test(identity.trim())) problems.push('The identity id is 64 hexadecimal characters.');
  if (cap.trim() !== '' && parseAtoms(cap, /^\d{1,2}$/.test(quoteDecimals) ? Number(quoteDecimals) : 6) === null) problems.push('The limit is an amount with no more decimals than the quote token.');
  if (expiry.trim() !== '' && utcDate(expiry) === null) problems.push('The expiry is not a date (yyyy-mm-dd).');
  const ready = isAddress(owner.trim()) && problems.length === 0;
  if (!gate.rules) return null;
  return (
    <section aria-labelledby="grant" className="rounded-[var(--radius-card)] border border-border p-5 text-sm" data-testid="grant-pass">
      <h2 id="grant" className="font-mono text-xs uppercase tracking-widest text-muted">
        Issuer: grant a pass
      </h2>
      <p className="mt-2 text-muted">The same rules apply to a pass you grant: the program refuses terms the rules forbid, so a grant cannot quietly break them. Leave the identity id empty for a wallet with no verified person behind it.</p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Field id="grant-owner" label="Wallet" value={owner} onChange={setOwner} mono />
        <Field id="grant-country" label="Country (ISO code)" value={country} onChange={setCountry} placeholder="e.g. IN" />
        <div>
          <label className="block text-xs text-muted" htmlFor="grant-tier">
            Tier
          </label>
          <select id="grant-tier" value={tier} onChange={(e) => setTier(e.target.value)} className={selectCls} data-testid="grant-tier">
            <option value="0">Unspecified</option>
            <option value="1">Retail</option>
            <option value="2">Accredited</option>
            <option value="3">Qualified</option>
          </select>
        </div>
        <div className="space-y-1 pt-5">
          {([['kyc', 'Identity (KYC) verified'], ['sanctions', 'Sanctions screened'], ['accredited', 'Accredited investor'], ['insider', 'Insider (blackouts and volume limit apply)']] as const).map(([k, label]) => (
            <label key={k} className="flex items-center gap-2">
              <input type="checkbox" checked={flags[k]} onChange={(e) => setFlags({ ...flags, [k]: e.target.checked })} data-testid={`grant-${k}`} />
              {label}
            </label>
          ))}
        </div>
        <Field id="grant-identity" label="Identity id (optional, 64 hex characters)" value={identity} onChange={setIdentity} mono />
        <Field id="grant-cap" label="Limit per cross (whole quote tokens, optional)" value={cap} onChange={setCap} />
        <Field id="grant-quote-decimals" label="Quote token decimals" value={quoteDecimals} onChange={setQuoteDecimals} />
        <Field id="grant-expiry" label="Pass lapses on (UTC date, optional)" value={expiry} onChange={setExpiry} placeholder="yyyy-mm-dd" />
      </div>
      {problems.length ? (
        <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-accent-text" data-testid="grant-problems">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      ) : null}
      <div className="mt-4 max-w-xs">
        <RunButton
          account={account}
          label="Grant the pass"
          testId="grant-submit"
          disabled={!ready}
          onDone={onChanged}
          build={async () => {
            const code = country.trim() === '' ? 0 : countryNumeric(country.trim().toUpperCase())!;
            const bits = (flags.kyc ? FLAG.kyc : 0) | (flags.sanctions ? FLAG.sanctionsClear : 0) | (flags.accredited ? FLAG.accredited : 0) | (flags.insider ? FLAG.affiliate : 0);
            const id = identity.trim() === '' ? new Uint8Array(32) : Uint8Array.from(identity.trim().match(/../g)!.map((h) => parseInt(h, 16)));
            return [
              await grantPassTerms({
                authority: walletSigner(account.address),
                mint: gate.mint as never,
                owner: owner.trim() as never,
                terms: { identity: id, country: code, tier: Number(tier), flags: bits, cap: cap.trim() === '' ? 0n : parseAtoms(cap, Number(quoteDecimals))!, expiresTs: expiry.trim() === '' ? 0n : utcDate(expiry)! },
              }),
            ];
          }}
        />
      </div>
    </section>
  );
}

/** A token with no gate yet: the mint authority creates one. The gate authority becomes the wallet that signs. */
export function CreateGate({ mint, account, onChanged }: { mint: string; account: UiWalletAccount; onChanged: () => void }) {
  const { info, loading } = useMint(mint);
  const [mode, setMode] = useState<'allowlist' | 'open'>('allowlist');
  if (loading) return <p role="status" className="text-muted">Reading the token…</p>;
  if (!info) return <p className="text-muted">The token could not be read, so a gate cannot be created for it here.</p>;
  if (info.mintAuthority !== account.address) {
    return (
      <p className="text-muted" data-testid="not-mint-authority">
        Only the token&apos;s mint authority can create its gate{info.mintAuthority ? ` (${info.mintAuthority.slice(0, 4)}…${info.mintAuthority.slice(-4)})` : ', and this token has none left'}.
      </p>
    );
  }
  if (info.program !== TOKEN_2022) {
    return <Notice tone="warn" title="This token is not a Token-2022 token">A gate can only be created for a Token-2022 mint.</Notice>;
  }
  return (
    <div className="space-y-3" data-testid="create-gate">
      <p className="text-muted">You hold this token&apos;s mint authority. Creating the gate makes you its authority; you can switch compliance rules on afterwards.</p>
      <div>
        <label className="block text-xs text-muted" htmlFor="gate-mode">
          Who may receive the token
        </label>
        <select id="gate-mode" value={mode} onChange={(e) => setMode(e.target.value as 'allowlist' | 'open')} className={selectCls} data-testid="gate-mode-select">
          <option value="allowlist">Only wallets holding a pass</option>
          <option value="open">Anyone (passes then gate crosses only)</option>
        </select>
      </div>
      <div className="max-w-xs">
        <RunButton
          account={account}
          label="Create the gate"
          testId="create-gate-submit"
          onDone={onChanged}
          build={async () => {
            const signer = walletSigner(account.address);
            const [config] = await findConfigPda({ mint: mint as never });
            return [getCreateConfigInstruction({ payer: signer, mintAuthority: signer, mint: mint as never, config, authority: account.address as never, mode: mode === 'allowlist' ? Mode.Allowlist : Mode.Open })];
          }}
        />
      </div>
    </div>
  );
}
