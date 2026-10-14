'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { type Lockup, LockupItem } from '@/components/cross/lockups-panel';
import { getJson } from '@/lib/holder-standing';
import { type SaleCross, saleSentence, saleVenues } from '@/lib/lock-sale';
import type { Signer } from '@/lib/tx';
import type { CrossDetail } from '@/lib/types';
import { shortAddress } from '@/lib/units';

/**
 * Fills of this wallet that are locked (class-2 buyers, class-1 vesting, declared insiders), across crosses, with what has vested and a
 * button to release it. Shown only when the wallet has any. Lockups need the extended cross program, so on a network without it this is
 * empty and nothing is said: there is nothing to release.
 */
export function LockupsSection({ owner, details, sign, onChanged, version }: { owner: string; details: ReadonlyMap<string, CrossDetail>; sign: Signer; onChanged: () => void; version: number }) {
  const [rows, setRows] = useState<Lockup[] | null | undefined>(undefined);
  const [now, setNow] = useState(() => BigInt(Math.floor(Date.now() / 1000)));
  const [crosses, setCrosses] = useState<SaleCross[] | null>(null);
  useEffect(() => {
    let live = true;
    void getJson<{ crosses: SaleCross[] }>('/v1/crosses/summary?limit=1000').then((r) => live && setCrosses(r ? r.crosses : null));
    return () => {
      live = false;
    };
  }, [version]);
  useEffect(() => {
    let live = true;
    void getJson<{ lockups: Lockup[] }>(`/v1/owners/${owner}/lockups`).then((r) => live && setRows(r ? r.lockups : null));
    return () => {
      live = false;
    };
  }, [owner, version]);
  useEffect(() => {
    const t = setInterval(() => setNow(BigInt(Math.floor(Date.now() / 1000))), 1000);
    return () => clearInterval(t);
  }, []);
  if (rows === undefined || (rows !== null && rows.length === 0)) return null;
  const known = (rows ?? []).filter((l) => details.has(l.cross));
  const unknown = (rows ?? []).length - known.length;
  // The tokens a person has locked, once each: V7 sells what is released from them in any open cross of the same token.
  const tokens = [...new Set(known.map((l) => details.get(l.cross)!.baseMint).filter((m): m is string => m !== null))];
  return (
    <section aria-labelledby="locked-h" data-testid="locked-fills">
      <h2 id="locked-h" className="text-xl font-semibold tracking-tight">
        Locked fills
      </h2>
      {rows === null ? (
        <p role="status" className="mt-2 text-sm text-muted">
          Your locked fills could not be read just now.
        </p>
      ) : (
        <>
          <p className="mt-1 text-sm text-muted">A locked fill is paid out of a vault as it vests. Anyone may send the release; the tokens always go to you.</p>
          <ul className="mt-3 space-y-3">
            {known.map((l) => {
              const c = details.get(l.cross)!;
              return (
                <li key={l.order}>
                  <p className="mb-1 text-xs text-muted">
                    <Link href={`/crosses/${c.address}`} className="text-accent-text underline">
                      Cross {shortAddress(c.address)}
                    </Link>
                  </p>
                  <ul>
                    <LockupItem l={l} m={{ priceScale: BigInt(c.grid.priceScale), baseDecimals: c.decimals.base, quoteDecimals: c.decimals.quote }} owner={owner} sign={sign} now={now} onChanged={onChanged} />
                  </ul>
                </li>
              );
            })}
          </ul>
          {tokens.length > 0 ? (
            <div className="mt-4 rounded-[var(--radius-card)] border border-border p-4" data-testid="sell-release">
              <h3 className="text-sm font-medium">Sell what you release</h3>
              <p className="mt-1 text-xs text-muted">A release is an ordinary token in your wallet. To sell it, place a sell order in a cross of the same token: a reopen, or a cross of a recurring series. Every rule of that cross is checked on its own page before your wallet is asked.</p>
              <ul className="mt-2 space-y-2 text-sm">
                {tokens.map((m) => {
                  const venues = crosses === null ? null : saleVenues(crosses, m, Number(now));
                  return (
                    <li key={m} data-testid={`sell-${m}`}>
                      <span className="font-mono text-xs">{shortAddress(m)}</span>:{' '}
                      {venues === null ? (
                        <span className="text-muted">The list of crosses could not be read just now.</span>
                      ) : (
                        <>
                          <span className="text-muted">{saleSentence(venues)}</span>
                          {venues.length > 0 ? (
                            <ul className="mt-1 space-y-1">
                              {venues.slice(0, 5).map((v) => (
                                <li key={v.address}>
                                  <Link href={`/crosses/${v.address}`} className="text-accent-text underline">
                                    Cross {shortAddress(v.address)}
                                  </Link>{' '}
                                  <span className="text-xs text-muted">{v.phase === 'open' ? `takes orders until ${new Date(v.closesAt * 1000).toISOString().replace('T', ' ').slice(0, 16)} UTC` : `opens ${new Date(v.opensAt * 1000).toISOString().replace('T', ' ').slice(0, 16)} UTC`}</span>
                                </li>
                              ))}
                            </ul>
                          ) : null}
                        </>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}
          {unknown > 0 ? <p className="mt-2 text-xs text-muted">{unknown} more locked fill{unknown === 1 ? '' : 's'} sit in crosses that could not be loaded just now.</p> : null}
        </>
      )}
    </section>
  );
}
