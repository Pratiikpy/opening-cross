'use client';

import { isAddress } from '@solana/kit';
import { useState } from 'react';
import { Select, Text } from '@/components/issue-wizard/fields';
import { type ProposalRead, atomsOf, fmt, pctOf, sha256Hex } from '@/lib/issuer-treasury-console';
import { duration, utc } from '@/lib/treasury';
import { shortAddress } from '@/lib/units';
import { WalletAction } from './issuer-action';
import { type Ctx, Facts, NOT_AUTHORITY, NotEnabled, Pill, Section, txPath } from './treasury-ui';

const STATUS: Record<ProposalRead['status'], { tone: 'ok' | 'warn' | 'block' | 'info'; label: string }> = {
  voting: { tone: 'warn', label: 'Voting' },
  failed: { tone: 'block', label: 'Failed' },
  timelock: { tone: 'warn', label: 'Passed, in timelock' },
  executable: { tone: 'ok', label: 'Ready to run' },
  expired: { tone: 'block', label: 'Expired' },
  executed: { tone: 'info', label: 'Executed' },
};

function sentence(p: ProposalRead): string {
  switch (p.status) {
    case 'voting':
      return `Holders can vote until ${utc(p.voteEndsAt)}.`;
    case 'failed':
      return 'The vote ended without reaching the quorum or the majority. Nothing moves, and voters can take their coins back.';
    case 'timelock':
      return `It passed. It waits out its timelock and can be run from ${utc(p.executableAt)}.`;
    case 'executable':
      return `It passed and the timelock is over. Anyone can run it until ${utc(p.expiresAt)}.`;
    case 'expired':
      return `It passed but nobody ran it before ${utc(p.expiresAt)}, so it can no longer be run.`;
    case 'executed':
      return 'It was run.';
  }
}

/** The holder-votes section (`part="votes"`) and the NAV wall section (`part="nav"`) of the console. */
export function TreasuryVotes({ ctx, part }: { ctx: Ctx; part: 'votes' | 'nav' }) {
  if (!ctx.view.ext.extended) return null;
  return part === 'votes' ? <Votes ctx={ctx} /> : <Nav ctx={ctx} />;
}

function Votes({ ctx }: { ctx: Ctx }) {
  const e = ctx.view.ext;
  if (!e.extended) return null;
  const g = e.terms.governance;
  if (!g) {
    return (
      <Section id="votes" title="Holder votes" intro="Holders vote on spending above the allowance.">
        <NotEnabled>This treasury was extended without holder votes, and that cannot be added now.</NotEnabled>
      </Section>
    );
  }
  const proposals = ctx.view.proposals;
  return (
    <Section id="votes" title="Holder votes" intro={`Holders vote on spending above the allowance, or on opening or closing the NAV window. A vote lasts ${duration(g.votePeriodSecs)}, needs ${pctOf(g.quorumBps)} of the coins in circulation to take part and ${pctOf(g.thresholdBps)} of the votes cast, then waits ${duration(g.timelockSecs)} before anyone can run it. Voters’ coins are locked until the vote ends.`}>
      <Facts
        rows={[
          ['Proposals so far', e.live.proposals],
          ['Coins locked in votes', fmt(e.live.votesLocked, ctx.coinDecimals, 'coins')],
          ['A proposal may ask for at most', `${pctOf(g.maxProposalBps)} of the vault`],
          ['A proposer holds at least', `${pctOf(g.proposerMinBps)} of the supply (the authority may always propose)`],
        ]}
      />
      <ProposeForm ctx={ctx} kinds={['spend']} id="propose-spend" heading="Propose a spend" />
      <ul className="space-y-4" aria-label="Proposals" data-testid="proposals">
        {proposals.filter((p) => p.kind === 'spend').length === 0 && ctx.view.unread.every((u) => !u.startsWith('proposals')) ? (
          <li className="text-sm text-muted" data-testid="no-proposals">
            No spend proposal has been made.
          </li>
        ) : null}
        {proposals.filter((p) => p.kind === 'spend').map((p) => (
          <ProposalCard key={p.id} ctx={ctx} p={p} />
        ))}
      </ul>
    </Section>
  );
}

