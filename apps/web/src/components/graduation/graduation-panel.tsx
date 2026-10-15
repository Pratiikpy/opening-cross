'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { Text } from '@/components/issue-wizard/fields';
import { Facts, Pill, Section } from '@/components/issuer/treasury-ui';
import { Failed, FeatureAction, FeatureNotice, Loading, Plain, when } from '@/components/w4/ui';
import {
  type GraduationRead,
  type RoundRead,
  type VoteRead,
  VENUES,
  bpsText,
  buildVote,
  creatorStep,
  currentRound,
  humanLeft,
  roundLine,
  shareOf,
  shortfallText,
  venueLabel,
} from '@/lib/graduation';
import { readHeld } from '@/lib/series-load';
import { useMint, useRead } from '@/lib/use-read';
import { formatAtoms, parseAtoms, shortAddress } from '@/lib/units';
import { useWallet } from '@/lib/wallet';

const PATH = '/v1/tx';

/**
 * The graduation tab of a cross that set the governed-graduation rule: the charter the creator fixed, every round with its tally, the vote, finalizing, the
 * outcome, and what the outcome unlocks. Everything is read from GET /v1/crosses/:address/graduation. A cluster without cross_graduate says so and offers no vote.
 */
export function GraduationPanel({ cross, baseMint, baseDecimals, quoteDecimals, creator }: { cross: string; baseMint: string | null; baseDecimals: number; quoteDecimals: number; creator: string }) {
  const read = useRead<GraduationRead>(`/v1/crosses/${cross}/graduation`);
  const { account } = useWallet();
  const wallet = account?.address ?? null;
  const mint = useMint(baseMint);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);

  if (read.phase === 'loading' || read.phase === 'idle') return <Loading what="the graduation vote" />;
  if (read.phase === 'error') return <Failed>The graduation vote could not be read: {read.error}</Failed>;
  const g = read.data;
  const round = currentRound(g);
  const decimals = mint.info?.decimals ?? baseDecimals;
  const step = creatorStep(g);
  const notDeployed = g.release.deployed === false;
  return (
    <div className="space-y-6" data-testid="graduation-panel" data-governed={g.governed ? 'true' : 'false'}>
      <FeatureNotice feature="governedGraduation" what="Graduation by holder vote" />
      {!g.governed ? (
        <Plain testId="graduation-ungoverned">{g.note ?? 'This cross did not set the governed-graduation rule, so its market is opened without a vote.'}</Plain>
      ) : (
        <>
          <p className="text-sm text-muted" data-testid="graduation-intro">
            The creator of this cross set the governed-graduation rule before the first order. Its market can open only on the venue its holders vote for: a pool on any other venue, or before a vote passes, is refused by the settlement program. The vote counts tokens that are locked until it ends, never a price or a market cap.
          </p>
          {g.note ? <Plain testId="graduation-note">{g.note}</Plain> : null}
          {g.outcome ? <OutcomeBanner g={g} creator={creator} wallet={wallet} cross={cross} /> : null}
          {g.charter ? <Charter g={g} quoteDecimals={quoteDecimals} /> : notDeployed ? null : <Plain testId="no-charter">{step === 'no-charter' ? 'The creator has not set the charter, so no vote can run.' : ''}</Plain>}
          {mint.info?.mintAuthority && g.charter ? (
            <Plain testId="mint-authority-warning">
              The token still has a mint authority ({shortAddress(mint.info.mintAuthority)}). It can raise the supply while a round is open, and with it the quorum, which would defeat a vote: a quorum is measured against the live supply when the round is finalized.
            </Plain>
          ) : null}
          {(g.rounds ?? []).map((r) => (
            <RoundCard key={r.round} r={r} now={now} decimals={decimals} quoteDecimals={quoteDecimals} lockedTotalLabel={formatAtoms(BigInt(r.lockedTotal), decimals)} />
          ))}
          {round && g.charter && !notDeployed ? <HolderActions g={g} round={round} wallet={wallet} cross={cross} baseMint={baseMint} decimals={decimals} program={mint.info?.program ?? null} reload={read.reload} quoteDecimals={quoteDecimals} /> : null}
          {g.charter && wallet === g.charter.creator && !notDeployed ? (
            <p className="text-sm text-muted" data-testid="creator-link">
              You created this cross. <Link href={`/issuer/graduation?cross=${cross}`} className="underline underline-offset-4">Manage the charter and the rounds</Link>.
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

function OutcomeBanner({ g, creator, wallet, cross }: { g: GraduationRead; creator: string; wallet: string | null; cross: string }) {
  const o = g.outcome!;
  return (
    <div className="rounded-[var(--radius-card)] border border-positive p-4" data-testid="graduation-outcome" data-venue={o.venue}>
      <p className="font-medium text-positive">Holders chose {venueLabel(o.venue)}</p>
      <p className="mt-1 text-sm text-muted">
        Round {o.round + 1} passed and its outcome was published on {when(o.publishedTs)}. The settlement program now opens this cross&apos;s market on {venueLabel(o.venue)} and on no other venue.{' '}
        {wallet === creator ? (
          <>
            You created this cross: <Link href={`/issuer/settle?cross=${cross}`} className="underline underline-offset-4">open the market</Link>.
          </>
        ) : (
          'The creator still has to supply the liquidity and send the transaction; the vote chooses the venue, not the amount.'
        )}
      </p>
    </div>
  );
}

function Charter({ g, quoteDecimals }: { g: GraduationRead; quoteDecimals: number }) {
  const c = g.charter!;
  const days = Number(c.windowSecs) / 86_400;
  return (
    <Section id="charter" title="The charter" intro={<p>Fixed by the creator before the first order. It never changes.</p>}>
      <Facts
        rows={[
          ['Quorum', `${bpsText(c.quorumBps)} of the live supply must be locked`],
          ['Voting window', `${Number.isInteger(days) ? days : days.toFixed(2)} days per round`],
          ['Organic volume', BigInt(c.minVolume) > 0n ? `at least ${formatAtoms(BigInt(c.minVolume), quoteDecimals)} quote tokens, attested by ${shortAddress(c.volumeAttester ?? '')}` : 'no volume gate'],
          ['Rounds', `${c.roundsUsed} used, ${c.roundsLeft} left of 3`],
        ]}
      />
      <p className="text-xs text-muted">
        Organic volume is a figure the attester states: the program cannot measure it, so a charter with an attester is as honest as that attester. {c.volumeAttester ? '' : 'This charter has no volume gate.'}
      </p>
    </Section>
  );
}

const STATUS_TONE = { voting: 'ok', 'awaiting-finalize': 'warn', passed: 'ok', failed: 'block' } as const;
const STATUS_LABEL = { voting: 'Voting', 'awaiting-finalize': 'Waiting to be finalized', passed: 'Passed', failed: 'Failed' } as const;

function RoundCard({ r, now, decimals, quoteDecimals, lockedTotalLabel }: { r: RoundRead; now: number; decimals: number; quoteDecimals: number; lockedTotalLabel: string }) {
  const short = r.status === 'voting' || r.status === 'awaiting-finalize' || r.status === 'failed' ? shortfallText(r, decimals) : [];
  return (
    <Section
      id={`round-${r.index}`}
      title={`Round ${r.index + 1}`}
      intro={
        <p data-testid={`round-${r.index}-line`}>
          <Pill tone={STATUS_TONE[r.status]} testId={`round-${r.index}-status`}>
            {STATUS_LABEL[r.status]}
          </Pill>{' '}
          {roundLine(r, now)}
        </p>
      }
    >
      <ul className="space-y-3" aria-label={`Tokens locked behind each venue, round ${r.index + 1}`} data-testid={`round-${r.index}-tallies`}>
        {r.tallies.map((t) => {
          const pct = shareOf(t, r.lockedTotal);
          return (
            <li key={t.venue} data-venue={t.venue} data-locked={t.locked} className="text-sm">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4">
                <span className={r.winner === t.venue ? 'font-medium text-positive' : ''}>{venueLabel(t.venue)}{r.winner === t.venue ? ' (winner)' : ''}</span>
                <span className="font-mono text-muted">
                  {formatAtoms(BigInt(t.locked), decimals)} · {pct}%
                </span>
              </div>
              <div className="mt-1 h-2 overflow-hidden rounded-full bg-surface-2" aria-hidden="true">
                <div className="h-full rounded-full bg-accent-fill" style={{ width: `${pct}%` }} />
              </div>
            </li>
          );
        })}
      </ul>
      <Facts
        rows={[
          ['Locked in total', lockedTotalLabel],
          ['Quorum needed', r.quorumNeeded === null ? 'not known (the supply could not be read)' : `${formatAtoms(BigInt(r.quorumNeeded), decimals)} (${bpsText(r.quorumBps)} of the live supply)`],
          ['Organic volume', BigInt(r.volume.required) > 0n ? `${r.volume.posted === null ? 'none attested yet' : formatAtoms(BigInt(r.volume.posted), quoteDecimals)} of ${formatAtoms(BigInt(r.volume.required), quoteDecimals)} required` : 'not required'],
          ['Closes', `${when(r.closesTs)}${r.status === 'voting' ? ` (${humanLeft(Number(r.closesTs) - now)} left)` : ''}`],
        ]}
      />
      {short.length > 0 ? (
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted" data-testid={`round-${r.index}-short`}>
          {short.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ul>
      ) : null}
    </Section>
  );
}

function HolderActions({ g, round, wallet, cross, baseMint, decimals, program, reload, quoteDecimals }: { g: GraduationRead; round: RoundRead; wallet: string | null; cross: string; baseMint: string | null; decimals: number; program: string | null; reload: () => void; quoteDecimals: number }) {
  const { account } = useWallet();
  const voteRead = useRead<VoteRead>(wallet ? `/v1/graduation/rounds/${round.round}?voter=${wallet}` : null);
  const [held, setHeld] = useState<bigint | null>(null);
  const [form, setForm] = useState({ venue: '', amount: '' });
  const [done, setDone] = useState<string | null>(null);
  useEffect(() => {
    if (!wallet || !baseMint || !program) {
      setHeld(null);
      return;
    }
    let live = true;
    void readHeld(wallet, baseMint, program).then((r) => live && setHeld(r.ok ? r.amount : null));
    return () => {
      live = false;
    };
  }, [wallet, baseMint, program, done]);
  const mine = voteRead.phase === 'ok' ? voteRead.data.vote : undefined;
  const lockedVenue = mine && BigInt(mine.locked) > 0n ? (mine.venue ?? null) : null;
  useEffect(() => {
    if (lockedVenue) setForm((f) => (f.venue === lockedVenue ? f : { ...f, venue: lockedVenue }));
  }, [lockedVenue]);
  const checked = useMemo(() => buildVote(form, wallet, cross, round.index, decimals, held, lockedVenue), [form, wallet, cross, round.index, decimals, held, lockedVenue]);
  const after = () => {
    setDone(String(Date.now()));
    reload();
    voteRead.reload();
  };
  const voting = round.status === 'voting';
  const needsFinalize = round.status === 'awaiting-finalize';
  const publish = g.charter?.passed === true && !g.outcome;
  const isAttester = wallet !== null && round.volume.attester === wallet;
  const canWithdraw = mine !== undefined && BigInt(mine.locked) > 0n && round.status !== 'voting';
  const [vol, setVol] = useState('');
  return (
    <Section id="actions" title="What you can do" intro={<p>Each action is a transaction your wallet signs. Nothing happens until you approve it.</p>}>
      {voting ? (
        <div className="space-y-4" data-testid="vote-box">
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Lock tokens behind a venue</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {VENUES.map((v) => {
                const off = lockedVenue !== null && lockedVenue !== v;
                return (
                  <label key={v} className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm ${form.venue === v ? 'border-accent' : 'border-border-strong'} ${off ? 'opacity-50' : ''}`}>
                    <input type="radio" name="venue" value={v} checked={form.venue === v} disabled={off} onChange={() => setForm((f) => ({ ...f, venue: v }))} data-testid={`venue-${v}`} />
                    {venueLabel(v)}
                  </label>
                );
              })}
            </div>
            {checked.errors.venue ? <p className="text-xs text-accent-text" data-testid="venue-error">{checked.errors.venue}</p> : null}
          </fieldset>
          {mine && BigInt(mine.locked) > 0n ? (
            <p className="text-sm text-muted" data-testid="my-lock">
              You have {formatAtoms(BigInt(mine.locked), decimals)} locked behind {venueLabel(mine.venue)} until {when(mine.unlocksAt ?? round.closesTs)}. You can add to it; you cannot change venue.
            </p>
          ) : null}
          <Text label={`Tokens to lock${held !== null ? ` (you hold ${formatAtoms(held, decimals)})` : ''}`} value={form.amount} onChange={(v) => setForm((f) => ({ ...f, amount: v }))} inputMode="decimal" error={form.amount === '' ? undefined : checked.errors.amount} hint="They are locked in the round's escrow until the window closes. You cannot sell or move them before." />
          <FeatureAction
            feature="governedGraduation"
            what="Graduation by holder vote"
            account={account}
            label="Lock tokens and vote"
            testId="cast-vote"
            path={`${PATH}/graduate-cast-vote`}
            body={() => checked.body}
            disabled={checked.body === null}
            disabledReason={checked.body === null ? (checked.errors.venue ?? checked.errors.amount ?? 'Choose a venue and an amount.') : undefined}
            connectHint="Connect the wallet that holds the token to vote."
            onDone={after}
          />
        </div>
      ) : null}
      {isAttester && round.status !== 'passed' && round.status !== 'failed' ? (
        <div className="space-y-3" data-testid="volume-box">
          <p className="text-sm font-medium">You are this charter&apos;s volume attester</p>
          <Text label="Organic volume to state, in quote tokens" value={vol} onChange={setVol} inputMode="decimal" hint="The program cannot measure volume; the figure you state is the one the vote uses. The latest statement counts." />
          <FeatureAction feature="governedGraduation" what="Graduation by holder vote" account={account} label="Post the volume" testId="post-volume" path={`${PATH}/graduate-post-volume`} body={() => ({ attester: wallet, cross, round: round.index, volumeQuote: toAtoms(vol, quoteDecimals) })} disabled={toAtoms(vol, quoteDecimals) === null} disabledReason="A number of quote tokens above zero, within the quote token’s decimals." onDone={after} />
        </div>
      ) : null}
      {needsFinalize ? (
        <div className="space-y-2" data-testid="finalize-box">
          <p className="text-sm text-muted">The window has closed. Finalizing is open to anyone and decides the round from the tally: it passes only with the quorum, a strict majority for one venue and, if the charter asks, the attested volume.</p>
          <FeatureAction feature="governedGraduation" what="Graduation by holder vote" account={account} label="Finalize the round" testId="finalize-round" path={`${PATH}/graduate-finalize-round`} body={() => ({ payer: wallet, cross, round: round.index })} onDone={after} connectHint="Connect any wallet to finalize." />
        </div>
      ) : null}
      {publish ? (
        <div className="space-y-2" data-testid="publish-box">
          <p className="text-sm text-muted">A round passed. Publishing its outcome is open to anyone and writes the account the settlement program reads before it opens a pool.</p>
          <FeatureAction feature="governedGraduation" what="Graduation by holder vote" account={account} label="Publish the outcome" testId="publish-outcome" path={`${PATH}/graduate-publish-outcome`} body={() => ({ payer: wallet, cross, round: passedIndex(g) })} onDone={after} connectHint="Connect any wallet to publish." />
        </div>
      ) : null}
      {canWithdraw ? (
        <div className="space-y-2" data-testid="withdraw-box">
          <p className="text-sm text-muted">The window is over. You have {formatAtoms(BigInt(mine!.locked), decimals)} still locked in this round&apos;s escrow.</p>
          <FeatureAction feature="governedGraduation" what="Graduation by holder vote" account={account} label="Take my tokens back" testId="withdraw-vote" variant="secondary" path={`${PATH}/graduate-withdraw-vote`} body={() => ({ voter: wallet, cross, round: round.index })} onDone={after} />
        </div>
      ) : null}
      {!voting && !needsFinalize && !publish && !canWithdraw && !isAttester ? <Plain testId="no-actions">{round.status === 'failed' ? 'This round failed. Only the creator can open another round.' : 'There is nothing for you to sign in this round right now.'}</Plain> : null}
    </Section>
  );
}

/** The index of the round that passed (the charter holds at most one). */
function passedIndex(g: GraduationRead): number {
  return (g.rounds ?? []).find((r) => r.status === 'passed')?.index ?? (g.charter ? g.charter.roundsUsed - 1 : 0);
}

function toAtoms(text: string, decimals: number): string | null {
  const v = parseAtoms(text, decimals);
  return v === null || v === 0n ? null : v.toString();
}
