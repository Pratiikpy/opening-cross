'use client';

import { isAddress } from '@solana/kit';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Text } from '@/components/issue-wizard/fields';
import { Facts, Pill, Section } from '@/components/issuer/treasury-ui';
import { Failed, FeatureAction, FeatureNotice, Loading, Plain, when } from '@/components/w4/ui';
import { type BountiesRead, type BountyRead, type InvariantsRead, type PayoutsRead, expiryText, fmt, hashReport, isEvidence, who } from '@/lib/bounty';
import { atomsText } from '@/lib/listing';
import { readApi } from '@/lib/new-programs';
import { useMint, useRead } from '@/lib/use-read';
import { useWallet } from '@/lib/wallet';

const WHAT = 'The adversarial bounty';

/** One bounty: its terms, the eleven invariants and what each pays, the claim, the arbiter's award, funding and the sponsor's withdrawal. */
export function BountyView({ address }: { address: string }) {
  // The index is asked first: a bounty that is not in it, or a network without the program, is said in words and not provoked as a 404.
  const index = useRead<BountiesRead>('/v1/bounties?limit=200');
  if (index.phase === 'loading' || index.phase === 'idle') return <Loading what="the bounty" />;
  if (index.phase === 'ok') {
    if (index.data.release.deployed === false) {
      return (
        <div className="space-y-4">
          <FeatureNotice feature="bounty" what={WHAT} />
          <Plain testId="bounty-not-deployed">{index.data.note ?? 'cross_bounty is not deployed on this network, so there is no bounty to read.'}</Plain>
        </div>
      );
    }
    if (index.data.bounties.length < 200 && !index.data.bounties.some((b) => b.bounty === address)) {
      return (
        <div className="space-y-4">
          <FeatureNotice feature="bounty" what={WHAT} />
          <Failed testId="bounty-error">No bounty exists at {address} on this network.</Failed>
        </div>
      );
    }
  }
  return <Bounty address={address} />;
}

function Bounty({ address }: { address: string }) {
  const read = useRead<BountyRead>(`/v1/bounties/${address}`);
  const payouts = useRead<PayoutsRead>(`/v1/bounties/${address}/payouts`);
  const mint = useMint(read.phase === 'ok' ? read.data.rewardMint : null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 10_000);
    return () => clearInterval(t);
  }, []);
  if (read.phase === 'loading' || read.phase === 'idle') return <Loading what="the bounty" />;
  if (read.phase === 'error') return <Failed testId="bounty-error">The bounty could not be read: {read.error}</Failed>;
  const b = read.data;
  const d = mint.info?.decimals ?? null;
  const symbol = mint.info?.symbol ?? '';
  const reload = () => {
    read.reload();
    payouts.reload();
  };
  const expired = b.status === 'expired';
  return (
    <div className="space-y-6" data-testid="bounty-view" data-status={b.status}>
      <FeatureNotice feature="bounty" what={WHAT} />
      <Section id="terms" title="Terms" intro={<p>Fixed when the bounty was created. They never change.</p>}>
        <Facts
          rows={[
            ['Status', <Pill key="s" tone={b.status === 'open' ? 'ok' : 'warn'} testId="bounty-status">{b.status}</Pill>],
            ['Pool', `${fmt(b.pool ?? '0', d)} ${symbol}`.trim()],
            ['Sponsor', who(b.sponsor)],
            ['Arbiter', who(b.arbiter)],
            ['Reward token', who(b.rewardMint)],
            ['Commitment', expiryText(Number(b.expiresAt), now)],
          ]}
        />
        <p className="text-sm text-muted">The sponsor cannot take the pool back before it expires. A reward larger than what the pool holds pays what is left.</p>
      </Section>
      <Section id="invariants" title="What it pays for" intro={<p>Anyone who shows a cross account that breaks one of these pays out automatically. Each invariant pays once. Eleven invariants are not a proof of correctness: a theft path or a rounding exploit with real funds is for the arbiter to judge.</p>}>
        <ol className="space-y-2 text-sm" data-testid="invariant-list">
          {b.invariants.map((i) => (
            <li key={i.invariant} data-covered={i.covered ? 'true' : 'false'} data-paid={i.paid ? 'true' : 'false'} className="flex flex-wrap items-baseline justify-between gap-x-4 rounded-lg border border-border px-3 py-2">
              <span>
                {i.invariant + 1}. {i.name}
              </span>
              <span className="font-mono text-muted">{!i.covered ? 'not covered' : i.paid ? `paid (${fmt(i.reward, d)})` : fmt(i.reward, d)}</span>
            </li>
          ))}
        </ol>
      </Section>
      <Claim b={b} d={d} reload={reload} expired={expired} />
      <Fund b={b} d={d} symbol={symbol} reload={reload} />
      <Award b={b} d={d} reload={reload} expired={expired} />
      <Withdraw b={b} reload={reload} expired={expired} />
      <Section id="payouts" title="Paid so far" intro={<p>Every payout the index has seen, by invariant and by arbiter award.</p>}>
        {payouts.phase === 'ok' && payouts.data.payouts.length === 0 ? <Plain testId="no-payouts">Nothing has been paid yet.</Plain> : null}
        {payouts.phase === 'ok' && payouts.data.payouts.length > 0 ? (
          <ul className="space-y-2 text-sm" data-testid="payouts">
            {payouts.data.payouts.map((p) => (
              <li key={`${p.slot}-${p.recipient}-${p.invariant}`} className="rounded-lg border border-border px-3 py-2">
                {p.kind === 'invariant' ? `Invariant ${(p.invariant ?? 0) + 1}: ${p.invariantName}` : 'Arbiter award'}: {fmt(p.amount, d)} to {who(p.recipient)}
                {p.cross ? (
                  <>
                    {' '}
                    for cross{' '}
                    <Link href={`/crosses/${p.cross}`} className="font-mono underline underline-offset-4">
                      {who(p.cross)}
                    </Link>
                  </>
                ) : null}
                {p.evidence ? <span className="block break-all font-mono text-xs text-muted">report hash {p.evidence}</span> : null}
              </li>
            ))}
          </ul>
        ) : null}
      </Section>
    </div>
  );
}

