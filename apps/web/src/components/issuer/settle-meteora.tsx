'use client';

import { isAddress } from '@solana/kit';
import { useEffect, useMemo, useState } from 'react';
import { Select, Text } from '@/components/issue-wizard/fields';
import { readMintFull } from '@/lib/issuer-chain';
import { apiRead, type CrossRow } from '@/lib/issuer-data';
import { type FreshKey, cosign, freshKey } from '@/lib/issuer-settle';
import { atomsOf } from '@/lib/issuer-treasury-console';
import { type AlphaForm, type MetLockForm, type RecipientRow, EMPTY_ALPHA, EMPTY_METLOCK, MAX_RECIPIENTS, buildAlphaInit, buildFeeShare, buildMetLock } from '@/lib/settle-open';
import { shortAddress } from '@/lib/units';
import type { useWallet } from '@/lib/wallet';
import { WalletAction } from './issuer-action';
import { Facts, Pill, Section } from './treasury-ui';

type Account = ReturnType<typeof useWallet>['account'];

/** A new keypair for the account an action creates (a vault's base, a lock's base). It lives in memory for the one action and is renewed after it. */
function useFresh(): [FreshKey | null, () => void] {
  const [key, setKey] = useState<FreshKey | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    void freshKey().then((k) => live && setKey(k));
    return () => {
      live = false;
    };
  }, [n]);
  return [key, () => setN((x) => x + 1)];
}

type AlphaRead = { cross: string; vault: string | null; state: Record<string, unknown> | null; mode?: string; escrow?: Record<string, unknown> | null; hasEscrow?: boolean; note?: string };

