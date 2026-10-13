'use client';

import { isAddress } from '@solana/kit';
import { useEffect, useState } from 'react';
import { Text } from '@/components/issue-wizard/fields';
import { type Position, type RoundRead, atomsOf, fmt, loadPosition, pctOf } from '@/lib/issuer-treasury-console';
import { duration, utc } from '@/lib/treasury';
import { shortAddress } from '@/lib/units';
import { WalletAction } from './issuer-action';
import { type Ctx, Facts, NOT_AUTHORITY, NotEnabled, Pill, Section, txPath } from './treasury-ui';

const ROUND: Record<RoundRead['status'], { tone: 'ok' | 'warn' | 'block' | 'info'; label: string }> = {
  open: { tone: 'info', label: 'Running' },
  'awaiting-payment': { tone: 'warn', label: 'Awaiting payment' },
  late: { tone: 'block', label: 'Late' },
  paid: { tone: 'ok', label: 'Paid' },
  missed: { tone: 'block', label: 'Missed' },
};

/** Distributions to stakers and the revenue rounds. */
export function TreasuryMoney({ ctx }: { ctx: Ctx }) {
  const e = ctx.view.ext;
  if (!e.extended) return null;
  return (
    <>
      <Distributions ctx={ctx} />
      <Revenue ctx={ctx} />
    </>
  );
}

function Distributions({ ctx }: { ctx: Ctx }) {
  const e = ctx.view.ext;
  const [amount, setAmount] = useState('');
  const [pos, setPos] = useState<Position | null>(null);
  const [posError, setPosError] = useState<string | null>(null);
  const wallet = ctx.account?.address;
  useEffect(() => {
    if (!wallet || !e.extended) return;
    let live = true;
    void loadPosition(ctx.address, wallet).then((r) => {
      if (!live) return;
      if (r.ok) {
        setPos(r.data);
        setPosError(null);
      } else setPosError(r.error);
    });
    return () => {
      live = false;
    };
  }, [wallet, ctx.address, e.extended, ctx.view]);
  if (!e.extended) return null;
  const deposit = amount.trim() === '' ? null : atomsOf(amount, ctx.quoteDecimals, 'The deposit');
  const stream = e.terms.distributions.streamSecs;
  return (
    <Section
      id="money"
      title="Distributions to staked coins"
      intro={`Anyone can add quote tokens for holders who stake their coins, and the stakers share them in proportion to what they staked. ${stream === '0' ? 'A deposit is shared at once.' : `A deposit is streamed over ${duration(stream)}, so staking for one block to catch it pays almost nothing.`} Holders opt in by staking, on the holder page.`}
    >
      <Facts
        rows={[
          ['Coins staked', fmt(e.live.totalStaked, ctx.coinDecimals, 'coins')],
          ['Waiting in the stream', e.live.stream ? `${fmt(e.live.stream.remaining, ctx.quoteDecimals, 'quote')} until ${utc(e.live.stream.end)}` : 'nothing'],
          ['Held for stakers', fmt(e.balances.distVault, ctx.quoteDecimals, 'quote')],
        ]}
      />
      <div className="space-y-3 rounded-lg border border-border p-4" data-testid="deposit-form">
        <Text label="Add to the distribution, in quote tokens" value={amount} onChange={setAmount} inputMode="decimal" error={deposit && !deposit.ok ? deposit.error : undefined} hint="Paid from your wallet’s quote token account. It cannot be taken back: it belongs to the stakers." />
        <WalletAction
          account={ctx.account}
          label="Add to the distribution"
          variant="secondary"
          path={txPath(ctx.address, 'deposit-distribution')}
          needs="treasury"
          what="Distributions to stakers"
          testId="deposit-distribution"
          disabled={!deposit || !deposit.ok}
          disabledReason="Enter an amount."
          body={() => ({ depositor: wallet, amount: deposit && deposit.ok ? deposit.atoms : '0' })}
          onDone={() => ctx.reload()}
        />
      </div>
      {wallet ? (
        <div className="space-y-3 rounded-lg border border-border p-4" data-testid="my-position">
          <p className="font-medium">This wallet’s position</p>
          {posError ? (
            <p className="text-sm text-muted">{posError}</p>
          ) : pos ? (
            <Facts rows={[['Holds', fmt(pos.held, ctx.coinDecimals, 'coins')], ['Staked', fmt(pos.staked, ctx.coinDecimals, 'coins')], ['Can claim now', fmt(pos.claimable, ctx.quoteDecimals, 'quote')]]} />
          ) : (
            <p className="text-sm text-muted">Reading…</p>
          )}
          <WalletAction account={ctx.account} label="Claim what is owed" variant="secondary" path={txPath(ctx.address, 'claim-distribution')} needs="treasury" what="Distributions to stakers" testId="claim-distribution" disabled={!pos || pos.claimable === '0'} disabledReason="Nothing to claim yet." body={() => ({ owner: wallet })} onDone={() => ctx.reload()} />
        </div>
      ) : null}
    </Section>
  );
}

