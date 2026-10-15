'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Text } from '@/components/issue-wizard/fields';
import { Pill, Section } from '@/components/issuer/treasury-ui';
import { Failed, FeatureAction, FeatureNotice, Loading, Plain } from '@/components/w4/ui';
import { type BasketComponent, type BasketRead, type BasketsRead, type QuoteLine, type QuoteRead, SHARE_DECIMALS, sharesAtoms } from '@/lib/baskets';
import { readHeld } from '@/lib/series-load';
import { useMint, useRead } from '@/lib/use-read';
import { formatAtoms, shortAddress } from '@/lib/units';
import { useWallet } from '@/lib/wallet';

const WHAT = 'Basket tokens';
const SPL = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

export function BasketView({ address }: { address: string }) {
  // The index is asked first: a basket that is not in it, or a network without the program, is said in words and not provoked as a 404.
  const index = useRead<BasketsRead>('/v1/baskets?limit=200');
  if (index.phase === 'loading' || index.phase === 'idle') return <Loading what="the basket" />;
  if (index.phase === 'ok') {
    if (index.data.release.deployed === false) {
      return (
        <div className="space-y-4">
          <FeatureNotice feature="baskets" what={WHAT} />
          <Plain testId="basket-not-deployed">{index.data.note ?? 'cross_basket is not deployed on this network, so there is no basket to read.'}</Plain>
        </div>
      );
    }
    if (index.data.baskets.length < 200 && !index.data.baskets.some((b) => b.basket === address)) {
      return (
        <div className="space-y-4">
          <FeatureNotice feature="baskets" what={WHAT} />
          <Failed testId="basket-error">No basket is known at {address} on this network.</Failed>
        </div>
      );
    }
  }
  return <Basket address={address} />;
}

function Basket({ address }: { address: string }) {
  const read = useRead<BasketRead>(`/v1/baskets/${address}`);
  if (read.phase === 'loading' || read.phase === 'idle') return <Loading what="the basket" />;
  if (read.phase === 'error') return <Failed testId="basket-error">The basket could not be read: {read.error}</Failed>;
  const b = read.data;
  return (
    <div className="space-y-6" data-testid="basket-view" data-solvent={String(b.solvent)}>
      <FeatureNotice feature="baskets" what={WHAT} />
      <Section id="parts" title={`${b.label}: what one share is`} intro={<p>One whole share is exactly the amounts below, so its worth is the sum of its parts. A donation to a vault changes nothing about the price of a share.</p>}>
        <p className="flex flex-wrap items-center gap-2 text-sm">
          <Pill tone={b.solvent === true ? 'ok' : b.solvent === false ? 'block' : 'info'} testId="solvent">{b.solvent === true ? 'Every vault covers the shares outstanding' : b.solvent === false ? 'A vault is short of the shares outstanding' : 'Solvency could not be read'}</Pill>
          <span className="text-muted">Shares outstanding: {b.shareSupply === null ? 'unknown' : formatAtoms(BigInt(b.shareSupply), SHARE_DECIMALS)}. Created by {shortAddress(b.creator)}. Share token {shortAddress(b.shareMint)}.</span>
        </p>
        <ul className="space-y-3" data-testid="components">
          {b.components.map((c) => (
            <Component key={c.mint} c={c} />
          ))}
        </ul>
        <p className="text-xs text-muted" data-testid="basket-rules">
          There is no manager, fee, rebalance or pause, and a basket never changes. Minting rounds each deposit up and redeeming rounds each payout down, so rounding always favours the basket. After every mint and every redemption the program checks that each vault covers what the shares outstanding are owed.
        </p>
      </Section>
      <Trade b={b} reload={read.reload} />
    </div>
  );
}

function Component({ c }: { c: BasketComponent }) {
  const mint = useMint(c.mint);
  const d = mint.info?.decimals ?? null;
  const fmt = (a: string | null) => (a === null ? 'unknown' : d === null ? a : formatAtoms(BigInt(a), d));
  return (
    <li className="rounded-lg border border-border p-4 text-sm" data-testid={`component-${c.mint}`}>
      <p className="font-medium">{mint.info?.symbol ?? shortAddress(c.mint)}</p>
      <p className="mt-1 text-muted">
        {fmt(c.unitsPerShare)} per share. The vault holds {fmt(c.balance)}, which is {fmt(c.backingPerShare)} behind one share{c.covers === false ? ' (short)' : ''}.
      </p>
      {mint.info?.freezeAuthority ? (
        <p className="mt-1 text-accent-text" data-testid={`freeze-${c.mint}`}>
          This token&apos;s issuer can freeze accounts ({shortAddress(mint.info.freezeAuthority)}). It could freeze this basket&apos;s vault and stop redemptions of this component; the program cannot remove that.
        </p>
      ) : null}
    </li>
  );
}