/** The Alpha Vault of a batch-opened DAMM v2 pool: create it, deposit, fill it, claim, and take back what an oversubscribed vault did not use. */
export function AlphaVault({ cross, row, account, wallet, quoteDecimals }: { cross: string; row: CrossRow | null; account: Account; wallet: string | undefined; quoteDecimals: number | null }) {
  const [rev, setRev] = useState(0);
  const [read, setRead] = useState<AlphaRead | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [f, setF] = useState<AlphaForm>(EMPTY_ALPHA);
  const [deposit, setDeposit] = useState('');
  useEffect(() => {
    let live = true;
    void apiRead<AlphaRead>(`/v1/crosses/${cross}/alpha-vault${wallet ? `?owner=${wallet}` : ''}`).then((r) => {
      if (!live) return;
      if (r.ok) {
        setRead(r.data);
        setError(null);
      } else setError(r.error);
    });
    return () => {
      live = false;
    };
  }, [cross, wallet, rev]);
  const reload = () => setRev((r) => r + 1);
  const exists = Boolean(read?.vault && read.state);
  const isCreator = row !== null && wallet !== undefined && row.creator === wallet;
  const built = useMemo(() => buildAlphaInit(f, cross, wallet ?? null, quoteDecimals), [f, cross, wallet, quoteDecimals]);
  const e = built.errors;
  const amount = deposit.trim() === '' ? null : atomsOf(deposit, quoteDecimals, 'The deposit');
  const settled = row !== null && row.state !== 'Live';
  return (
    <Section id="alpha" title="Alpha Vault" intro="Before a batch-opened pool’s public start, only its Alpha Vault can buy. People deposit quote tokens into the vault; it buys for them at the pool’s first price and they claim what it bought as it vests. A pro-rata vault that is oversubscribed gives back what it did not use. Meteora’s program holds the money, not this protocol.">
      {error ? (
        <p role="alert" className="text-sm text-accent-text" data-testid="alpha-error">
          {error}
        </p>
      ) : null}
      {read ? (
        <div data-testid="alpha-state">
          {exists ? (
            <Facts rows={[['Vault', read.vault!], ['Mode', read.mode === 'prorata' || read.mode === 'fcfs' ? (read.mode === 'prorata' ? 'Pro rata: everyone deposits, the vault buys up to its cap' : 'First come, first served') : String(read.mode ?? 'unknown')], ['Your escrow', read.hasEscrow ? 'open' : 'none yet']]} />
          ) : (
            <p className="text-sm text-muted">{read.note ?? 'No Alpha Vault exists for this cross’s pool.'}</p>
          )}
        </div>
      ) : null}
      {exists ? (
        <div className="grid gap-4 sm:grid-cols-2" data-testid="alpha-actions">
          <div className="space-y-3 rounded-lg border border-border p-4">
            <Text label="Deposit, in quote tokens" value={deposit} onChange={setDeposit} inputMode="decimal" error={amount && !amount.ok ? amount.error : undefined} hint="The first deposit opens your escrow, which costs a small rent." />
            <WalletAction account={account} label="Deposit" variant="secondary" path="/v1/tx/alpha-vault-deposit" needs="crossSettle" what="The Alpha Vault" testId="alpha-deposit" disabled={!amount?.ok} disabledReason="Enter an amount." connectHint="Connect the wallet that deposits." body={() => ({ cross, owner: wallet, amount: amount && amount.ok ? amount.atoms : '0' })} onDone={reload} />
          </div>
          <div className="space-y-3 rounded-lg border border-border p-4">
            <WalletAction account={account} label="Fill the vault" variant="secondary" path="/v1/tx/alpha-vault-fill" needs="crossSettle" what="The Alpha Vault" testId="alpha-fill" connectHint="Anyone can send this. Connect a wallet to pay the fee." body={() => ({ cross, cranker: wallet })} onDone={reload} />
            <p className="text-xs text-muted">Anyone may fill the vault: it buys from the pool what the deposits allow.</p>
            <WalletAction account={account} label="Claim what the vault bought" variant="secondary" path="/v1/tx/alpha-vault-claim" needs="crossSettle" what="The Alpha Vault" testId="alpha-claim" body={() => ({ cross, owner: wallet })} onDone={reload} />
            <WalletAction account={account} label="Take back what was not used" variant="secondary" path="/v1/tx/alpha-vault-withdraw-remaining" needs="crossSettle" what="The Alpha Vault" testId="alpha-withdraw" body={() => ({ cross, owner: wallet })} onDone={reload} />
          </div>
        </div>
      ) : (
        <div className="space-y-4" data-testid="alpha-create">
          <p className="text-sm font-medium">Create the vault</p>
          <p className="text-xs text-muted">The pool must have been opened with “Bind an Alpha Vault” above. Only the wallet that created the cross can create its vault.</p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Select label="Mode" value={f.mode} onChange={(v) => setF({ ...f, mode: v as AlphaForm['mode'] })} options={[['prorata', 'Pro rata'], ['fcfs', 'First come, first served']]} />
            {f.mode === 'prorata' ? (
              <Text label="The most the vault buys, in quote tokens" value={f.buyingCap} onChange={(v) => setF({ ...f, buyingCap: v })} inputMode="decimal" error={f.buyingCap === '' ? undefined : e.buyingCap} />
            ) : (
              <>
                <Text label="The most the vault takes in, in quote tokens" value={f.depositCap} onChange={(v) => setF({ ...f, depositCap: v })} inputMode="decimal" error={f.depositCap === '' ? undefined : e.depositCap} />
                <Text label="The most one wallet may deposit" value={f.perWalletCap} onChange={(v) => setF({ ...f, perWalletCap: v })} inputMode="decimal" error={f.perWalletCap === '' ? undefined : e.perWalletCap} />
              </>
            )}
            <Text label="Deposits open at (optional)" type="datetime-local" mono={false} value={f.depositAt} onChange={(v) => setF({ ...f, depositAt: v })} error={e.depositAt} hint="Empty: at once." />
            <Text label="Claiming starts" type="datetime-local" mono={false} value={f.vestStart} onChange={(v) => setF({ ...f, vestStart: v })} error={f.vestStart === '' ? undefined : e.vestStart} />
            <Text label="Vesting ends" type="datetime-local" mono={false} value={f.vestEnd} onChange={(v) => setF({ ...f, vestEnd: v })} error={f.vestEnd === '' ? undefined : e.vestEnd} />
          </div>
          <div className="max-w-sm">
            <WalletAction account={account} label="Create the Alpha Vault" variant="secondary" path="/v1/tx/alpha-vault-init" needs="crossSettle" what="The Alpha Vault" testId="alpha-init" disabled={!built.body || !isCreator || !settled} disabledReason={!settled ? 'The cross has not settled yet.' : !isCreator ? 'Only the wallet that created the cross can create its vault.' : 'Fill in the fields marked above.'} body={() => built.body} onDone={reload} />
          </div>
        </div>
      )}
    </Section>
  );
}

type EscrowRead = { escrow?: string; total?: string; vested?: string; claimable?: string; cancelled?: boolean; note?: string };