function ProposalCard({ ctx, p }: { ctx: Ctx; p: ProposalRead }) {
  const [amount, setAmount] = useState('');
  const [support, setSupport] = useState('yes');
  const st = STATUS[p.status];
  const coins = amount.trim() === '' ? null : atomsOf(amount, ctx.coinDecimals, 'The vote');
  const title = p.kind === 'spend' ? `Spend ${fmt(p.amount, ctx.quoteDecimals, 'quote')} to ${p.destination ? shortAddress(p.destination) : 'a destination'}` : p.kind === 'open-nav' ? 'Open the NAV window' : 'Close the NAV window';
  return (
    <li className="rounded-lg border border-border p-4" data-testid={`proposal-${p.id}`} data-status={p.status}>
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone={st.tone}>{st.label}</Pill>
        <span className="font-medium">
          #{p.id} {title}
        </span>
      </div>
      <p className="mt-2 text-sm text-muted">{sentence(p)}</p>
      <Facts
        rows={[
          ['Yes', fmt(p.yes, ctx.coinDecimals, 'coins')],
          ['No', fmt(p.no, ctx.coinDecimals, 'coins')],
          ['Quorum needs', fmt(p.quorumNeeded, ctx.coinDecimals, 'coins')],
          ['Proposed by', <span key="p" className="break-all">{p.proposer}</span>],
        ]}
      />
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        {p.status === 'voting' ? (
          <div className="space-y-3 sm:col-span-2" data-testid={`vote-form-${p.id}`}>
            <div className="grid gap-4 sm:grid-cols-2">
              <Text label="Coins to vote with" value={amount} onChange={setAmount} inputMode="decimal" error={coins && !coins.ok ? coins.error : undefined} hint="Locked until the vote ends." />
              <Select label="Vote" value={support} onChange={setSupport} options={[['yes', 'Yes'], ['no', 'No']]} />
            </div>
            <WalletAction
              account={ctx.account}
              label="Vote"
              variant="secondary"
              path={txPath(ctx.address, 'vote')}
              needs="treasury"
              what="Holder votes"
              testId={`vote-${p.id}`}
              disabled={!coins || !coins.ok}
              disabledReason="Enter how many coins to vote with."
              body={() => ({ voter: ctx.account!.address, id: p.id, support: support === 'yes', amount: coins && coins.ok ? coins.atoms : '0' })}
              onDone={() => ctx.reload()}
            />
          </div>
        ) : null}
        {p.status !== 'voting' ? (
          <WalletAction account={ctx.account} label="Take back my locked coins" variant="secondary" path={txPath(ctx.address, 'reclaim-vote')} needs="treasury" what="Holder votes" testId={`reclaim-${p.id}`} body={() => ({ voter: ctx.account!.address, id: p.id })} onDone={() => ctx.reload()} />
        ) : null}
        {p.status === 'executable' ? (
          <WalletAction account={ctx.account} label="Run this proposal" path={txPath(ctx.address, 'execute-proposal')} needs="treasury" what="Holder votes" testId={`execute-${p.id}`} body={() => ({ executor: ctx.account!.address, id: p.id })} onDone={() => ctx.reload()} />
        ) : null}
      </div>
    </li>
  );
}

