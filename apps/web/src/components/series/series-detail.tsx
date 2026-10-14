'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Select, Text } from '@/components/issue-wizard/fields';
import { explainNoPrint } from '@/components/cross/no-print';
import { useClock } from '@/components/calendar/use-clock';
import { WalletAction } from '@/components/issuer/issuer-action';
import { ProgramNotice } from '@/components/issuer/program-notice';
import { Facts, Pill, Section } from '@/components/issuer/treasury-ui';
import { isAddress } from '@solana/kit';
import { ata, readMintFull } from '@/lib/issuer-chain';
import type { MintRead } from '@/lib/issuer-readiness';
import { atomsOf, fmt } from '@/lib/issuer-treasury-console';
import { type CrossStateName, type SeriesRead, asNumber, countText, isCalendar, scheduleText, seriesStatus, spawnVerdict, utcAt } from '@/lib/series';
import { type CrossBrief, loadCrossBrief, loadSeriesChecked, loadSessionStarts, readHeld } from '@/lib/series-load';
import { formatDuration, formatPrice, shortAddress } from '@/lib/units';
import { useWallet } from '@/lib/wallet';

const STATUS_TONE = { running: 'ok', waiting: 'info', paused: 'warn', done: 'info' } as const;
const STATUS_TEXT = { running: 'A cross is running', waiting: 'Waiting for the next slot', paused: 'Paused by its authority', done: 'Finished its last cross' } as const;
const STATE_TONE: Record<CrossStateName, 'ok' | 'block' | 'warn' | 'info'> = { Live: 'warn', Cleared: 'info', Finalized: 'ok', NoPrint: 'block' };
const STATE_TEXT: Record<CrossStateName, string> = { Live: 'Taking orders', Cleared: 'Cleared', Finalized: 'Printed', NoPrint: 'Did not print' };

/**
 * One recurring series: its schedule, the next cross and whether anyone may spawn it now, the crosses it has run and how each ended, and, for
 * its authority, pausing and withdrawing. Read from GET /v1/series/:address (chain) and the crosses it spawned (index and chain).
 */
