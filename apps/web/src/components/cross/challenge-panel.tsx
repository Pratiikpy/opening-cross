'use client';

import { useEffect, useState } from 'react';
import { ReleaseNotice } from '@/components/cross/release-notice';
import type { Programs } from '@/lib/holder-programs';
import { type RulesRead, clock } from '@/lib/holder-rules';
import { getJson } from '@/lib/holder-standing';
import type { Signer } from '@/lib/tx';
import type { CrossDetail } from '@/lib/types';
import { type Market, formatAtoms, formatDuration, shortAddress } from '@/lib/units';
import { ActionButton } from './action-button';

type Challenge = { id: number; challenger: string; subject: string; evidence: string; status: 'Open' | 'Upheld' | 'Rejected' | 'Expired'; slash: string | null };

const STATUS: Record<Challenge['status'], string> = {
  Open: 'Open: the arbiter has not ruled',
  Upheld: 'Upheld: part of the bond was slashed',
  Rejected: 'Rejected: the deposit went to the protocol',
  Expired: 'Expired unanswered: the deposit was returned',
};

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const HEX64 = /^[0-9a-fA-F]{64}$/;

/**
 * The issuer-neutrality window after a clear: the bond the issuer posted behind its list of insiders, the challenges filed, and a form to
 * allege that another wallet was an undeclared insider. A challenge costs a deposit of 0.01 SOL (plus rent) that comes back if it is upheld;
 * the evidence is the hash of a document kept off chain, and the arbiter the protocol names rules on it.
 */
export function ChallengePanel({
  cross,
  rules,
  market: m,
  owner,
  sign,
  version,
  onChanged,
  now,
  programs,
}: {
  cross: CrossDetail;
  rules: RulesRead;
  market: Market;
  owner: string;
  sign: Signer;
  version: number;
  onChanged: () => void;
  now: bigint;
  programs: Programs | null | 'unavailable';
}) {
  const [list, setList] = useState<Challenge[] | null | undefined>(undefined);
  const [subject, setSubject] = useState('');
  const [evidence, setEvidence] = useState('');
  useEffect(() => {
    let live = true;
    void getJson<{ challenges: Challenge[] }>(`/v1/crosses/${cross.address}/challenges`).then((r) => live && setList(r ? r.challenges : null));
    return () => {
      live = false;
    };
  }, [cross.address, version]);
  const n = rules.rules!.neutrality;
  const cleared = rules.state?.clearing ? BigInt(rules.state.clearing.clearedTs) : null;
  const windowEnd = cleared !== null ? cleared + BigInt(n.challengeSecs) : null;
  const open = cross.state === 'Cleared' && windowEnd !== null && now < windowEnd;
  const subjectBad = subject !== '' && !BASE58.test(subject);
  const evidenceBad = evidence !== '' && !HEX64.test(evidence);
  const ready = BASE58.test(subject) && HEX64.test(evidence) && !n.insiders.includes(subject);
  return (
    <div className="mt-5 border-t border-border pt-4" data-testid="challenges">
      <h3 className="text-sm font-medium">Undeclared insiders</h3>
      <p className="mt-1 text-xs text-muted">
        The issuer posted a bond of {formatAtoms(BigInt(n.bondQuote), m.quoteDecimals)} quote behind its list of {n.insiders.length} declared insider{n.insiders.length === 1 ? '' : 's'}.{' '}
        {windowEnd === null ? '' : open ? `Anyone may allege an undeclared insider until ${clock(windowEnd)}, in ${formatDuration(windowEnd - now)}.` : `The challenge window ended ${clock(windowEnd)}.`}
      </p>
      <ReleaseNotice programs={programs} program="crossCore" what="Challenging an insider" />
      {list === undefined ? null : list === null ? (
        <p role="status" className="mt-2 text-xs text-muted">
          The challenges could not be read just now.
        </p>
      ) : list.length === 0 ? (
        <p className="mt-2 text-xs text-muted">No challenge has been filed.</p>
      ) : (
        <ul className="mt-2 space-y-2" data-testid="challenge-list">
          {list.map((c) => (
            <li key={c.id} className="rounded-lg border border-border p-3 text-xs">
              <p className="font-medium">
                Challenge {c.id}: {shortAddress(c.subject)}
              </p>
              <p className="mt-1 text-muted">
                {STATUS[c.status]}. Filed by {shortAddress(c.challenger)}. Evidence hash <span className="break-all font-mono">{c.evidence}</span>
              </p>
              {c.status === 'Open' ? (
                <div className="mt-2">
                  <ActionButton label="Close an unanswered challenge" path="/v1/tx/expire-challenge" body={() => ({ cross: cross.address, id: c.id, payer: owner })} sign={sign} onDone={onChanged} variant="secondary" testId="expire-challenge" />
                  <p className="mt-1 text-muted">Anyone can close a challenge the arbiter has left unanswered for 14 days, so one deposit cannot hold the proceeds back for ever.</p>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {open && programs !== null && programs !== 'unavailable' && programs.programs.crossCore.extended === true ? (
        <div className="mt-3 space-y-3" data-testid="challenge-form">
          <label className="block text-sm">
            <span className="text-muted">Wallet you allege was an undeclared insider</span>
            <input value={subject} onChange={(e) => setSubject(e.target.value.trim())} aria-invalid={subjectBad} className="mt-1 w-full rounded-lg border border-border-strong bg-bg px-3 py-2.5 font-mono text-xs" placeholder="Wallet address" data-testid="challenge-subject" />
          </label>
          {subjectBad ? <p className="text-xs text-accent-text">That is not a wallet address.</p> : n.insiders.includes(subject) ? <p className="text-xs text-accent-text">That wallet is already a declared insider.</p> : null}
          <label className="block text-sm">
            <span className="text-muted">Hash of your evidence (SHA-256, 64 hex characters)</span>
            <input value={evidence} onChange={(e) => setEvidence(e.target.value.trim())} aria-invalid={evidenceBad} className="mt-1 w-full rounded-lg border border-border-strong bg-bg px-3 py-2.5 font-mono text-xs" placeholder="64 hex characters" data-testid="challenge-evidence" />
          </label>
          {evidenceBad ? <p className="text-xs text-accent-text">The hash must be 64 hexadecimal characters.</p> : null}
          <p className="text-xs text-muted">
            A challenge locks a deposit of 0.01 SOL, plus the rent of the challenge record. The deposit comes back if the challenge is upheld; if it is rejected, it goes to the protocol. The evidence itself stays with you: only its hash is recorded on chain.
          </p>
          <ActionButton label="File the challenge" path="/v1/tx/challenge-insider" disabled={!ready} body={() => ({ cross: cross.address, challenger: owner, subject, evidence: evidence.toLowerCase() })} sign={sign} onDone={onChanged} variant="secondary" testId="challenge-insider" />
        </div>
      ) : null}
    </div>
  );
}
