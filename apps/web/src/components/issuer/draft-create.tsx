'use client';

import type { UiWalletAccount } from '@wallet-standard/ui';
import { isAddress } from '@solana/kit';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Fieldset, Num, Select, SmallButton, Text } from '@/components/issue-wizard/fields';
import { type StoredRecord, publishRecord } from '@/lib/issuer-board';
import { apiRead } from '@/lib/issuer-data';
import { parseAtoms } from '@/lib/units';
import { readMintFull } from '@/lib/issuer-chain';
import { useWallet } from '@/lib/wallet';
import { ConnectPrompt } from './connect-prompt';
import { WithMessageSigner } from './message-signer';

export function DraftCreate() {
  const { account } = useWallet();
  if (!account) return <ConnectPrompt what="your draft listings and a form to publish a new one" />;
  return <WithMessageSigner account={account}>{(sign) => <Inner account={account} sign={sign} />}</WithMessageSigner>;
}

const decimalPlaces = (t: string) => (/^\d+(\.\d+)?$/.test(t.trim()) ? (t.trim().split('.')[1]?.length ?? 0) : null);

function Inner({ account, sign }: { account: UiWalletAccount; sign: (m: string) => Promise<string> }) {
  const wallet = account.address;
  const [f, setF] = useState({ title: '', summary: '', baseMint: '', quoteMint: '', baseDecimals: 6, quoteDecimals: 6, minPrice: '1.00', tick: '0.05', ticks: 20, offered: '', supplyMode: 'mint' });
  const [mine, setMine] = useState<StoredRecord[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [published, setPublished] = useState<string | null>(null);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));

  const load = async () => {
    const r = await apiRead<{ records: StoredRecord[] }>(`/v1/issuer/records?kind=draft&signer=${wallet}&limit=50`);
    setMine(r.ok ? r.data.records : []);
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per wallet
  }, [wallet]);

  // Decimals come from the mints when they are given, so a price typed here means what it will mean in the cross.
  const readInto = async (which: 'baseMint' | 'quoteMint') => {
    const a = f[which].trim();
    if (!isAddress(a)) return;
    const m = await readMintFull(a);
    if (m.ok) set(which === 'baseMint' ? 'baseDecimals' : 'quoteDecimals', m.decimals);
    else setNote(m.reason);
  };

  const errors: Record<string, string> = {};
  if (f.title.trim() === '' || f.title.trim().length > 80) errors.title = 'A title of up to 80 characters.';
  if (f.summary.trim() === '' || f.summary.trim().length > 1200) errors.summary = 'A summary of up to 1,200 characters.';
  for (const k of ['baseMint', 'quoteMint'] as const) if (f[k].trim() !== '' && !isAddress(f[k].trim())) errors[k] = 'Not a Solana address.';
  for (const k of ['minPrice', 'tick'] as const) {
    const n = decimalPlaces(f[k]);
    if (n === null || n > f.quoteDecimals || (parseAtoms(f[k], f.quoteDecimals) ?? 0n) === 0n) errors[k] = `An amount above zero with at most ${f.quoteDecimals} decimal places.`;
  }
  if (!Number.isInteger(f.ticks) || f.ticks < 2 || f.ticks > 256) errors.ticks = 'Between 2 and 256 levels.';
  const off = parseAtoms(f.offered, f.baseDecimals);
  if (off === null || off === 0n) errors.offered = `Tokens you plan to offer, above zero, at most ${f.baseDecimals} decimal places.`;
  const valid = Object.keys(errors).length === 0;
  // An empty field is not scolded before it is touched.
  const shown = (k: string, v: string) => (v.trim() === '' ? undefined : errors[k]);

  const publish = async () => {
    setBusy(true);
    setNote(null);
    const r = await publishRecord(sign, wallet, 'draft', {
      title: f.title.trim(),
      summary: f.summary.trim(),
      baseMint: f.baseMint.trim() || null,
      quoteMint: f.quoteMint.trim() || null,
      baseDecimals: f.baseDecimals,
      quoteDecimals: f.quoteDecimals,
      minPrice: f.minPrice.trim(),
      tick: f.tick.trim(),
      ticks: f.ticks,
      offered: f.offered.trim(),
      supplyMode: f.supplyMode,
    });
    setBusy(false);
    if (r.ok) {
      setPublished(r.data.record.id);
      void load();
    } else setNote(r.error);
  };
  const link = (id: string) => (typeof window !== 'undefined' ? `${window.location.origin}/issuer/draft/${id}` : `/issuer/draft/${id}`);

  return (
    <div className="mt-8 space-y-10">
      {published ? (
        <div role="status" className="rounded-[var(--radius-card)] border border-border p-5" data-testid="draft-published">
          <p className="font-medium">Your draft is published.</p>
          <p className="mt-2 text-sm text-muted">Share this link. It shows “Not yet verified” at the top, and anyone with a wallet can say how much they would commit at which price.</p>
          <p className="mt-3 break-all font-mono text-xs" data-testid="draft-link">
            {link(published)}
          </p>
          <div className="mt-3 flex flex-wrap gap-3">
            <Link href={`/issuer/draft/${published}`} className="inline-flex min-h-11 items-center rounded-full bg-accent-fill px-5 py-2.5 text-sm font-medium text-on-accent">
              Open the draft
            </Link>
            <SmallButton onClick={() => void navigator.clipboard?.writeText(link(published))}>Copy the link</SmallButton>
          </div>
        </div>
      ) : null}
      <form className="max-w-2xl space-y-6" onSubmit={(e) => e.preventDefault()}>
        <Fieldset legend="Publish a draft listing" note="A draft is a public page, signed by your wallet, that shows what you plan and lets people say how much they would commit at which price. It is labelled not verified. It is public and permanent: do not put private information in it.">
          <Text label="Title" value={f.title} onChange={(v) => set('title', v)} error={shown('title', f.title)} mono={false} />
          <div className="text-sm">
            <label className="block">
              <span className="text-muted">What you are raising for</span>
              <textarea value={f.summary} onChange={(e) => set('summary', e.target.value)} rows={4} className="mt-1 w-full rounded-lg border border-border-strong bg-bg px-3 py-2.5" />
            </label>
            {shown('summary', f.summary) ? <span className="mt-1 block text-xs text-accent-text">{shown('summary', f.summary)}</span> : null}
          </div>
          <Text label="Token being sold, if it exists yet (optional)" value={f.baseMint} onChange={(v) => set('baseMint', v)} onBlur={() => void readInto('baseMint')} error={errors.baseMint} />
          <Text label="Paid in, if you know (optional)" value={f.quoteMint} onChange={(v) => set('quoteMint', v)} onBlur={() => void readInto('quoteMint')} error={errors.quoteMint} />
          <div className="grid gap-4 sm:grid-cols-2">
            <Num label="Decimals of the token being sold" value={f.baseDecimals} onChange={(v) => set('baseDecimals', Number.isInteger(v) ? v : 6)} />
            <Num label="Decimals of the payment token" value={f.quoteDecimals} onChange={(v) => set('quoteDecimals', Number.isInteger(v) ? v : 6)} />
          </div>
          <Text label="Lowest price per token" value={f.minPrice} onChange={(v) => set('minPrice', v)} inputMode="decimal" error={shown('minPrice', f.minPrice)} />
          <Text label="Step between prices" value={f.tick} onChange={(v) => set('tick', v)} inputMode="decimal" error={shown('tick', f.tick)} />
          <Num label="Number of price levels (2–256)" value={f.ticks} onChange={(v) => set('ticks', v)} error={errors.ticks} />
          <Text label="Tokens you plan to offer" value={f.offered} onChange={(v) => set('offered', v)} inputMode="decimal" error={shown('offered', f.offered)} />
          <Select label="Supply" value={f.supplyMode} onChange={(v) => set('supplyMode', v)} options={[['mint', 'Minted at settlement'], ['escrow', 'Sold from escrow']]} />
        </Fieldset>
        <button type="button" disabled={!valid || busy} onClick={() => void publish()} data-testid="publish-draft" className="w-full rounded-full bg-accent-fill px-5 py-3 text-sm font-medium text-on-accent disabled:opacity-50">
          {busy ? 'Waiting for your wallet…' : 'Sign and publish the draft'}
        </button>
        {note ? (
          <p role="alert" className="text-sm text-accent-text">
            {note}
          </p>
        ) : null}
      </form>

      <section aria-labelledby="mine-h">
        <h2 id="mine-h" className="text-xl font-semibold tracking-tight">
          Your drafts
        </h2>
        {!mine ? (
          <p className="mt-3 text-sm text-muted">Reading…</p>
        ) : mine.length === 0 ? (
          <p className="mt-3 text-sm text-muted" data-testid="no-drafts">
            You have not published a draft.
          </p>
        ) : (
          <ul className="mt-3 space-y-2" data-testid="my-drafts">
            {mine.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3 text-sm">
                <span className="font-medium">{String(r.body.title)}</span>
                <Link href={`/issuer/draft/${r.id}`} className="min-h-11 py-2 underline underline-offset-4">
                  Open and see the demand
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