export function SeriesDetail({ address }: { address: string }) {
  const { account } = useWallet();
  const wallet = account?.address ?? null;
  const now = useClock(Math.floor(Date.now() / 1000));
  const [rev, setRev] = useState(0);
  const reload = useCallback(() => setRev((r) => r + 1), []);
  const [read, setRead] = useState<SeriesRead | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [crosses, setCrosses] = useState<Record<string, CrossBrief | null>>({});
  const [sessions, setSessions] = useState<number[] | null>(null);
  const [mints, setMints] = useState<{ base: MintRead; quote: MintRead } | null>(null);

  useEffect(() => {
    let live = true;
    void loadSeriesChecked(address).then(async (r) => {
      if (!live) return;
      if (!r.ok) {
        setError(r.error);
        setRead(null);
        return;
      }
      setError(null);
      setRead(r.data);
      const recent = [...r.data.crosses].sort((a, b) => Number(BigInt(b.idx) - BigInt(a.idx))).slice(0, 6);
      const briefs = await Promise.all(recent.map(async (c) => [c.cross_address, await loadCrossBrief(c.cross_address)] as const));
      if (live) setCrosses(Object.fromEntries(briefs.map(([a, b]) => [a, b.ok ? b.data : null])));
      if (r.data.lastCross && !recent.some((c) => c.cross_address === r.data.lastCross)) {
        const b = await loadCrossBrief(r.data.lastCross);
        if (live) setCrosses((c) => ({ ...c, [r.data.lastCross!]: b.ok ? b.data : null }));
      }
      if (isCalendar(r.data)) {
        const s = await loadSessionStarts(r.data.schedule.calendar);
        if (live) setSessions(s.ok ? s.data : null);
      }
      const [base, quote] = await Promise.all([readMintFull(r.data.baseMint), readMintFull(r.data.quoteMint)]);
      if (live) setMints({ base, quote });
    });
    return () => {
      live = false;
    };
  }, [address, rev]);

  const previous: CrossStateName | null = read?.lastCross ? (crosses[read.lastCross]?.state ?? null) : null;
  const verdict = useMemo(() => (read ? spawnVerdict(read, now, previous, sessions) : null), [read, now, previous, sessions]);
  const market = mints?.base.ok && mints.quote.ok ? { priceScale: 10n ** BigInt(mints.base.decimals), baseDecimals: mints.base.decimals, quoteDecimals: mints.quote.decimals } : null;

  if (error) {
    return (
      <p role="alert" className="rounded-[var(--radius-card)] border border-border p-5 text-sm text-accent-text" data-testid="series-error">
        {error}
      </p>
    );
  }
  if (!read) {
    return (
      <p role="status" className="text-sm text-muted">
        Reading the series from the chain…
      </p>
    );
  }
  const status = seriesStatus(read, previous);
  const lastPrice = read.lastPrice !== null && market ? formatPrice(BigInt(read.lastPrice), market) : null;
  const ordered = [...read.crosses].sort((a, b) => Number(BigInt(b.idx) - BigInt(a.idx)));

  return (
    <div className="space-y-6" data-testid="series-detail">
      <ProgramNotice which="crossCore" what="Recurring series" />
      <Section id="schedule" title="Schedule" intro="The program, not the person who calls it, decides when each cross closes, so a series cannot be steered by whoever spawns it.">
        <div className="flex flex-wrap items-center gap-3">
          <Pill tone={STATUS_TONE[status]} testId="series-status">
            {STATUS_TEXT[status]}
          </Pill>
          <span className="text-sm text-muted" data-testid="series-count">
            {countText(read)}
          </span>
        </div>
        <Facts
          rows={[
            ['Schedule', scheduleText(read)],
            ['Each call lasts', formatDuration(BigInt(asNumber(read.callSecs) ?? 0))],
            ['Reveal window', Number(read.revealSecs) > 0 ? formatDuration(BigInt(asNumber(read.revealSecs) ?? 0)) : 'none: orders are open'],
            ['Last printed price', lastPrice ? `${lastPrice} quote per token; the next grid centres on it` : 'none yet; the first grid is centred on the price set at creation'],
            ['Authority', read.authority],
            ['Series address', read.series],
            ['Token', read.baseMint],
            ['Quote token', read.quoteMint],
          ]}
        />
      </Section>

      <Section id="next" title="The next cross" intro="Anyone may spawn the next cross once it is due. A cross is created at most 24 hours before it opens, and crosses run one at a time.">
        {verdict ? (
          <div className="space-y-3" data-testid="spawn-verdict">
            {verdict.can ? (
              <p className="text-sm">
                <span className="font-medium">It can be spawned now.</span> It will open {utcAt(verdict.opensAt)} and close {utcAt(verdict.closeTs)}, {formatDuration(BigInt(Math.max(0, verdict.closeTs - now)))} from now.
              </p>
            ) : (
              <p className="text-sm" data-testid="spawn-reason">
                <span className="font-medium">Not yet.</span> {verdict.message}
                {'closeTs' in verdict && verdict.closeTs !== undefined && verdict.opensAt !== undefined ? ` The next cross will open ${utcAt(verdict.opensAt)} and close ${utcAt(verdict.closeTs)}${verdict.spawnableFrom ? `; it can be spawned from ${utcAt(verdict.spawnableFrom)}` : ''}.` : ''}
              </p>
            )}
            <div className="max-w-sm">
              <WalletAction
                account={account ?? null}
                label="Spawn the next cross"
                path="/v1/tx/spawn-next"
                needs="crossCore"
                what="Recurring series"
                testId="spawn-next"
                variant="secondary"
                disabled={!verdict.can}
                disabledReason={verdict.can ? undefined : verdict.message}
                connectHint="Any wallet can spawn the next cross. Connect one to pay the rent of its accounts."
                body={() => ({ series: read.series, payer: wallet })}
                onDone={reload}
              />
              <p className="mt-1 text-xs text-muted">Whoever spawns a cross pays the rent of its accounts, and does not get it back. The cross belongs to the series, not to the spawner.</p>
            </div>
          </div>
        ) : null}
      </Section>

      <Section id="crosses" title="Crosses so far" intro="Each one is an ordinary cross with its own page, book and proof. A cross that did not print says why, and everyone in it was refunded in full.">
        {ordered.length === 0 ? (
          <p className="text-sm text-muted" data-testid="no-crosses">
            No cross has been spawned yet.
          </p>
        ) : (
          <ul className="divide-y divide-border border-y border-border" data-testid="series-crosses">
            {ordered.map((c) => {
              const b = crosses[c.cross_address];
              return (
                <li key={c.cross_address} className="flex flex-wrap items-start justify-between gap-3 py-3 text-sm" data-testid={`series-cross-${c.idx}`}>
                  <div className="min-w-0">
                    <Link href={`/crosses/${c.cross_address}`} className="font-medium underline underline-offset-4">
                      Cross {String(c.idx)}
                    </Link>{' '}
                    <span className="font-mono text-xs text-muted">{shortAddress(c.cross_address)}</span>
                    <p className="mt-1 text-xs text-muted">
                      Closes {utcAt(Number(c.close_ts))}
                      {b?.state === 'Finalized' || b?.state === 'Cleared' ? (b.clearingPrice && market ? `. Printed at ${formatPrice(BigInt(b.clearingPrice), market)} quote per token.` : '. Printed.') : ''}
                      {b?.state === 'NoPrint' ? `. Did not print: ${explainNoPrint(b.noPrintReason)}.` : ''}
                    </p>
                  </div>
                  {b ? <Pill tone={STATE_TONE[b.state]}>{STATE_TEXT[b.state]}</Pill> : <Pill>State unread</Pill>}
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      <Authority read={read} wallet={wallet} account={account ?? null} mints={mints} reload={reload} />
    </div>
  );
}

function Authority({ read, wallet, account, mints, reload }: { read: SeriesRead; wallet: string | null; account: ReturnType<typeof useWallet>['account']; mints: { base: MintRead; quote: MintRead } | null; reload: () => void }) {
  const isAuthority = wallet !== null && wallet === read.authority;
  const [side, setSide] = useState<'quote' | 'base'>('quote');
  const [amount, setAmount] = useState('');
  const [to, setTo] = useState('');
  const mint = side === 'quote' ? mints?.quote : mints?.base;
  const mintAddress = side === 'quote' ? read.quoteMint : read.baseMint;
  const [held, setHeld] = useState<{ ok: true; amount: bigint } | { ok: false; reason: string } | null>(null);
  useEffect(() => {
    if (!mint?.ok) return;
    let live = true;
    void readHeld(read.series, mintAddress, mint.program).then((h) => live && setHeld(h));
    return () => {
      live = false;
    };
    // `read` is a new object each time the series is read again (after any action), so the balance is read again too.
  }, [read, mintAddress, mint]);
  const decimals = mint?.ok ? mint.decimals : null;
  const parsed = amount.trim() === '' ? null : atomsOf(amount, decimals, 'The amount');
  const holds = held !== null && held.ok ? held.amount : null;
  const tooMuch = parsed !== null && parsed.ok && holds !== null && BigInt(parsed.atoms) > holds;
  const a = tooMuch ? ({ ok: false, error: `The series holds only ${fmt(holds!.toString(), decimals, side === 'quote' ? 'quote' : 'tokens')}.` } as const) : parsed;
  const dest = to.trim() === '' ? wallet : to.trim();
  return (
    <Section id="authority" title="The authority" intro={`Only the authority, ${shortAddress(read.authority)}, can pause the series or withdraw what it holds. It cannot change the schedule, the grid or the rules: the template is fixed.`}>
      {!isAuthority ? (
        <p className="text-sm text-muted" data-testid="not-authority">
          {wallet ? 'This wallet is not the series’ authority, so pausing and withdrawing are not offered.' : 'Connect the authority wallet to pause the series or withdraw from it.'}
        </p>
      ) : (
        <div className="space-y-5">
          <div className="max-w-sm">
            <WalletAction
              account={account}
              label={read.active ? 'Pause the series' : 'Resume the series'}
              variant="secondary"
              path="/v1/tx/set-series-active"
              needs="crossCore"
              what="Recurring series"
              testId="set-active"
              body={() => ({ authority: wallet, series: read.series, active: !read.active })}
              onDone={reload}
            />
            <p className="mt-1 text-xs text-muted">{read.active ? 'Pausing stops the next cross from being spawned. A cross already running is not affected.' : 'Resuming lets the next cross be spawned when it is due.'}</p>
          </div>
          <div className="space-y-3 rounded-lg border border-border p-4" data-testid="withdraw">
            <p className="font-medium">Withdraw what the series holds</p>
            <p className="text-sm text-muted">{held === null ? 'Reading the balance…' : held.ok ? `The series holds ${fmt(held.amount.toString(), decimals, side === 'quote' ? 'quote' : 'tokens')}.` : `The balance could not be read (${held.reason}).`}</p>
            <div className="grid gap-4 sm:grid-cols-2">
              <Select
                label="Token"
                value={side}
                onChange={(v) => {
                  setSide(v as 'quote' | 'base');
                  setHeld(null);
                }}
                options={[
                  ['quote', 'Quote token'],
                  ['base', 'The token being traded'],
                ]}
              />
              <Text label="Amount" value={amount} onChange={setAmount} inputMode="decimal" error={a && !a.ok ? a.error : undefined} />
              <div className="sm:col-span-2">
                <Text label="Send to wallet" value={to} onChange={setTo} placeholder={wallet ?? ''} error={to.trim() !== '' && !isAddress(to.trim()) ? 'This is not a Solana address.' : undefined} hint="Empty: your own wallet. The tokens go to that wallet’s token account for this token, which must already exist." />
              </div>
            </div>
            <WalletAction
              account={account}
              label="Withdraw"
              variant="secondary"
              path="/v1/tx/series-withdraw"
              needs="crossCore"
              what="Recurring series"
              testId="series-withdraw"
              disabled={!a?.ok || !mint?.ok || !dest || !isAddress(dest)}
              disabledReason="Enter an amount."
              body={async () => ({ authority: wallet, series: read.series, mint: mintAddress, tokenProgram: mint?.ok ? mint.program : '', to: await ata(dest ?? '', mintAddress, mint?.ok ? mint.program : ''), amount: a && a.ok ? a.atoms : '0' })}
              onDone={() => {
                setAmount('');
                setHeld(null);
                reload();
              }}
            />
          </div>
        </div>
      )}
    </Section>
  );
}