function ProposeForm({ ctx, kinds, id, heading }: { ctx: Ctx; kinds: ('spend' | 'open-nav' | 'close-nav')[]; id: string; heading: string }) {
  const [kind, setKind] = useState(kinds[0]!);
  const [amount, setAmount] = useState('');
  const [destination, setDestination] = useState('');
  const [why, setWhy] = useState('');
  const spend = kind === 'spend';
  const amt = spend ? atomsOf(amount, ctx.quoteDecimals, 'The amount') : null;
  const destOk = !spend || isAddress(destination.trim());
  const ready = (!spend || (amt?.ok === true && destOk)) && ctx.account !== null;
  const label = spend ? 'Propose this spend' : kind === 'open-nav' ? 'Propose opening the NAV window' : 'Propose closing the NAV window';
  return (
    <div className="space-y-3 rounded-lg border border-border p-4" data-testid={id}>
      <p className="font-medium">{heading}</p>
      {kinds.length > 1 ? <Select label="What holders vote on" value={kind} onChange={(v) => setKind(v as typeof kind)} options={kinds.map((k) => [k, k === 'open-nav' ? 'Open the NAV window' : k === 'close-nav' ? 'Close the NAV window' : 'A spend'] as [string, string])} /> : null}
      {spend ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Text label="Amount, in quote tokens" value={amount} onChange={setAmount} inputMode="decimal" error={amount.trim() !== '' && amt && !amt.ok ? amt.error : undefined} hint="At most the share of the vault the terms allow." />
          <Text label="Destination wallet" value={destination} onChange={setDestination} error={destination.trim() !== '' && !destOk ? 'This is not a Solana address.' : undefined} hint="Fixed when the proposal is made; whoever runs it cannot change it." />
        </div>
      ) : (
        <p className="text-sm text-muted">{kind === 'open-nav' ? 'If it passes, holders who are not insiders can burn coins for their share of the vault, up to the cap in each period.' : 'If it passes, the NAV window closes and redemption at NAV stops.'}</p>
      )}
      <Text label="What this is for (optional)" value={why} onChange={setWhy} mono={false} hint="Only the SHA-256 of this text goes on chain, so holders can check the text you show them against it. Keep the text where holders can read it." />
      <WalletAction
        account={ctx.account}
        label={label}
        variant="secondary"
        path={txPath(ctx.address, 'propose')}
        needs="treasury"
        what="Holder votes"
        testId={`${id}-submit`}
        disabled={!ready}
        disabledReason={!ctx.account ? undefined : 'Fill in the proposal.'}
        body={async () => ({
          proposer: ctx.account!.address,
          kind,
          ...(spend && amt?.ok ? { amount: amt.atoms, destination: destination.trim() } : {}),
          ...(why.trim() ? { descHash: await sha256Hex(why.trim()) } : {}),
        })}
        onDone={() => ctx.reload()}
      />
    </div>
  );
}

function Nav({ ctx }: { ctx: Ctx }) {
  const e = ctx.view.ext;
  if (!e.extended) return null;
  const n = e.terms.nav;
  if (!n) {
    return (
      <Section id="nav" title="NAV wall" intro="Holders redeem coins for their share of the vault.">
        <NotEnabled>This treasury was extended without a NAV window, and that cannot be added now.</NotEnabled>
      </Section>
    );
  }
  const live = e.live;
  const navProposals = ctx.view.proposals.filter((p) => p.kind !== 'spend');
  const cap = live.navPeriod ? (BigInt(live.navPeriod.supplyAtStart) * BigInt(n.capBps)) / 10_000n : null;
  return (
    <Section id="nav" title="NAV wall" intro={`While a NAV window is open, any holder who is not an insider can burn coins for their share of the vault, at the vault divided by the coins in existence. At most ${pctOf(n.capBps)} of the supply can be redeemed in a ${duration(n.periodSecs)} period, so a run on the vault is slowed down. The team and the insiders named at extension cannot redeem. It opens by a holder vote, or when a revenue round is missed.`}>
      <div data-testid="nav-state">
        <Facts
          rows={[
            ['Window', live.navOpen ? 'open' : 'closed'],
            ['This period', live.navPeriod ? `until ${utc(live.navPeriod.endsAt)}` : 'not running'],
            ['Redeemed this period', live.navPeriod ? `${fmt(live.navPeriod.burned, ctx.coinDecimals, 'coins')} of ${cap !== null ? fmt(cap.toString(), ctx.coinDecimals, 'coins') : 'the cap'}` : 'none'],
            ['Missed revenue rounds', String(live.missedRounds)],
          ]}
        />
      </div>
      {e.terms.governance ? (
        <ProposeForm ctx={ctx} kinds={live.navOpen ? ['close-nav', 'open-nav'] : ['open-nav', 'close-nav']} id="propose-nav" heading="Ask holders to open or close the window" />
      ) : (
        <NotEnabled>With no holder votes, this window can open only when a revenue round is missed.</NotEnabled>
      )}
      <ul className="space-y-4" aria-label="NAV proposals" data-testid="nav-proposals">
        {navProposals.map((p) => (
          <ProposalCard key={p.id} ctx={ctx} p={p} />
        ))}
      </ul>
      {!ctx.isAuthority && ctx.account ? <p className="text-xs text-muted">{NOT_AUTHORITY} Proposing is open to the authority and to any holder with enough coins.</p> : null}
    </Section>
  );
}
