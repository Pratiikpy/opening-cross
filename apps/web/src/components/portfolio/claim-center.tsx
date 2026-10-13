'use client';

import Link from 'next/link';
import { useState } from 'react';
import { type Portfolio, claimNote } from '@/lib/portfolio';
import { ActionError, type Signer, build, signSendConfirm } from '@/lib/tx';
import { formatAtoms, formatPrice, shortAddress } from '@/lib/units';

type Claimable = Portfolio['claimable'][number];
type Phase = { phase: 'idle' } | { phase: 'working'; text: string } | { phase: 'done' } | { phase: 'failed'; message: string };

const KIND_LABEL = { cleared: 'Cleared, unclaimed', 'no-print': 'Did not print, refund due', unrevealed: 'Sealed bid never revealed, refund due' } as const;

/** Every order of the wallet that can be claimed now, with one action to claim them all, one signature at a time. */
export function ClaimCenter({ claimable, owner, sign, onChanged, chainUnread, checking }: { claimable: Claimable[]; owner: string; sign: Signer; onChanged: () => void; chainUnread: boolean; checking: boolean }) {
  const [state, setState] = useState<Record<string, Phase>>({});
  // Orders claimed in this visit stay listed as done until the next reload, so a finished batch can be read.
  const [claimed, setClaimed] = useState<Claimable[]>([]);
  const [running, setRunning] = useState(false);

  const set = (address: string, p: Phase) => setState((s) => ({ ...s, [address]: p }));
  const rows = [...claimable, ...claimed.filter((c) => !claimable.some((x) => x.order.address === c.order.address))];
  const pending = rows.filter((r) => state[r.order.address]?.phase !== 'done');

  async function claimOne(r: Claimable): Promise<'done' | 'failed' | 'declined'> {
    const a = r.order.address;
    set(a, { phase: 'working', text: 'Preparing…' });
    try {
      const built = await build('/v1/tx/claim', { cross: r.cross.address, owner, nonce: r.nonce, payer: owner });
      await signSendConfirm(built.txs, sign, (text) => set(a, { phase: 'working', text }));
      set(a, { phase: 'done' });
      setClaimed((c) => (c.some((x) => x.order.address === a) ? c : [...c, r]));
      return 'done';
    } catch (e) {
      const message = e instanceof ActionError ? e.message : `Something went wrong: ${e instanceof Error ? e.message : String(e)}`;
      set(a, { phase: 'failed', message });
      return /declined/i.test(message) ? 'declined' : 'failed';
    }
  }

  async function claimAll() {
    setRunning(true);
    let any = false;
    // One at a time, in the order shown: each claim is its own wallet signature, and a decline ends the run so nothing is asked twice.
    for (const r of pending) {
      const out = await claimOne(r);
      if (out === 'done') any = true;
      if (out === 'declined') break;
    }
    setRunning(false);
    if (any) onChanged();
  }

  async function claimSingle(r: Claimable) {
    setRunning(true);
    const out = await claimOne(r);
    setRunning(false);
    if (out === 'done') onChanged();
  }

  const cancelNote = <p className="mt-3 text-xs text-muted">Cancelling an order returns its escrow in the same transaction, so a cancelled order never waits here.</p>;

  if (rows.length === 0) {
    return (
      <section aria-labelledby="claims" className="rounded-[var(--radius-card)] border border-border p-5" data-testid="claim-center">
        <h2 id="claims" className="font-medium">
          Claim center
        </h2>
        <p className="mt-2 text-sm text-muted" data-testid="nothing-to-claim">
          {checking
            ? 'Checking the chain for orders that can be claimed…'
            : chainUnread
              ? 'The chain could not be read just now, so unclaimed orders may be missing from this list. Reload to try again.'
            : 'Nothing to claim. An order appears here once its cross has cleared (or did not print) and it has not yet been paid out.'}
        </p>
        {cancelNote}
      </section>
    );
  }

  return (
    <section aria-labelledby="claims" className="rounded-[var(--radius-card)] border border-border p-5" data-testid="claim-center">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="claims" className="font-medium">
            Claim center
          </h2>
          <p className="mt-1 text-sm text-muted" data-testid="claim-count">
            {pending.length === 0
              ? 'Everything in this list is claimed.'
              : `${pending.length} ${pending.length === 1 ? 'order is' : 'orders are'} ready to claim. Each one is its own wallet signature.`}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void claimAll()}
          disabled={running || pending.length === 0}
          className="min-h-11 rounded-full bg-accent-fill px-5 py-2.5 text-sm font-medium text-on-accent transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {running ? 'Claiming…' : `Claim all (${pending.length})`}
        </button>
      </div>
      <ul className="mt-4 divide-y divide-border border-y border-border" data-testid="claim-list">
        {rows.map((r) => {
          const st = state[r.order.address] ?? { phase: 'idle' as const };
          const m = { priceScale: BigInt(r.cross.grid.priceScale), baseDecimals: r.cross.decimals.base, quoteDecimals: r.cross.decimals.quote };
          const o = r.order;
          return (
            <li key={o.address} className="py-4" data-testid="claim-row" data-phase={st.phase}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 text-sm">
                  <p className="font-medium">
                    <span className="capitalize">{o.side}</span>
                    {o.quantity ? ` ${formatAtoms(BigInt(o.quantity), m.baseDecimals)} tokens` : ' order'}
                    {o.price ? ` at ${o.side === 'buy' ? 'up to' : 'at least'} ${formatPrice(BigInt(o.price), m)} per token` : ', price sealed'}
                  </p>
                  <p className="mt-1 text-muted">
                    <Link href={`/crosses/${r.cross.address}`} className="text-accent-text underline">
                      Cross {shortAddress(r.cross.address)}
                    </Link>{' '}
                    · {KIND_LABEL[r.claim]} · escrow {o.side === 'buy' ? `${formatAtoms(BigInt(o.escrow), m.quoteDecimals)} quote` : `${formatAtoms(BigInt(o.escrow), m.baseDecimals)} tokens`}
                  </p>
                  <p className="mt-1 text-xs text-muted">{claimNote(r.claim)}</p>
                </div>
                <div className="flex shrink-0 items-center gap-3 text-sm">
                  {st.phase === 'done' ? (
                    <span className="text-positive" role="status">
                      Claimed
                    </span>
                  ) : st.phase === 'working' ? (
                    <span className="text-muted" role="status">
                      {st.text}
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void claimSingle(r)}
                      disabled={running}
                      className="min-h-11 rounded-full border border-border-strong px-4 py-2 text-sm font-medium transition-colors hover:bg-surface disabled:opacity-50"
                      aria-label={`${st.phase === 'failed' ? 'Retry claim' : 'Claim'} ${o.side} order ${shortAddress(o.address)}`}
                    >
                      {st.phase === 'failed' ? 'Retry' : 'Claim'}
                    </button>
                  )}
                </div>
              </div>
              {st.phase === 'failed' ? (
                <p role="alert" className="mt-2 text-sm text-accent-text">
                  {st.message}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
      {cancelNote}
    </section>
  );
}
