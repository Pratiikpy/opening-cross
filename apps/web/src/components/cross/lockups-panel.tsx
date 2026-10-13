'use client';

import { useEffect, useState } from 'react';
import { getJson } from '@/lib/holder-standing';
import { clock } from '@/lib/holder-rules';
import type { Signer } from '@/lib/tx';
import type { CrossDetail } from '@/lib/types';
import { type Market, formatAtoms, formatDuration } from '@/lib/units';
import { ActionButton } from './action-button';

type Lockup = {
  cross: string;
  order: string;
  nonce: string | null;
  amount: string;
  startTs: string;
  cliffSecs: number;
  vestSecs: number;
  unlocksAt: string;
  endsAt: string;
  released: string;
  releasable: string | null;
  state: 'locked' | 'closed' | 'unknown';
};

/**
 * The wallet's locked fills in a cleared cross (class-2 buyers, class-1 vesting and declared insiders): what is locked, when it unlocks and
 * what can be released now. Releasing is a transaction anyone may send, and the tokens always go to the owner.
 */
export function LockupsPanel({ cross, owner, market: m, sign, version, onChanged }: { cross: CrossDetail; owner: string; market: Market; sign: Signer; version: number; onChanged: () => void }) {
  const [rows, setRows] = useState<Lockup[] | null | undefined>(undefined);
  const [now, setNow] = useState(() => BigInt(Math.floor(Date.now() / 1000)));
  useEffect(() => {
    let live = true;
    void getJson<{ lockups: Lockup[] }>(`/v1/owners/${owner}/lockups?cross=${cross.address}`).then((r) => live && setRows(r ? r.lockups : null));
    return () => {
      live = false;
    };
  }, [cross.address, owner, version]);
  useEffect(() => {
    const t = setInterval(() => setNow(BigInt(Math.floor(Date.now() / 1000))), 1000);
    return () => clearInterval(t);
  }, []);
  if (rows === undefined || (rows !== null && rows.length === 0)) return null;
  return (
    <div className="mt-5 border-t border-border pt-4" data-testid="lockups">
      <h3 className="text-sm font-medium">Locked fills</h3>
      {rows === null ? (
        <p role="status" className="mt-2 text-xs text-muted">
          Your locked fills could not be read just now.
        </p>
      ) : (
        <ul className="mt-2 space-y-3">
          {rows.map((l) => (
            <LockupItem key={l.order} l={l} m={m} owner={owner} sign={sign} now={now} onChanged={onChanged} />
          ))}
        </ul>
      )}
    </div>
  );
}

export type { Lockup };

/** One locked fill: what is locked, when it unlocks, and the release button when something has vested. */
export function LockupItem({ l, m, owner, sign, now, onChanged }: { l: Lockup; m: Market; owner: string; sign: Signer; now: bigint; onChanged: () => void }) {

  const unlocks = BigInt(l.unlocksAt);
  const ends = BigInt(l.endsAt);
  const releasable = l.releasable === null ? null : BigInt(l.releasable);
  return (
    <li className="rounded-lg border border-border p-3 text-sm" data-testid="lockup" data-state={l.state}>
      <p className="font-medium">{formatAtoms(BigInt(l.amount), m.baseDecimals)} tokens locked</p>
      <p className="mt-1 text-xs text-muted">
        {now < unlocks ? `Nothing unlocks before ${clock(unlocks)}, in ${formatDuration(unlocks - now)}.` : `The cliff passed at ${clock(unlocks)}.`}{' '}
        {l.vestSecs > 0 ? `Then the rest vests in a straight line until ${clock(ends)}.` : 'Everything unlocks at the cliff.'} Released so far: {formatAtoms(BigInt(l.released), m.baseDecimals)}.
      </p>
      {l.state === 'closed' ? (
        <p className="mt-2 text-xs text-positive">Fully released.</p>
      ) : l.state === 'unknown' || l.nonce === null || releasable === null ? (
        <p className="mt-2 text-xs text-muted">The lockup account could not be read, so nothing is offered for it.</p>
      ) : releasable > 0n ? (
        <div className="mt-3">
          <ActionButton
            label={`Release ${formatAtoms(releasable, m.baseDecimals)} tokens to your wallet`}
            path="/v1/tx/release-locked"
            body={() => ({ cross: l.cross, owner, nonce: l.nonce, payer: owner })}
            sign={sign}
            onDone={onChanged}
            variant="secondary"
            testId="release-locked"
          />
        </div>
      ) : (
        <p className="mt-2 text-xs text-muted">Nothing has vested yet, so there is nothing to release.</p>
      )}
    </li>
  );
}