function Revenue({ ctx }: { ctx: Ctx }) {
  const e = ctx.view.ext;
  const [destination, setDestination] = useState('');
  if (!e.extended) return null;
  const r = e.terms.revenue;
  if (!r) {
    return (
      <Section id="revenue" title="Revenue rounds" intro="Holders are owed a share of verified revenue.">
        <NotEnabled>This treasury was extended without revenue rounds, and that cannot be added now.</NotEnabled>
      </Section>
    );
  }
  const wallet = ctx.account?.address;
  const rounds = ctx.view.rounds;
  const destOk = isAddress(destination.trim());
  return (
    <Section
      id="revenue"
      title="Revenue rounds"
      intro={`Each round lasts ${duration(r.roundSecs)}. When it ends, the attester you named signs the revenue for it, and you pay ${pctOf(r.shareBps)} of it into the stakers’ pot within ${duration(r.payGraceSecs)}. A round not paid in time can be marked missed by anyone, which opens the NAV window. Nothing is paid on a made-up figure: no attestation, no payment.`}
    >
      <Facts
        rows={[
          ['Share owed to holders', pctOf(r.shareBps)],
          ['Missed so far', String(e.live.missedRounds)],
          ['Current round', e.live.currentRound ?? 'not started'],
          ['Attester', <span key="a" className="break-all">credential {shortAddress(r.credential)}, schema {shortAddress(r.schema)}</span>],
        ]}
      />
      <ul className="space-y-3" aria-label="Revenue rounds" data-testid="rounds">
        {rounds.length === 0 && ctx.view.unread.every((u) => !u.startsWith('revenue')) ? <li className="text-sm text-muted">The first round starts {utc(r.start)}.</li> : null}
        {rounds.map((rd) => {
          const st = ROUND[rd.status];
          const canPay = (rd.status === 'awaiting-payment' || rd.status === 'late') && rd.attested;
          return (
            <li key={rd.round} className="rounded-lg border border-border p-4" data-testid={`round-${rd.round}`} data-status={rd.status}>
              <div className="flex flex-wrap items-center gap-2">
                <Pill tone={st.tone}>{st.label}</Pill>
                <span className="font-medium">Round {rd.round}</span>
                <span className="text-sm text-muted">ends {utc(rd.endsAt)}, pay by {utc(rd.payDeadline)}</span>
              </div>
              <p className="mt-2 text-sm text-muted [overflow-wrap:anywhere]">
                {rd.status === 'paid'
                  ? `Paid: ${fmt(rd.due, ctx.quoteDecimals, 'quote')} on attested revenue of ${fmt(rd.revenue, ctx.quoteDecimals, 'quote')}.`
                  : rd.status === 'missed'
                    ? 'Marked missed. The NAV window opened.'
                    : rd.status === 'open'
                      ? 'The round is still running.'
                      : rd.attested
                        ? 'The attester has signed this round’s revenue. It can be paid.'
                        : `The attester has not signed this round’s revenue yet. It must sign the attestation at ${rd.attestation} before it can be paid.`}
              </p>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                {rd.status === 'awaiting-payment' || rd.status === 'late' ? (
                  <WalletAction account={ctx.account} label={`Pay round ${rd.round}`} path={txPath(ctx.address, 'pay-round')} needs="treasury" what="Revenue rounds" testId={`pay-round-${rd.round}`} disabled={!canPay} disabledReason="Waiting for the attester to sign this round’s revenue." body={() => ({ payer: wallet, round: rd.round })} onDone={() => ctx.reload()} />
                ) : null}
                {rd.status === 'late' ? (
                  <WalletAction account={ctx.account} label={`Mark round ${rd.round} missed`} variant="secondary" path={txPath(ctx.address, 'mark-missed')} needs="treasury" what="Revenue rounds" testId={`mark-missed-${rd.round}`} body={() => ({ caller: wallet, round: rd.round })} onDone={() => ctx.reload()} />
                ) : null}
                {rd.status === 'paid' && r.trancheAmount !== '0' && rd.trancheReleased === false ? (
                  <div className="space-y-2 sm:col-span-2">
                    <Text label="Release the tranche to" value={destination} onChange={setDestination} error={destination.trim() !== '' && !destOk ? 'This is not a Solana address.' : undefined} hint={`${fmt(r.trancheAmount, ctx.quoteDecimals, 'quote')} for a round that reached ${fmt(r.trancheMinRevenue, ctx.quoteDecimals, 'quote')} of revenue.`} />
                    <WalletAction
                      account={ctx.account}
                      label={`Release the tranche for round ${rd.round}`}
                      variant="secondary"
                      path={txPath(ctx.address, 'release-tranche')}
                      needs="treasury"
                      what="Revenue rounds"
                      testId={`release-tranche-${rd.round}`}
                      disabled={!destOk || !ctx.isAuthority}
                      disabledReason={!ctx.isAuthority ? NOT_AUTHORITY : 'Enter the destination.'}
                      body={() => ({ authority: wallet, round: rd.round, destination: destination.trim() })}
                      onDone={() => ctx.reload()}
                    />
                  </div>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}
