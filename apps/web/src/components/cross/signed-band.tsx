'use client';

import { useEffect, useState } from 'react';
import { API_URL } from '@/lib/api';
import type { PromiseView } from '@/lib/trust-types';
import { type Market, formatPrice, shortAddress } from '@/lib/units';

const priceOfTick = (g: PromiseView['promise']['subject']['grid'], tick: number): bigint => BigInt(g.minPrice) + BigInt(tick) * BigInt(g.tick);

function outcomeLine(g: NonNullable<PromiseView['grade']>): string | null {
  switch (g.status) {
    case 'HIT':
      return 'The final price landed inside this band.';
    case 'MISS':
      return 'The final price landed outside this band.';
    case 'SCORED':
      return `The final price was ${g.errorTicks} tick${g.errorTicks === 1 ? '' : 's'} from this estimate.`;
    case 'VOID':
      return 'This cross did not print, so the promise is void.';
    default:
      return null;
  }
}

/**
 * The signed price band for a cross. A calibrated band claims a coverage and is graded against the result; a
 * provisional one claims none and says why. Either way the promise is signed, so anyone can check it.
 */
export function SignedBand({ address, market, version }: { address: string; market: Market; version: number }) {
  const [p, setP] = useState<PromiseView | null>(null);
  useEffect(() => {
    let live = true;
    fetch(`${API_URL}/v1/crosses/${address}/promise`, { cache: 'no-store' })
      .then((r) => (r.ok ? (r.json() as Promise<PromiseView>) : null))
      .then((v) => live && setP(v))
      .catch(() => live && setP(null));
    return () => {
      live = false;
    };
  }, [address, version]);
  if (!p) return null;
  const { claim, subject } = p.promise;
  const price = (t: number) => formatPrice(priceOfTick(subject.grid, t), market);
  const calibrated = claim.status === 'CALIBRATED' && claim.nominalCoverageBps !== null;
  const outcome = p.grade ? outcomeLine(p.grade) : null;
  return (
    <section aria-labelledby="band" className="rounded-[var(--radius-card)] border border-border p-5 text-sm" data-testid="signed-band">
      <h2 id="band" className="font-mono text-xs uppercase tracking-widest text-muted">
        Signed price band
      </h2>
      {calibrated ? (
        <p className="mt-2">
          <span className="text-lg font-semibold" data-testid="band-range">
            {price(claim.loTick)} to {price(claim.hiTick)}
          </span>
          <span className="ml-2 text-muted">expected to hold at least {((claim.nominalCoverageBps as number) / 100).toFixed(0)}% of the time</span>
        </p>
      ) : (
        <p className="mt-2">
          <span className="text-lg font-semibold" data-testid="band-range">
            {price(claim.pointTick)}
          </span>
          <span className="ml-2 text-muted">estimate, no coverage claimed yet</span>
        </p>
      )}
      {!calibrated && claim.reason ? <p className="mt-1 text-muted">{claim.reason}</p> : null}
      {outcome ? <p className="mt-2 font-medium">{outcome}</p> : null}
      <p className="mt-3 text-xs text-muted">
        Signed by {shortAddress(p.signer)} · promise {p.promise.id.slice(0, 12)}… ·{' '}
        <a className="text-accent-text underline" href={`${API_URL}/v1/promises/${p.promise.id}`}>
          signed record
        </a>{' '}
        ·{' '}
        <a className="text-accent-text underline" href="/accuracy">
          track record
        </a>
        {p.anchor ? ' · anchored on chain' : ''}
      </p>
    </section>
  );
}
