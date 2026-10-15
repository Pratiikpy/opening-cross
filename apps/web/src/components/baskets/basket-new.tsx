'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { Text } from '@/components/issue-wizard/fields';
import { Section } from '@/components/issuer/treasury-ui';
import { FeatureAction, FeatureNotice, Plain } from '@/components/w4/ui';
import { type BasketForm, EMPTY_BASKET, MAX_COMPONENTS, type ResolvedMint, buildBasket } from '@/lib/baskets';
import { useMint } from '@/lib/use-read';
import { shortAddress } from '@/lib/units';
import { useWallet } from '@/lib/wallet';

/** Creating a basket: a label and one to eight components, each an amount of a token per whole share. A basket never changes. */
export function BasketNew() {
  const { account } = useWallet();
  const wallet = account?.address ?? null;
  const [f, setF] = useState<BasketForm>(EMPTY_BASKET);
  const [mints, setMints] = useState<ResolvedMint[]>([null, null]);
  const [made, setMade] = useState<string | null>(null);
  const built = useMemo(() => buildBasket(f, wallet, mints), [f, wallet, mints]);
  const setRow = (i: number, patch: Partial<BasketForm['components'][number]>) => setF((x) => ({ ...x, components: x.components.map((c, j) => (j === i ? { ...c, ...patch } : c)) }));
  const resolve = (i: number) => (m: ResolvedMint) => setMints((cur) => (cur[i]?.decimals === m?.decimals && (cur[i] === null) === (m === null) && cur[i]?.extensions.join() === m?.extensions.join() ? cur : cur.map((x, j) => (j === i ? m : x))));
  return (
    <div className="space-y-6">
      <FeatureNotice feature="baskets" what="Basket tokens" />
      <Plain testId="basket-warning">
        A basket never changes: no manager, fee, rebalance or pause. A token gated by an eligibility pass cannot be a component, and neither can a token with a transfer fee, a permanent delegate, a transfer hook or another restricting extension. A component whose issuer holds a freeze authority can have the basket&apos;s vault frozen.
      </Plain>
      <Section id="terms" title="The basket" intro={<p>One whole share is the amounts you set below. Anyone can then mint a share by depositing them and redeem it for them.</p>}>
        <div className="space-y-4" data-testid="basket-form">
          <Text label="Label" value={f.label} onChange={(v) => setF({ ...f, label: v })} mono={false} error={f.label === '' ? undefined : built.errors.label} hint="Up to 32 bytes." />
          {f.components.map((c, i) => (
            <Row key={i} i={i} c={c} onChange={(patch) => setRow(i, patch)} onMint={resolve(i)} errors={built.errors.rows[i] ?? {}} removable={f.components.length > 1} onRemove={() => { setF((x) => ({ ...x, components: x.components.filter((_, j) => j !== i) })); setMints((m) => m.filter((_, j) => j !== i)); }} />
          ))}
          {built.errors.components ? <p className="text-xs text-accent-text">{built.errors.components}</p> : null}
          <button type="button" disabled={f.components.length >= MAX_COMPONENTS} data-testid="add-component" onClick={() => { setF((x) => ({ ...x, components: [...x.components, { mint: '', units: '' }] })); setMints((m) => [...m, null]); }} className="min-h-11 rounded-full border border-border-strong px-4 py-2 text-sm hover:bg-surface disabled:opacity-50">
            Add a component
          </button>
          {f.components.length > 5 ? <p className="text-xs text-muted" data-testid="many-note">More than about five components may need an address lookup table to mint in one transaction.</p> : null}
        </div>
        <div className="max-w-sm">
          <FeatureAction feature="baskets" what="Basket tokens" account={account} label="Create the basket" testId="create-basket" path="/v1/tx/basket-create" body={() => built.body} disabled={!built.body} disabledReason={wallet ? 'Fill in the fields marked above.' : 'Connect a wallet to create a basket.'} onBuilt={(x) => setMade(typeof x.basket === 'string' ? x.basket : null)} onDone={() => undefined} />
        </div>
        {made ? (
          <p className="text-sm" role="status" data-testid="made">
            Created.{' '}
            <Link href={`/baskets/${made}`} className="font-mono underline underline-offset-4">
              {shortAddress(made)}
            </Link>
          </p>
        ) : null}
      </Section>
    </div>
  );
}

function Row({ i, c, onChange, onMint, errors, removable, onRemove }: { i: number; c: { mint: string; units: string }; onChange: (p: Partial<{ mint: string; units: string }>) => void; onMint: (m: ResolvedMint) => void; errors: { mint?: string; units?: string }; removable: boolean; onRemove: () => void }) {
  const mint = useMint(c.mint.trim().length >= 32 ? c.mint.trim() : null);
  useEffect(() => {
    onMint(mint.info ? { decimals: mint.info.decimals, extensions: mint.info.extensions } : null);
  }, [mint.info, onMint]);
  return (
    <div className="grid gap-3 sm:grid-cols-[1fr_200px_auto] sm:items-end" data-testid={`row-${i}`}>
      <Text label={`Component ${i + 1}: token`} value={c.mint} onChange={(v) => onChange({ mint: v })} error={c.mint === '' ? undefined : errors.mint} hint={mint.info ? `${mint.info.symbol ?? 'Token'} with ${mint.info.decimals} decimals${mint.info.freezeAuthority ? '; its issuer can freeze accounts' : ''}.` : mint.failed ? 'This token could not be read on this network.' : undefined} />
      <Text label={`Component ${i + 1}: per share`} value={c.units} onChange={(v) => onChange({ units: v })} inputMode="decimal" error={c.units === '' ? undefined : errors.units} />
      <button type="button" disabled={!removable} onClick={onRemove} aria-label={`Remove component ${i + 1}`} className="min-h-11 rounded-full border border-border-strong px-4 py-2 text-sm hover:bg-surface disabled:opacity-50">
        Remove
      </button>
    </div>
  );
}
