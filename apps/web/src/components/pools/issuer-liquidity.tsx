'use client';

import { isAddress } from '@solana/kit';
import Link from 'next/link';
import { Section } from '@/components/issuer/treasury-ui';
import { Failed, Loading, Plain } from '@/components/w4/ui';
import { useMint, useRead } from '@/lib/use-read';
import { shortAddress } from '@/lib/units';
import { amount, movedText, priceText } from './format';
import { Address, KindPill, StatusPill, Tile } from './parts';
import type { IssuerLiquidity, IssuerPool } from './types';

/**
 * The issuer’s liquidity view of one cross: the pools its market opened, how far each has moved from the clearing price, how deep each is and what is
 * left of the conviction ladder. Read from chain; the issuer console links here for the market of a cleared cross.
 */
export function IssuerLiquidityView({ cross }: { cross: string }) {
  const valid = isAddress(cross);
  const read = useRead<IssuerLiquidity>(valid ? `/v1/pools/by-cross/${cross}` : null);
  if (!valid) return <Failed testId="bad-address">“{cross}” is not a Solana address.</Failed>;
  if (read.phase === 'idle' || read.phase === 'loading') return <Loading what="the cross and its pools from chain" />;
  if (read.phase === 'error') return <Failed testId="issuer-error">{read.status === 404 ? 'There is no Opening Cross account at this address.' : `The liquidity could not be read: ${read.error}`}</Failed>;
  return <Loaded data={read.data} />;
}

function Loaded({ data }: { data: IssuerLiquidity }) {
  const c = data.cross;
  const base = useMint(c.baseMint).info;
  const quote = useMint(c.quoteMint).info;
  const cleared = c.clearingPrice !== null;
  // A cross price is quote atoms per priceScale base atoms; per whole token: price x 10^baseDecimals / priceScale, then in quote units.
  const perToken = cleared && base && quote ? amount((BigInt(c.clearingPrice!) * 10n ** BigInt(base.decimals)) / BigInt(c.priceScale), quote.decimals, 6) : null;
  return (
    <div className="space-y-6" data-testid="issuer-liquidity" data-pools={data.pools.length}>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Tile label="Cross" value={c.state} note={<Address value={c.address} network={data.network} short />} testId="tile-state" />
        <Tile label="Cleared at" value={perToken ?? (cleared ? '…' : 'No price')} note={cleared ? `${quote?.symbol ?? 'quote'} per ${base?.symbol ?? 'base'}` : 'This cross has not printed a price.'} testId="tile-clearing" />
        <Tile label="Pools found" value={String(data.pools.length)} note="at the addresses Opening Cross opens them at" testId="tile-pools" />
      </div>
      {data.note ? <Plain testId="issuer-note">{data.note}</Plain> : null}
      {data.pools.map((p) => (
        <PoolCard key={p.pool} p={p} data={data} baseSymbol={base?.symbol ?? shortAddress(p.baseMint)} quoteSymbol={quote?.symbol ?? shortAddress(p.quoteMint)} bd={base?.decimals ?? null} qd={quote?.decimals ?? null} />
      ))}
      {data.pools.length === 0 && data.absent.length > 0 ? (
        <Section id="absent" title="Where the pools would be" intro={<p>Opening Cross opens a market at fixed addresses. Nothing is there yet.</p>}>
          <ul className="space-y-1 text-sm">
            {data.absent.map((a) => (
              <li key={a.address}>
                {a.kind === 'dlmm' ? 'DLMM pair' : 'DAMM v2 pool'}: <Address value={a.address} network={data.network} />
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      <p className="text-sm">
        <Link href={`/pools/depth/${c.address}`} className="underline underline-offset-4" data-testid="to-depth">
          The cross’s own depth and the price impact of an order
        </Link>
        {' · '}
        <Link href="/pools" className="underline underline-offset-4">
          All pools
        </Link>
      </p>
    </div>
  );
}

function PoolCard({ p, data, baseSymbol, quoteSymbol, bd, qd }: { p: IssuerPool; data: IssuerLiquidity; baseSymbol: string; quoteSymbol: string; bd: number | null; qd: number | null }) {
  const ready = bd !== null && qd !== null;
  return (
    <Section id={`pool-${p.pool}`} title={`${baseSymbol} / ${quoteSymbol}`} intro={<p className="flex flex-wrap items-center gap-2"><KindPill kind={p.kind} /> <StatusPill status={p.status} /> <Address value={p.pool} network={data.network} short /></p>}>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile label="Price now" value={priceText(p.quotePerBase)} note={`${quoteSymbol} per ${baseSymbol}`} testId="pool-price" />
        <Tile label="Moved from clearing" value={movedText(p.movedFromClearingBps)} note={p.movedFromClearingBps === null ? 'the cross printed no price' : 'since the pool was seeded at the clearing price'} testId="pool-moved" />
        <Tile label="Value held" value={ready ? amount(p.tvlInQuote, qd, 2) : '…'} note={quoteSymbol} testId="pool-tvl" />
        <Tile label="Sellable within 1%" value={ready ? amount(p.depthAt100bps.sellBase.maxBaseIn, bd, 2) : '…'} note={ready ? `${baseSymbol}; ${amount(p.depthAt100bps.buyBase.maxQuoteIn, qd, 2)} ${quoteSymbol} buys` : undefined} testId="pool-depth" />
      </div>
      {p.askLadder ? (
        <p className="text-sm" data-testid="pool-ladder">
          {p.askLadder.bins === 0 ? 'No conviction ladder is left above the price: nothing is offered in the bins above the active bin.' : `${ready ? amount(p.askLadder.baseOffered, bd, 2) : '…'} ${baseSymbol} is still offered in ${p.askLadder.bins} bins above the price (bins ${p.askLadder.fromBin} to ${p.askLadder.toBin}). Buyers climb through it at the bin prices; the issuer cannot take it back without Meteora’s own position instructions.`}
        </p>
      ) : null}
      <p className="text-sm">
        <Link href={`/pools/${p.pool}`} className="underline underline-offset-4" data-testid="to-pool">
          Depth, price impact and trading for this pool
        </Link>
      </p>
    </Section>
  );
}
