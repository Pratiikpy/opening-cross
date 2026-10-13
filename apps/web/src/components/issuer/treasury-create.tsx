'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ActionButton } from '@/components/cross/action-button';
import { useSigner } from '@/components/cross/use-signer';
import { Fieldset, Select, Text } from '@/components/issue-wizard/fields';
import { RightsCards } from '@/components/treasury/rights-cards';
import { apiRead } from '@/lib/issuer-data';
import { readMintFull } from '@/lib/issuer-chain';
import type { MintRead } from '@/lib/issuer-readiness';
import { EMPTY_TREASURY, checkTreasuryForm } from '@/lib/issuer-treasury';
import type { TreasuryDetail } from '@/lib/treasury';
import { formatAtoms } from '@/lib/units';
import { useWallet } from '@/lib/wallet';
import type { UiWalletAccount } from '@wallet-standard/ui';
import { ConnectPrompt } from './connect-prompt';

export function TreasuryCreate() {
  const { account } = useWallet();
  if (!account) return <ConnectPrompt what="the treasury form for the wallet that will be its authority" />;
  return <Form account={account} />;
}

function Form({ account }: { account: UiWalletAccount }) {
  const sign = useSigner(account);
  const [f, setF] = useState(EMPTY_TREASURY);
  const [coin, setCoin] = useState<MintRead | null>(null);
  const [quote, setQuote] = useState<MintRead | null>(null);
  const [created, setCreated] = useState<{ treasury: string; signature: string } | null>(null);
  const [detail, setDetail] = useState<TreasuryDetail | null>(null);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));

  useEffect(() => {
    const c = new URLSearchParams(window.location.search).get('coin');
    if (c) setF((x) => ({ ...x, coinMint: c }));
  }, []);
  // Read each mint once its address is complete, so the form can say at once whether the coin's supply is fixed.
  useEffect(() => {
    setCoin(null);
    if (f.coinMint.trim().length < 32) return;
    let live = true;
    void readMintFull(f.coinMint.trim()).then((m) => live && setCoin(m));
    return () => {
      live = false;
    };
  }, [f.coinMint]);
  useEffect(() => {
    setQuote(null);
    if (f.quoteMint.trim().length < 32) return;
    let live = true;
    void readMintFull(f.quoteMint.trim()).then((m) => live && setQuote(m));
    return () => {
      live = false;
    };
  }, [f.quoteMint]);

  const checked = checkTreasuryForm(f, account.address, coin, quote);
  const err = (k: string) => (!checked.ok ? checked.errors[k] : undefined);
  // Shown only once a field has something in it, so an empty form does not open with a wall of errors.
  const show = (k: keyof typeof f, key = k as string) => (f[k].trim() === '' ? undefined : err(key));

  useEffect(() => {
    if (!created) return;
    let live = true;
    void apiRead<TreasuryDetail>(`/v1/treasuries/${created.treasury}`).then((r) => live && r.ok && setDetail(r.data));
    return () => {
      live = false;
    };
  }, [created]);

  if (created)
    return (
      <div className="mt-8 space-y-6">
        <div role="status" className="rounded-[var(--radius-card)] border border-border p-6">
          <p className="font-medium">Your treasury is on chain.</p>
          <p className="mt-1 break-all font-mono text-xs text-muted" data-testid="created-treasury">
            {created.treasury}
          </p>
          <div className="mt-4 flex flex-wrap gap-3">
            <Link href={`/treasury/${created.treasury}`} className="inline-flex min-h-11 items-center rounded-full bg-accent-fill px-5 py-2.5 text-sm font-medium text-on-accent">
              Open the page holders see
            </Link>
            <Link href={`/issuer/treasury/${created.treasury}`} className="inline-flex min-h-11 items-center rounded-full border border-border-strong px-5 py-2.5 text-sm font-medium hover:bg-surface" data-testid="open-console">
              Open the treasury console
            </Link>
          </div>
        </div>
        {detail ? <RightsCards cards={detail.rights} /> : <p className="text-sm text-muted">Reading what holders will be told…</p>}
      </div>
    );

  return (
    <form className="mt-8 max-w-2xl space-y-8" onSubmit={(e) => e.preventDefault()}>
      <Fieldset legend="The coin and what the treasury holds" note="The coin must already have a fixed supply: its mint authority is revoked. A coin minted by a cross is fixed when the cross finalizes, so create the treasury after that.">
        <Text label="Coin mint" value={f.coinMint} onChange={(v) => set('coinMint', v)} error={show('coinMint')} hint={coin && coin.ok && coin.mintAuthority === null ? `Supply is fixed: ${formatAtoms(coin.supply ?? 0n, coin.decimals)} tokens exist.` : undefined} />
        <Text label="Token the treasury holds (quote mint)" value={f.quoteMint} onChange={(v) => set('quoteMint', v)} error={show('quoteMint')} hint={quote && quote.ok ? `${quote.decimals} decimals` : undefined} />
      </Fieldset>

      <Fieldset legend="What the team may spend" note="The team can spend up to the allowance in each period, and only while an attestation from the attester you name is live. Unspent allowance does not carry over. These cannot be changed after the treasury exists.">
        <Text label="Allowance per period, in quote tokens" value={f.allowance} onChange={(v) => set('allowance', v)} inputMode="decimal" error={show('allowance')} />
        <div className="grid grid-cols-[1fr_auto] items-end gap-3">
          <Text label="Period length" value={f.periodAmount} onChange={(v) => set('periodAmount', v)} inputMode="numeric" error={show('periodAmount')} />
          <Select label="Unit" value={f.periodUnit} onChange={(v) => set('periodUnit', v as 'hours' | 'days')} options={[['days', 'days'], ['hours', 'hours']]} />
        </div>
      </Fieldset>

      <Fieldset legend="The attestation that unlocks spending" note="An attester you choose (an auditor or any party holders will trust) writes a Solana Attestation Service attestation for this treasury. While it is live the team can spend. If it lapses and stays lapsed for the grace period, anyone can start liquidation and holders redeem pro rata. This page does not create credentials or attestations: your attester does.">
        <Text label="Attestation credential address" value={f.credential} onChange={(v) => set('credential', v)} error={show('credential')} />
        <Text label="Attestation schema address" value={f.schema} onChange={(v) => set('schema', v)} error={show('schema')} />
        <div className="grid grid-cols-[1fr_auto] items-end gap-3">
          <Text label="Grace period after a lapse" value={f.graceAmount} onChange={(v) => set('graceAmount', v)} inputMode="numeric" error={show('graceAmount')} hint="How long the attester has to renew before holders can liquidate." />
          <Select label="Unit" value={f.graceUnit} onChange={(v) => set('graceUnit', v as 'hours' | 'days')} options={[['days', 'days'], ['hours', 'hours']]} />
        </div>
      </Fieldset>

      <div className="rounded-lg border border-border bg-surface p-4 text-sm text-muted" data-testid="treasury-limits">
        <p className="font-medium text-ink">Before you sign</p>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>You, {account.address.slice(0, 4)}…, become the treasury&apos;s authority: the only wallet that can spend.</li>
          <li>Funds arrive by an ordinary transfer to the treasury&apos;s vault; this does not move any.</li>
          <li>The program is not audited and this is Solana devnet only.</li>
        </ul>
      </div>
      <ActionButton
        label="Create the treasury"
        path="/v1/tx/create-treasury"
        disabled={!checked.ok}
        body={() => (checked.ok ? checked.body : {})}
        sign={sign}
        onDone={(sigs, extra) => setCreated({ treasury: String(extra.treasury), signature: sigs[0] ?? '' })}
      />
    </form>
  );
}
