'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { type HoldingsData, loadHoldings } from '@/lib/holder-portfolio-load';
import { KIND_LABEL, type CardKind, type RightsCard } from '@/lib/treasury';
import { formatAtoms, shortAddress } from '@/lib/units';
import { useWallet } from '@/lib/wallet';

const ORDER: CardKind[] = ['entitles', 'protects', 'not-provided', 'caveat'];

/** The rights of every ownership coin the connected wallet holds, from what the treasury program enforces. */
export function RightsView() {
  const { account } = useWallet();
  const [state, setState] = useState<{ state: 'idle' } | { state: 'loading' } | { state: 'error' } | { state: 'ready'; data: HoldingsData }>({ state: 'idle' });
  const owner = account?.address ?? null;
  useEffect(() => {
    if (!owner) {
      setState({ state: 'idle' });
      return;
    }
    let live = true;
    setState({ state: 'loading' });
    void loadHoldings(owner).then((d) => live && setState(d ? { state: 'ready', data: d } : { state: 'error' }));
    return () => {
      live = false;
    };
  }, [owner]);

  if (!owner) {
    return (
      <p role="status" className="mt-8 rounded-[var(--radius-card)] border border-border p-5 text-sm text-muted">
        Connect a wallet to see the rights of the ownership coins it holds. To read the rights of any coin without a wallet, open its treasury from the <Link href="/treasury" className="text-accent-text underline">treasuries list</Link>.
      </p>
    );
  }
  if (state.state === 'loading' || state.state === 'idle') return <p role="status" className="mt-8 text-sm text-muted">Reading your holdings…</p>;
  if (state.state === 'error') return <p role="alert" className="mt-8 text-sm text-accent-text">The Opening Cross API could not be reached, so your rights cannot be listed.</p>;
  const withTreasury = state.data.rows.filter((r) => r.treasury);
  if (withTreasury.length === 0) {
    return (
      <div className="mt-8 rounded-[var(--radius-card)] border border-border p-5 text-sm text-muted" data-testid="no-rights">
        <p className="font-medium text-ink">No rights to show</p>
        <p className="mt-1">None of the tokens this wallet holds from crosses has a treasury behind it, so holding them carries no rights beyond owning them. Ownership coins with a treasury are listed under <Link href="/treasury" className="text-accent-text underline">Treasuries</Link>.</p>
      </div>
    );
  }
  return (
    <div className="mt-8 space-y-12">
      {withTreasury.map((r) => {
        const t = r.treasury!;
        return (
          <section key={t.address} id={t.address} aria-labelledby={`h-${t.address}`} data-testid="rights-section">
            <h2 id={`h-${t.address}`} className="text-xl font-semibold tracking-tight">
              Coin {shortAddress(r.mint)} <span className="ml-2 text-sm font-normal text-muted">treasury {shortAddress(t.address)}, {t.state}</span>
            </h2>
            <p className="mt-1 text-sm text-muted">
              You hold {r.held === null ? 'an amount that could not be read' : `${formatAtoms(r.held, r.decimals)} coins`}.{' '}
              {t.entitlement !== null ? `They would redeem for ${formatAtoms(t.entitlement, t.quoteDecimals)} quote right now.` : 'Redemption opens only if the treasury is liquidated.'} <Link href={`/treasury/${t.address}`} className="text-accent-text underline">Open the treasury</Link>
            </p>
            {ORDER.map((kind) => {
              const cards = t.rights.filter((c: RightsCard) => c.kind === kind);
              if (cards.length === 0) return null;
              return (
                <div key={kind} className="mt-5">
                  <h3 className="text-sm font-medium">{kind === 'entitles' ? 'What holding gives you' : KIND_LABEL[kind]}</h3>
                  <ul className="mt-2 divide-y divide-border border-y border-border">
                    {cards.map((c) => (
                      <li key={c.id} className="py-3">
                        <p className="font-medium">{c.title}</p>
                        <p className="mt-1 text-sm text-muted">{c.statement}</p>
                        {c.now ? <p className="mt-1 text-sm">Now: {c.now}</p> : null}
                        {c.absence ? <p className="mt-1 text-xs text-muted">Why: {c.absence}</p> : null}
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </section>
        );
      })}
    </div>
  );
}
