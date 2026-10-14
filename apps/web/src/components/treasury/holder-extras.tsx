'use client';

import { useEffect, useMemo, useState } from 'react';
import { ActionButton } from '@/components/cross/action-button';
import { sha256Hex } from '@/lib/issuer-treasury-console';
import { type ProposalForm, EMPTY_PROPOSAL, buildProposal, proposerStanding } from '@/lib/holder-treasury-extra';
import { formatAtoms, parseAtoms } from '@/lib/units';
import type { Signer } from '@/lib/tx';

const FIELD = 'mt-1 w-full rounded-lg border border-border-strong bg-bg px-3 py-2.5 text-sm';

/**
 * Open a proposal. The authority may always; a holder needs a share of the supply the treasury set. The page says which it is before the wallet is asked,
 * the API checks the same things again (a spend above the cap, a wallet that holds too little), and the program checks them a third time. The
 * description is hashed in the browser: only the hash goes on chain, and holders read the text where the proposer published it.
 */
export function ProposeCard({ treasury, owner, sign, onChanged, held, supply, minBps, isAuthority, coinDecimals, quoteDecimals, hasNav }: { treasury: string; owner: string; sign: Signer; onChanged: () => void; held: bigint; supply: bigint; minBps: number; isAuthority: boolean; coinDecimals: number; quoteDecimals: number | null; hasNav: boolean }) {
  const [f, setF] = useState<ProposalForm>(EMPTY_PROPOSAL);
  const [hash, setHash] = useState<string | null>(null);
  const set = <K extends keyof ProposalForm>(k: K, v: ProposalForm[K]) => setF((x) => ({ ...x, [k]: v }));
  useEffect(() => {
    let live = true;
    setHash(null);
    if (f.description.trim() !== '') void sha256Hex(f.description.trim()).then((h) => live && setHash(h));
    return () => {
      live = false;
    };
  }, [f.description]);
  const standing = proposerStanding(held, supply, minBps, isAuthority, coinDecimals);
  const built = useMemo(() => buildProposal(f, owner, quoteDecimals), [f, owner, quoteDecimals]);
  const touched = f.amount !== '' || f.destination !== '' || f.description !== '';
  return (
    <div className="mt-5 border-t border-border pt-4" data-testid="propose">
      <h4 className="text-sm font-medium">Open a proposal</h4>
      {!standing.ok ? (
        <p className="mt-1 text-sm text-muted" data-testid="propose-standing">
          {standing.message}
        </p>
      ) : (
        <div className="mt-3 max-w-xl space-y-3">
          <label className="block text-sm">
            <span className="text-muted">What for</span>
            <select value={f.kind} onChange={(e) => set('kind', e.target.value as ProposalForm['kind'])} className={FIELD} data-testid="propose-kind">
              <option value="spend">Spend from the vault, above the allowance</option>
              {hasNav ? <option value="open-nav">Open the NAV window</option> : null}
              {hasNav ? <option value="close-nav">Close the NAV window</option> : null}
            </select>
          </label>
          {f.kind === 'spend' ? (
            <>
              <label className="block text-sm">
                <span className="text-muted">Amount, in quote tokens</span>
                <input inputMode="decimal" value={f.amount} onChange={(e) => set('amount', e.target.value)} aria-invalid={Boolean(built.errors.amount) && touched} className={`${FIELD} font-mono`} data-testid="propose-amount" />
                {touched && built.errors.amount ? <span className="mt-1 block text-xs text-accent-text">{built.errors.amount}</span> : <span className="mt-1 block text-xs text-muted">At most the share of the vault the treasury allows in one proposal; the API names the cap if it is over.</span>}
              </label>
              <label className="block text-sm">
                <span className="text-muted">Destination wallet</span>
                <input value={f.destination} onChange={(e) => set('destination', e.target.value)} spellCheck={false} aria-invalid={Boolean(built.errors.destination) && touched} className={`${FIELD} font-mono`} data-testid="propose-destination" />
                {touched && built.errors.destination ? <span className="mt-1 block text-xs text-accent-text">{built.errors.destination}</span> : null}
              </label>
            </>
          ) : (
            <p className="text-sm text-muted">A NAV proposal moves no money and names no destination: it only opens or closes the window in which holders can redeem at NAV.</p>
          )}
          <label className="block text-sm">
            <span className="text-muted">Why (holders read this before they vote)</span>
            <textarea value={f.description} onChange={(e) => set('description', e.target.value)} rows={3} className={FIELD} data-testid="propose-description" />
            {touched && built.errors.description ? <span className="mt-1 block text-xs text-accent-text">{built.errors.description}</span> : hash ? <span className="mt-1 block break-all font-mono text-xs text-muted">SHA-256 recorded on chain: {hash}</span> : null}
          </label>
          <ActionButton label="Open the proposal" path={`/v1/treasuries/${treasury}/tx/propose`} disabled={!built.body || !hash} body={() => ({ ...built.body, descHash: hash })} sign={sign} onDone={onChanged} variant="secondary" testId="propose-submit" />
          <p className="text-xs text-muted">Publish the text of your reasons where holders will see it, with the hash above, so they can check it is what you proposed.</p>
        </div>
      )}
    </div>
  );
}

/** Anyone adds quote tokens to the pot that stakers share: a dividend, a buyback return, a revenue share paid by hand. */
export function DepositCard({ treasury, owner, sign, onChanged, quoteDecimals }: { treasury: string; owner: string; sign: Signer; onChanged: () => void; quoteDecimals: number | null }) {
  const [text, setText] = useState('');
  const amount = text && quoteDecimals !== null ? parseAtoms(text, quoteDecimals) : null;
  const bad = text !== '' && (amount === null || amount === 0n);
  return (
    <div className="space-y-2" data-testid="deposit">
      <label className="block text-sm">
        <span className="text-muted">Add quote tokens to the pot that stakers share</span>
        <input inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)} aria-invalid={bad} className={`${FIELD} font-mono`} placeholder="0" data-testid="deposit-amount" />
      </label>
      {bad && quoteDecimals !== null ? <p className="text-xs text-accent-text">Enter an amount above zero with at most {quoteDecimals} decimal places.</p> : null}
      <p className="text-xs text-muted">Anyone can do this. The tokens are paid out to staked coins in proportion; you get nothing back, and the treasury’s team cannot take them out.</p>
      {amount !== null && amount > 0n && quoteDecimals !== null ? (
        <ActionButton label={`Add ${formatAtoms(amount, quoteDecimals)} quote to the pot`} path={`/v1/treasuries/${treasury}/tx/deposit-distribution`} body={() => ({ depositor: owner, amount: String(amount) })} sign={sign} onDone={onChanged} variant="secondary" testId="deposit-submit" />
      ) : null}
    </div>
  );
}