function Trade({ b, reload }: { b: BasketRead; reload: () => void }) {
  const { account } = useWallet();
  const wallet = account?.address ?? null;
  const [shares, setShares] = useState('');
  const atoms = sharesAtoms(shares);
  const [side, setSide] = useState<'mint' | 'redeem'>('mint');
  const quote = useRead<QuoteRead>(atoms ? `/v1/baskets/${b.basket}/quote?shares=${atoms}&side=${side}` : null);
  const [rev, setRev] = useState(0);
  const [heldShares, setHeldShares] = useState<bigint | null>(null);
  useEffect(() => {
    if (!wallet) return setHeldShares(null);
    let live = true;
    void readHeld(wallet, b.shareMint, SPL).then((r) => live && setHeldShares(r.ok ? r.amount : null));
    return () => {
      live = false;
    };
  }, [wallet, b.shareMint, rev]);
  const lines = quote.phase === 'ok' ? quote.data.lines : [];
  const done = () => {
    setRev((r) => r + 1);
    reload();
  };
  return (
    <Section id="trade" title="Mint or redeem shares" intro={<p>Mint by depositing each component; redeem by burning shares for each component. The quote below is exactly what the transaction moves.</p>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Text label="Shares" value={shares} onChange={setShares} inputMode="decimal" error={shares.trim() !== '' && atoms === null ? 'A number of shares above zero with at most 6 decimals.' : undefined} hint={heldShares !== null ? `You hold ${formatAtoms(heldShares, SHARE_DECIMALS)} shares.` : undefined} />
        <div className="text-sm">
          <span className="text-muted">Direction</span>
          <div className="mt-1 flex gap-2" role="group" aria-label="Direction">
            {(['mint', 'redeem'] as const).map((s) => (
              <button key={s} type="button" aria-pressed={side === s} onClick={() => setSide(s)} data-testid={`side-${s}`} className={`min-h-11 flex-1 rounded-full border px-4 py-2 text-sm ${side === s ? 'border-accent' : 'border-border-strong'}`}>
                {s === 'mint' ? 'Mint' : 'Redeem'}
              </button>
            ))}
          </div>
        </div>
      </div>
      {quote.phase === 'ok' ? (
        <div data-testid="quote" data-side={quote.data.side}>
          <p className="text-sm font-medium">{side === 'mint' ? 'You deposit' : 'You receive'}</p>
          <ul className="mt-1 space-y-1 text-sm">
            {lines.map((l) => (
              <QuoteItem key={l.mint} l={l} wallet={wallet} side={side} rev={rev} />
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted">{side === 'mint' ? 'Each deposit is rounded up to the next whole atom.' : 'Each payout is rounded down to the whole atoms below the exact amount.'}</p>
        </div>
      ) : null}
      {quote.phase === 'error' ? <Failed testId="quote-error">{quote.error}</Failed> : null}
      <div className="max-w-sm">
        <FeatureAction
          feature="baskets"
          what={WHAT}
          account={account}
          label={side === 'mint' ? 'Mint the shares' : 'Redeem the shares'}
          testId={side === 'mint' ? 'basket-mint' : 'basket-redeem'}
          path={side === 'mint' ? '/v1/tx/basket-mint' : '/v1/tx/basket-redeem'}
          body={() => ({ user: wallet, basket: b.basket, shares: atoms?.toString() })}
          disabled={atoms === null || (side === 'redeem' && heldShares !== null && atoms > heldShares)}
          disabledReason={atoms === null ? 'Enter a number of shares.' : `You hold ${formatAtoms(heldShares ?? 0n, SHARE_DECIMALS)} shares.`}
          onDone={done}
        />
      </div>
      {side === 'mint' ? <p className="text-xs text-muted">A basket of more than about five components may need an address lookup table to fit one transaction; the API refuses a transaction that does not fit and says so.</p> : null}
      <p className="text-xs text-muted">
        <Link href="/baskets" className="underline underline-offset-4">All baskets</Link>
      </p>
    </Section>
  );
}

function QuoteItem({ l, wallet, side, rev }: { l: QuoteLine; wallet: string | null; side: 'mint' | 'redeem'; rev: number }) {
  const mint = useMint(l.mint);
  const [held, setHeld] = useState<bigint | null>(null);
  useEffect(() => {
    if (!wallet || !mint.info || side !== 'mint') return setHeld(null);
    let live = true;
    void readHeld(wallet, l.mint, mint.info.program).then((r) => live && setHeld(r.ok ? r.amount : null));
    return () => {
      live = false;
    };
  }, [wallet, mint.info, l.mint, side, rev]);
  const d = mint.info?.decimals ?? null;
  const short = held !== null && BigInt(l.amount) > held;
  return (
    <li data-testid={`line-${l.mint}`} data-exact={l.exact ? 'true' : 'false'}>
      {d === null ? l.amount : formatAtoms(BigInt(l.amount), d)} {mint.info?.symbol ?? shortAddress(l.mint)}
      {l.exact ? '' : ' (rounded)'}
      {held !== null ? <span className={short ? ' text-accent-text' : ' text-muted'}> · you hold {d === null ? held.toString() : formatAtoms(held, d)}{short ? ': not enough' : ''}</span> : null}
    </li>
  );
}