/** Met Lock: lock tokens for a recipient on a vesting schedule, and let the recipient claim what has vested. */
export function MetLock({ account, wallet }: { account: Account; wallet: string | undefined }) {
  const [f, setF] = useState<MetLockForm>(EMPTY_METLOCK);
  const [key, renew] = useFresh();
  const [decimals, setDecimals] = useState<number | null>(null);
  const [escrow, setEscrow] = useState('');
  const [read, setRead] = useState<EscrowRead | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [made, setMade] = useState<string | null>(null);
  useEffect(() => {
    if (!isAddress(f.mint.trim())) {
      setDecimals(null);
      return;
    }
    let live = true;
    void readMintFull(f.mint.trim()).then((m) => live && setDecimals(m.ok ? m.decimals : null));
    return () => {
      live = false;
    };
  }, [f.mint]);
  const built = useMemo(() => buildMetLock(f, wallet ?? null, key?.address ?? null, decimals), [f, wallet, key, decimals]);
  const e = built.errors;
  const shown = (k: keyof MetLockForm) => (f[k] === '' ? undefined : e[k]);
  const look = async () => {
    setRead(null);
    setReadError(null);
    const r = await apiRead<EscrowRead>(`/v1/metlock/escrows/${escrow.trim()}`);
    if (r.ok) setRead(r.data);
    else setReadError(r.error);
  };
  return (
    <Section id="metlock" title="Met Lock" intro="Lock tokens for a recipient on a schedule: an optional cliff, then equal parts every period. Meteora’s Met Lock holds them and the recipient claims what has vested. A token with a transfer hook cannot be locked here, because the tokens could end up in an escrow nobody can claim from.">
      <div className="grid gap-4 sm:grid-cols-2" data-testid="metlock-form">
        <Text label="Token to lock" value={f.mint} onChange={(v) => setF({ ...f, mint: v })} error={shown('mint')} />
        <Text label="Recipient" value={f.recipient} onChange={(v) => setF({ ...f, recipient: v })} error={shown('recipient')} />
        <Text label="Amount to lock" value={f.total} onChange={(v) => setF({ ...f, total: v })} inputMode="decimal" error={shown('total')} hint="Exactly this amount is locked, with no remainder." />
        <Text label="The schedule starts" type="datetime-local" mono={false} value={f.startAt} onChange={(v) => setF({ ...f, startAt: v })} error={shown('startAt')} hint="In your time zone." />
        <Text label="Cliff, days" value={f.cliffDays} onChange={(v) => setF({ ...f, cliffDays: v })} inputMode="numeric" error={e.cliffDays} />
        <Text label="Unlocked at the cliff, %" value={f.cliffUnlockPct} onChange={(v) => setF({ ...f, cliffUnlockPct: v })} inputMode="decimal" error={e.cliffUnlockPct} />
        <Text label="Vesting periods" value={f.periods} onChange={(v) => setF({ ...f, periods: v })} inputMode="numeric" error={e.periods} />
        <Text label="Each period, days" value={f.periodDays} onChange={(v) => setF({ ...f, periodDays: v })} inputMode="numeric" error={e.periodDays} />
      </div>
      <div className="max-w-sm">
        <WalletAction account={account} label="Lock the tokens" variant="secondary" path="/v1/tx/metlock-create" needs="crossSettle" what="Met Lock" testId="metlock-create" disabled={!built.body} disabledReason="Fill in the fields marked above." cosign={key ? (tx) => cosign(tx, key) : undefined} body={() => built.body} onBuilt={(x) => setMade(typeof x.escrow === 'string' ? x.escrow : null)} onDone={() => renew()} />
        <p className="mt-1 text-xs text-muted">A new account is made for this lock and signs next to your wallet. It holds nothing and is not stored.</p>
        {made ? (
          <p className="mt-2 break-all text-xs text-muted" role="status" data-testid="metlock-escrow">
            Escrow: <span className="font-mono">{made}</span>
          </p>
        ) : null}
      </div>
      <div className="space-y-3 rounded-lg border border-border p-4" data-testid="metlock-claim">
        <p className="font-medium">Claim what has vested</p>
        <div className="grid grid-cols-[1fr_auto] items-end gap-3">
          <Text label="Escrow address" value={escrow} onChange={setEscrow} error={escrow.trim() !== '' && !isAddress(escrow.trim()) ? 'This is not a Solana address.' : undefined} />
          <button type="button" onClick={() => void look()} disabled={!isAddress(escrow.trim())} data-testid="metlock-look" className="min-h-11 rounded-full border border-border-strong px-4 py-2 text-sm hover:bg-surface disabled:opacity-50">
            Look
          </button>
        </div>
        {readError ? (
          <p role="alert" className="text-sm text-accent-text" data-testid="metlock-read-error">
            {readError}
          </p>
        ) : null}
        {read ? (
          <Facts rows={[['Locked', String(read.total ?? 'unread')], ['Vested so far', String(read.vested ?? 'unread')], ['Claimable now', String(read.claimable ?? 'unread')], ['Cancelled', read.cancelled ? 'yes' : 'no']]} />
        ) : null}
        <WalletAction account={account} label="Claim" variant="secondary" path="/v1/tx/metlock-claim" needs="crossSettle" what="Met Lock" testId="metlock-claim-go" disabled={!isAddress(escrow.trim())} disabledReason="Enter the escrow address." connectHint="Connect the recipient’s wallet." body={() => ({ recipient: wallet, escrow: escrow.trim() })} onDone={() => void look()} />
      </div>
    </Section>
  );
}

