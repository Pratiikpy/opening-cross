'use client';

import type { UiWalletAccount } from '@wallet-standard/ui';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Chip, SmallButton, Select, Text } from '@/components/issue-wizard/fields';
import { type DemandMap, publishRecord } from '@/lib/issuer-board';
import { pctOf, sizing } from '@/lib/issuer-demand';
import { apiRead } from '@/lib/issuer-data';
import { formatAtoms, parseAtoms, shortAddress } from '@/lib/units';
import { useWallet } from '@/lib/wallet';
import { WithMessageSigner } from './message-signer';

const TRACK: Record<keyof DemandMap['byTrackRecord'], string> = { 'filled-before': 'Filled in an earlier cross', 'bid-before': 'Bid in an earlier cross, not filled', 'no-history': 'No earlier cross on this network' };

export function DraftView({ id }: { id: string }) {
  const [m, setM] = useState<DemandMap | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { account } = useWallet();
  const load = useCallback(async () => {
    const r = await apiRead<DemandMap>(`/v1/issuer/drafts/${id}`);
    if (r.ok) setM(r.data);
    else setError(r.error);
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <p role="alert" className="mt-8 text-sm text-accent-text">{error}</p>;
  if (!m) return <p role="status" className="mt-8 text-sm text-muted">Reading the draft…</p>;
  const d = m.draft;
  const bd = d.baseDecimals;
  const qd = d.quoteDecimals;
  const s = sizing(m);
  const maxTokens = m.levels.reduce((a, l) => (BigInt(l.tokens) > a ? BigInt(l.tokens) : a), 1n);

  return (
    <div className="mt-8 space-y-8" data-testid="draft-view">
      <p role="status" className="rounded-[var(--radius-card)] border border-border-strong bg-surface p-4 text-sm" data-testid="not-verified">
        <span className="font-medium">Not yet verified. </span>
        This draft was published by {shortAddress(m.signer)} and signed with that wallet. Nobody has checked who stands behind it, what it claims or whether the token exists. It is not an offer, and nothing here moves money.
      </p>
      <header>
        <h1 className="text-[34px] font-semibold leading-tight tracking-tight">{d.title}</h1>
        <p className="mt-3 max-w-2xl whitespace-pre-line text-muted">{d.summary}</p>
      </header>
      <dl className="grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-muted">Planned offer</dt>
          <dd className="font-mono">{d.offered} tokens, {d.supplyMode === 'mint' ? 'minted at settlement' : 'sold from escrow'}</dd>
        </div>
        <div>
          <dt className="text-muted">Price grid</dt>
          <dd className="font-mono">
            {d.minPrice} to {m.grid ? formatAtoms(BigInt(m.grid.minPrice) + BigInt(d.ticks - 1) * BigInt(m.grid.tick), qd) : '?'} in steps of {d.tick}
          </dd>
        </div>
        <div>
          <dt className="text-muted">Token</dt>
          <dd className="font-mono">{d.baseMint ? shortAddress(d.baseMint) : 'not created yet'}</dd>
        </div>
        <div>
          <dt className="text-muted">Paid in</dt>
          <dd className="font-mono">{d.quoteMint ? shortAddress(d.quoteMint) : 'not chosen yet'}</dd>
        </div>
      </dl>

      <section aria-labelledby="demand-h" className="rounded-[var(--radius-card)] border border-border p-5">
        <h2 id="demand-h" className="font-medium">
          Demand so far
        </h2>
        <dl className="mt-3 grid gap-3 sm:grid-cols-3" data-testid="demand-totals">
          <div className="rounded-lg bg-surface p-3">
            <dt className="text-xs text-muted">Wallets</dt>
            <dd className="text-xl font-semibold">{m.commits.wallets}</dd>
          </div>
          <div className="rounded-lg bg-surface p-3">
            <dt className="text-xs text-muted">Tokens they would take</dt>
            <dd className="text-xl font-semibold">{formatAtoms(BigInt(m.commits.totalTokens), bd)}</dd>
          </div>
          <div className="rounded-lg bg-surface p-3">
            <dt className="text-xs text-muted">Quote they would spend</dt>
            <dd className="text-xl font-semibold">{formatAtoms(BigInt(m.commits.totalBudget), qd)}</dd>
          </div>
        </dl>
        {m.levels.length === 0 ? (
          <p className="mt-4 text-sm text-muted" data-testid="no-commits">No one has committed yet.</p>
        ) : (
          <>
            <p className="mt-6 font-mono text-[11px] uppercase tracking-wider text-muted">Demand by price</p>
            <div className="mt-3 grid gap-2" data-testid="demand-ladder">
              {[...m.levels].reverse().map((l) => (
                <div key={l.index} className="grid grid-cols-[56px_minmax(0,1fr)_96px] items-center gap-3 text-[13px] tabular-nums">
                  <span className="font-mono text-muted">{formatAtoms(BigInt(l.price), qd)}</span>
                  <span className="block h-3.5 overflow-hidden rounded bg-surface-2" aria-hidden="true">
                    <span className="block h-3.5 rounded bg-accent" style={{ width: `${Math.max(2, Number((BigInt(l.tokens) * 1000n) / maxTokens) / 10)}%` }} />
                  </span>
                  <span className="text-right text-xs text-muted">
                    {formatAtoms(BigInt(l.tokens), bd, 2)} · {l.wallets} {l.wallets === 1 ? 'wallet' : 'wallets'}
                  </span>
                </div>
              ))}
            </div>
            <p className="mt-6 font-medium">Sizing against your offer</p>
            <p className="text-xs text-muted">At each price, the tokens wanted at that price or higher, and how much of the {d.offered} tokens on offer they would cover. This is interest, not bids: fewer people follow through than say they will.</p>
            <ul className="mt-3 divide-y divide-border border-y border-border text-sm" data-testid="sizing">
              {s.rows.map((r) => (
                <li key={String(r.price)} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2">
                  <span className="font-mono">{formatAtoms(r.price, qd)}</span>
                  <span className="text-muted">{formatAtoms(r.tokensAtOrAbove, bd, 2)} tokens · {r.wallets} {r.wallets === 1 ? 'wallet' : 'wallets'}</span>
                  <span className="font-mono">{pctOf(r.coverageBps)} of the offer</span>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-sm" data-testid="cover-price">
              {s.coverPrice ? (
                <>
                  The whole offer is covered up to <span className="font-mono">{formatAtoms(s.coverPrice.price, qd)}</span>: selling it all there would raise <span className="font-mono">{formatAtoms(s.coverPrice.raise, qd)}</span> quote.
                </>
              ) : (
                <span className="text-muted">No price has enough committed demand to cover the whole offer.</span>
              )}
            </p>
            <p className="mt-6 font-medium">Who they are, by track record</p>
            <ul className="mt-2 space-y-1 text-sm" data-testid="track-record">
              {(Object.keys(TRACK) as (keyof typeof TRACK)[]).map((k) => (
                <li key={k} className="flex justify-between gap-4">
                  <span className="text-muted">{TRACK[k]}</span>
                  <span className="font-mono">
                    {m.byTrackRecord[k].wallets} {m.byTrackRecord[k].wallets === 1 ? 'wallet' : 'wallets'} · {formatAtoms(BigInt(m.byTrackRecord[k].tokens), bd, 2)} tokens
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
        <p className="mt-6 text-xs text-muted">{m.note} Track record is read from the orders the indexer holds for each wallet on this network; it says nothing about a wallet that has only acted elsewhere.</p>
        <p className="mt-3 text-sm">
          <Link href={`/issuer/simulator?draft=${id}`} className="underline underline-offset-4">
            Run this demand through the simulator
          </Link>
        </p>
      </section>

      {account ? (
        <WithMessageSigner account={account}>{(sign) => <CommitForm m={m} id={id} account={account} sign={sign} onDone={load} />}</WithMessageSigner>
      ) : (
        <p role="status" className="text-sm text-muted" data-testid="commit-connect">
          Connect a wallet to say how much you would commit. You sign a message; nothing is sent to the network and no funds move.
        </p>
      )}
    </div>
  );
}

function CommitForm({ m, id, account, sign, onDone }: { m: DemandMap; id: string; account: UiWalletAccount; sign: (msg: string) => Promise<string>; onDone: () => Promise<void> }) {
  const qd = m.draft.quoteDecimals;
  const levels = m.grid ? Array.from({ length: m.grid.ticks }, (_, i) => BigInt(m.grid!.minPrice) + BigInt(i) * BigInt(m.grid!.tick)) : [];
  const [price, setPrice] = useState(levels[0] !== undefined ? formatAtoms(levels[0], qd).replace(/,/g, '') : '');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const amountAtoms = parseAtoms(amount, qd);
  const bad = amount.trim() !== '' && (amountAtoms === null || amountAtoms === 0n) ? `An amount above zero with at most ${qd} decimal places.` : undefined;
  return (
    <form className="max-w-xl space-y-4 rounded-[var(--radius-card)] border border-border p-5" onSubmit={(e) => e.preventDefault()} data-testid="commit-form">
      <h2 className="font-medium">Say what you would commit</h2>
      <p className="text-sm text-muted">Pick the highest price you would pay and how much you would spend at most. You sign a message with {shortAddress(account.address)}. Nothing is sent to the network, no funds move and you are not bound. A later commit from the same wallet replaces this one.</p>
      <Select label="Highest price you would pay, per token" value={price} onChange={setPrice} options={levels.map((p) => [formatAtoms(p, qd).replace(/,/g, ''), formatAtoms(p, qd)] as [string, string])} />
      <Text label="Most you would spend, in quote tokens" value={amount} onChange={setAmount} inputMode="decimal" error={bad} />
      <Text label="A note (optional, up to 140 characters)" value={note} onChange={setNote} mono={false} />
      <SmallButton
        testId="send-commit"
        disabled={busy || amountAtoms === null || amountAtoms === 0n}
        onClick={async () => {
          setBusy(true);
          setMsg(null);
          const r = await publishRecord(sign, account.address, 'softcommit', { draft: id, price, amount: amount.trim(), note: note.trim() === '' ? null : note.trim() });
          setBusy(false);
          setMsg(r.ok ? { ok: true, text: 'Your commit is recorded. It shows in the demand above.' } : { ok: false, text: r.error });
          if (r.ok) await onDone();
        }}
      >
        {busy ? 'Waiting for your wallet…' : 'Sign and record my commit'}
      </SmallButton>
      {msg ? (
        <p role={msg.ok ? 'status' : 'alert'} className={`text-sm ${msg.ok ? 'text-positive' : 'text-accent-text'}`} data-testid="commit-result">
          {msg.text}
        </p>
      ) : null}
      <Chip tone="info">No funds move</Chip>
    </form>
  );
}
