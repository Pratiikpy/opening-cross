'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { type Lockup, LockupItem } from '@/components/cross/lockups-panel';
import { getJson } from '@/lib/holder-standing';
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
          {unknown > 0 ? <p className="mt-2 text-xs text-muted">{unknown} more locked fill{unknown === 1 ? '' : 's'} sit in crosses that could not be loaded just now.</p> : null}
        </>
      )}
    </section>
  );
}