type FeeVaultRead = { feeVault?: string; tokenVault?: string; vault: Record<string, unknown> | null; shares?: unknown; note?: string };

/** Dynamic Fee Sharing: split a quote token between up to five recipients, fund the vault, claim, and (after the pool migrates) hand the DAMM v2 position's fees to it. */
export function FeeSharing({ cross, row, account, wallet }: { cross: string; row: CrossRow | null; account: Account; wallet: string | undefined }) {
  const [key, renew] = useFresh();
  const [rows, setRows] = useState<RecipientRow[]>([{ address: '', share: '1' }]);
  const [baseText, setBaseText] = useState('');
  const [read, setRead] = useState<FeeVaultRead | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [fund, setFund] = useState('');
  const [quoteDecimals, setQuoteDecimals] = useState<number | null>(null);
  useEffect(() => {
    if (!row) return;
    let live = true;
    void readMintFull(row.quoteMint).then((m) => live && setQuoteDecimals(m.ok ? m.decimals : null));
    return () => {
      live = false;
    };
  }, [row]);
  const draft = buildFeeShare(rows, wallet ?? null, key?.address ?? null, cross);
  const base = baseText.trim();
  const baseOk = isAddress(base);
  // Where this wallet stands among the vault's recipients: from the vault when it has been read (the order the program holds), otherwise from the list typed above.
  const shares = read && Array.isArray(read.shares) ? (read.shares as unknown[]) : null;
  const fromVault = shares && wallet ? shares.findIndex((x) => typeof x === 'object' && x !== null && Object.values(x as Record<string, unknown>).includes(wallet)) : -1;
  const index = fromVault >= 0 ? fromVault : rows.findIndex((r) => wallet !== undefined && r.address.trim() === wallet);
  const funding = fund.trim() === '' ? null : atomsOf(fund, quoteDecimals, 'The amount');
  const look = async () => {
    if (!row || !baseOk) return;
    setRead(null);
    setReadError(null);
    const r = await apiRead<FeeVaultRead>(`/v1/fee-share/${base}/${row.quoteMint}`);
    if (r.ok) setRead(r.data);
    else setReadError(r.error);
  };
  return (
    <Section id="feeshare" title="Fee sharing" intro="A Dynamic Fee Sharing vault splits a token between up to five recipients by weight. After a pool migrates to DAMM v2, its position can be handed to the vault so the position’s trading fees are split the same way. Meteora’s program holds the money.">
      <div className="space-y-3 rounded-lg border border-border p-4" data-testid="feeshare-create">
        <p className="font-medium">Create a vault for this cross’s quote token</p>
        {rows.map((r, i) => (
          <div key={i} className="grid grid-cols-[1fr_6rem] gap-3">
            <Text label={`Recipient ${i + 1}`} value={r.address} onChange={(v) => setRows(rows.map((x, j) => (j === i ? { ...x, address: v } : x)))} />
            <Text label="Share" value={r.share} onChange={(v) => setRows(rows.map((x, j) => (j === i ? { ...x, share: v } : x)))} inputMode="numeric" />
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" onClick={() => setRows([...rows, { address: '', share: '1' }])} disabled={rows.length >= MAX_RECIPIENTS} data-testid="feeshare-add" className="min-h-11 rounded-full border border-border-strong px-4 py-2 text-sm hover:bg-surface disabled:opacity-50">
            Add a recipient
          </button>
          {draft.percents.length > 0 ? (
            <span className="text-sm text-muted" data-testid="feeshare-percents">
              {draft.percents.map((p) => `${p}%`).join(', ')}
            </span>
          ) : null}
        </div>
        {draft.error ? (
          <p role="alert" className="text-sm text-accent-text" data-testid="feeshare-error">
            {draft.error}
          </p>
        ) : null}
        <div className="max-w-sm">
          <WalletAction account={account} label="Create the vault" variant="secondary" path="/v1/tx/fee-share-create" needs="crossSettle" what="Dynamic Fee Sharing" testId="feeshare-create-go" disabled={!draft.body} disabledReason="Name each recipient and their share." cosign={key ? (tx) => cosign(tx, key) : undefined} body={() => draft.body} onBuilt={(x) => void x} onDone={() => { setBaseText(key?.address ?? ''); renew(); }} />
          <p className="mt-1 text-xs text-muted">The vault is named by a new account that signs next to your wallet. Keep the address it shows afterwards: it is how the vault is found.</p>
        </div>
      </div>
      <div className="space-y-3 rounded-lg border border-border p-4" data-testid="feeshare-manage">
        <p className="font-medium">An existing vault</p>
        <div className="grid grid-cols-[1fr_auto] items-end gap-3">
          <Text label="Vault base address" value={baseText} onChange={setBaseText} error={base !== '' && !baseOk ? 'This is not a Solana address.' : undefined} />
          <button type="button" onClick={() => void look()} disabled={!baseOk || !row} data-testid="feeshare-look" className="min-h-11 rounded-full border border-border-strong px-4 py-2 text-sm hover:bg-surface disabled:opacity-50">
            Look
          </button>
        </div>
        {readError ? (
          <p role="alert" className="text-sm text-accent-text">
            {readError}
          </p>
        ) : null}
        {read ? (
          <p className="text-sm" data-testid="feeshare-read">
            {read.vault ? <>This vault splits the quote token between {Array.isArray(read.shares) ? read.shares.length : 'its'} recipients. <span className="font-mono text-xs">{shortAddress(String(read.feeVault ?? ''))}</span></> : (read.note ?? 'No vault exists for this base address.')}
          </p>
        ) : null}
        <Text label="Fund the vault, in quote tokens" value={fund} onChange={setFund} inputMode="decimal" error={funding && !funding.ok ? funding.error : undefined} />
        <div className="grid gap-3 sm:grid-cols-2">
          <WalletAction account={account} label="Fund the vault" variant="secondary" path="/v1/tx/fee-share-fund" needs="crossSettle" what="Dynamic Fee Sharing" testId="feeshare-fund" disabled={!baseOk || !funding?.ok} disabledReason="Name the vault and an amount." body={() => ({ funder: wallet, base, cross, amount: funding && funding.ok ? funding.atoms : '0' })} onDone={() => void look()} />
          <WalletAction account={account} label="Claim my share" variant="secondary" path="/v1/tx/fee-share-claim" needs="crossSettle" what="Dynamic Fee Sharing" testId="feeshare-claim" disabled={!baseOk || index < 0} disabledReason={index < 0 ? 'Read the vault (Look), or enter its recipients above with your wallet among them, so your place in its list is known.' : 'Name the vault.'} body={() => ({ user: wallet, base, cross, index })} onDone={() => void look()} />
          <WalletAction account={account} label="Hand the pool’s position to the vault" variant="secondary" path="/v1/tx/fee-share-transfer-position" needs="crossSettle" what="Dynamic Fee Sharing" testId="feeshare-transfer" disabled={!baseOk} disabledReason="Name the vault." body={() => ({ cross, owner: wallet, base })} onDone={() => void look()} />
          <WalletAction account={account} label="Pull the position’s fees into the vault" variant="secondary" path="/v1/tx/fee-share-fund-from-damm" needs="crossSettle" what="Dynamic Fee Sharing" testId="feeshare-pull" disabled={!baseOk} disabledReason="Name the vault." body={() => ({ cross, signer: wallet, base })} onDone={() => void look()} />
        </div>
        <p className="text-xs text-muted" data-testid="transfer-warning">
          Handing the position to the vault is one way: the vault, not you, then holds the position. The API refuses it unless the vault exists, splits this pool’s quote token and you hold the position. Only a recipient can pull the fees in.
        </p>
      </div>
      <Pill>Meteora’s program</Pill>
    </Section>
  );
}
