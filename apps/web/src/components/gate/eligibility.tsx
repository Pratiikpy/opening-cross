'use client';

import { useCallback, useEffect, useState } from 'react';
import { useWallet } from '@/lib/wallet';
import { type Eligibility as EligibilityView, loadEligibility } from '@/lib/gate';
import type { Signer } from '@/lib/tx';
import { shortAddress } from '@/lib/units';
import { ClaimActions } from './claim-actions';
import { ReasonList } from './reason-list';

/**
 * Why the connected wallet can or cannot place an order in a gated cross, rule by rule, with what would satisfy each rule and a button
 * for the step it can take now. Renders nothing for a cross without a gate. Mount it inside the order ticket:
 * `<Eligibility cross={cross.address} gateMint={cross.gateMint} owner={owner} sign={sign} />`.
 */
export function Eligibility({ cross, gateMint, owner, sign }: { cross: string; gateMint: string | null; owner: string; sign: Signer }) {
  const { account } = useWallet();
  const [view, setView] = useState<EligibilityView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    if (!gateMint) return;
    let live = true;
    void loadEligibility(cross, owner).then((r) => {
      if (!live) return;
      if (r.ok) {
        setView(r.data);
        setError(null);
      } else setError(r.error);
    });
    return () => {
      live = false;
    };
  }, [cross, gateMint, owner, version]);

  if (!gateMint) return null;
  return (
    <section aria-labelledby="eligibility" className="rounded-[var(--radius-card)] border border-border p-5 text-sm" data-testid="eligibility">
      <h2 id="eligibility" className="font-mono text-xs uppercase tracking-widest text-muted">
        Who may bid
      </h2>
      <p className="mt-2 text-muted">
        This cross takes orders only from wallets holding a pass for the gate <span className="font-mono text-xs">{shortAddress(gateMint)}</span>.
      </p>
      {error ? (
        <p role="alert" className="mt-3 text-accent-text" data-testid="eligibility-error">
          Eligibility could not be read: {error}
        </p>
      ) : !view ? (
        <p role="status" className="mt-3 text-muted">
          Checking this wallet against the gate…
        </p>
      ) : (
        <>
          <p className={`mt-3 font-medium ${view.eligible ? 'text-positive' : 'text-accent-text'}`} data-testid="eligibility-verdict">
            {view.eligible ? 'This wallet may place an order.' : 'This wallet cannot place an order yet.'}
          </p>
          <div className="mt-1">
            <ReasonList reasons={view.reasons} />
          </div>
          {account && !view.eligible ? (
            <div className="mt-3">
              <ClaimActions mint={gateMint} account={account} sign={sign} claim={view.claim ?? null} sas={view.sas} onChanged={reload} />
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