function Claim({ b, d, reload, expired }: { b: BountyRead; d: number | null; reload: () => void; expired: boolean }) {
  const { account } = useWallet();
  const wallet = account?.address ?? null;
  const [cross, setCross] = useState('');
  const [result, setResult] = useState<{ ok: true; data: InvariantsRead } | { ok: false; error: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const ok = isAddress(cross.trim());
  const check = async () => {
    setBusy(true);
    setResult(null);
    const r = await readApi<InvariantsRead>(`/v1/crosses/${cross.trim()}/invariants`);
    setResult(r.ok ? { ok: true, data: r.data } : { ok: false, error: r.status === 404 ? 'That address is not an Opening Cross account on this network.' : r.error });
    setBusy(false);
  };
  const pays = (i: number) => b.invariants[i];
  return (
    <Section id="claim" title="Claim a reward" intro={<p>Check a cross account against the eleven invariants. If it breaks one this bounty pays and has not paid, you can claim: the reward goes to your wallet.</p>}>
      {expired ? <Plain testId="claim-expired">The bounty has expired: nothing can be claimed any more.</Plain> : null}
      <div className="grid grid-cols-[1fr_auto] items-end gap-3">
        <Text label="Cross address" value={cross} onChange={(v) => { setCross(v); setResult(null); }} error={cross.trim() !== '' && !ok ? 'This is not a Solana address.' : undefined} />
        <button type="button" disabled={!ok || busy} onClick={() => void check()} data-testid="check-cross" className="min-h-11 rounded-full border border-border-strong px-4 py-2 text-sm hover:bg-surface disabled:opacity-50">
          Check it
        </button>
      </div>
      {result && !result.ok ? <Failed testId="check-error">{result.error}</Failed> : null}
      {result && result.ok && result.data.broken.length === 0 ? (
        <Plain testId="check-honest">This cross account breaks none of the eleven invariants right now, so there is nothing to claim. {result.data.note}</Plain>
      ) : null}
      {result && result.ok && result.data.broken.length > 0 ? (
        <ul className="space-y-3" data-testid="broken-list">
          {result.data.broken.map((x) => {
            const row = pays(x.invariant);
            const claimable = !expired && row?.covered && !row.paid;
            return (
              <li key={x.invariant} className="space-y-2 rounded-lg border border-accent p-4 text-sm" data-testid={`broken-${x.invariant}`}>
                <p className="font-medium">
                  This cross breaks invariant {x.invariant + 1}: {x.name}.
                </p>
                <p className="text-muted">{!row?.covered ? 'This bounty does not pay for it.' : row.paid ? 'It was already paid: each invariant pays once.' : expired ? 'The bounty has expired.' : `It pays ${fmt(row.reward, d)} to your wallet.`}</p>
                <div className="max-w-sm">
                  <FeatureAction feature="bounty" what={WHAT} account={account} label={`Claim invariant ${x.invariant + 1}`} testId={`claim-${x.invariant}`} path="/v1/tx/bounty-claim-invariant" body={() => ({ claimant: wallet, bounty: b.bounty, cross: cross.trim(), invariant: x.invariant })} disabled={!claimable} disabledReason={!row?.covered ? 'This bounty does not pay for that invariant.' : row.paid ? 'Already paid.' : 'The bounty has expired.'} onDone={reload} connectHint="Connect the wallet that should receive the reward." />
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
    </Section>
  );
}

function Fund({ b, d, symbol, reload }: { b: BountyRead; d: number | null; symbol: string; reload: () => void }) {
  const { account } = useWallet();
  const [amount, setAmount] = useState('');
  const atoms = atomsText(amount, d);
  return (
    <Section id="fund" title="Add to the pool" intro={<p>Anyone can fund a bounty. The sponsor still cannot withdraw before it expires.</p>}>
      <Text label={`Amount${symbol ? `, in ${symbol}` : ''}`} value={amount} onChange={setAmount} inputMode="decimal" error={amount.trim() !== '' && atoms === null ? `A number above zero with at most ${d ?? 6} decimals.` : undefined} />
      <div className="max-w-sm">
        <FeatureAction feature="bounty" what={WHAT} account={account} label="Fund the bounty" testId="fund-bounty" variant="secondary" path="/v1/tx/bounty-fund" body={() => ({ funder: account?.address, bounty: b.bounty, amount: atoms })} disabled={atoms === null} disabledReason="Enter an amount." onDone={reload} />
      </div>
    </Section>
  );
}

function Award({ b, d, reload, expired }: { b: BountyRead; d: number | null; reload: () => void; expired: boolean }) {
  const { account } = useWallet();
  const wallet = account?.address ?? null;
  const [hunter, setHunter] = useState('');
  const [amount, setAmount] = useState('');
  const [report, setReport] = useState('');
  const [hash, setHash] = useState('');
  useEffect(() => {
    let live = true;
    if (report.trim() === '') setHash('');
    else void hashReport(report).then((h) => live && setHash(h));
    return () => {
      live = false;
    };
  }, [report]);
  if (wallet === null || wallet !== b.arbiter) return null;
  const atoms = atomsText(amount, d);
  const evidence = isEvidence(hash) ? hash : null;
  const off = expired ? 'The bounty has expired: the arbiter awards only before the expiry.' : !isAddress(hunter.trim()) ? 'Name the hunter’s wallet.' : atoms === null ? 'Enter an amount.' : evidence === null ? 'Paste the report; its hash is the evidence.' : undefined;
  return (
    <Section id="award" title="Award for what the chain cannot check" intro={<p>You are this bounty&apos;s arbiter. An award is capped by the pool, only before the expiry, and is public with the hash of the report.</p>}>
      <div className="space-y-3" data-testid="award-box">
        <Text label="Hunter’s wallet" value={hunter} onChange={setHunter} error={hunter.trim() !== '' && !isAddress(hunter.trim()) ? 'This is not a Solana address.' : undefined} />
        <Text label="Amount to award" value={amount} onChange={setAmount} inputMode="decimal" error={amount.trim() !== '' && atoms === null ? 'A number above zero.' : undefined} />
        <div className="text-sm">
          <label className="block">
            <span className="text-muted">The report</span>
            <textarea value={report} onChange={(e) => setReport(e.target.value)} rows={4} className="mt-1 w-full rounded-lg border border-border-strong bg-bg px-3 py-2.5" />
          </label>
          <span className="mt-1 block break-all font-mono text-xs text-muted" data-testid="report-hash">{hash ? `SHA-256: ${hash}` : 'Its SHA-256 is the evidence of the award.'}</span>
        </div>
        <div className="max-w-sm">
          <FeatureAction feature="bounty" what={WHAT} account={account} label="Award" testId="award" path="/v1/tx/bounty-award" body={() => ({ arbiter: wallet, bounty: b.bounty, hunter: hunter.trim(), amount: atoms, evidence })} disabled={Boolean(off)} disabledReason={off} onDone={reload} />
        </div>
      </div>
    </Section>
  );
}

function Withdraw({ b, reload, expired }: { b: BountyRead; reload: () => void; expired: boolean }) {
  const { account } = useWallet();
  if (account?.address !== b.sponsor) return null;
  return (
    <Section id="withdraw" title="Take back what is left" intro={<p>You are this bounty&apos;s sponsor. You can withdraw only after it expires.</p>}>
      <div className="max-w-sm">
        <FeatureAction feature="bounty" what={WHAT} account={account} label="Withdraw the pool" testId="withdraw-bounty" variant="secondary" path="/v1/tx/bounty-withdraw" body={() => ({ sponsor: b.sponsor, bounty: b.bounty })} disabled={!expired} disabledReason={`The pool is committed until ${when(b.expiresAt)}.`} onDone={reload} />
      </div>
    </Section>
  );
}
