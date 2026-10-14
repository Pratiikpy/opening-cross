'use client';

import type { UiWalletAccount } from '@wallet-standard/ui';
import { useCallback, useEffect, useState } from 'react';
import { ActionButton } from '@/components/cross/action-button';
import { ReleaseNotice } from '@/components/cross/release-notice';
import { useSigner } from '@/components/cross/use-signer';
import { clock } from '@/lib/holder-rules';
import { releaseOf, usePrograms } from '@/lib/holder-programs';
import { type TreasuryHolderData, loadTreasuryHolder } from '@/lib/holder-treasury-load';
import { COPY, type ExtRead, type Grant, type Proposal, type Round, KIND_TEXT, STATUS_TEXT, availability, coinText, disclosureView, proposalActions, quoteText, termsLines, yesShare } from '@/lib/holder-treasury';
import { buildReasoned, failureText } from '@/lib/holder-tx';
import { ActionError, type Signer, signSendConfirm } from '@/lib/tx';
import { formatAtoms, formatDuration, parseAtoms, shortAddress } from '@/lib/units';
import { useWallet } from '@/lib/wallet';
import { payable } from '@/lib/holder-treasury-extra';
import { DepositCard, ProposeCard } from './holder-extras';

type Ext = Extract<ExtRead, { extended: true }>;

const CARD = 'rounded-[var(--radius-card)] border border-border p-5';
const FIELD = 'mt-1 w-full rounded-lg border border-border-strong bg-bg px-3 py-2.5 font-mono text-sm';

/**
 * What a coin holder can do with this treasury's extension: vote, redeem at NAV, stake and claim distributions, mark a late revenue round,
 * release a grant, ask for a disclosure. Each action builds its unsigned transaction through the API and is signed in the holder's wallet.
 * Nothing is offered unless the deployed treasury program has the extension, this treasury was extended, and it switched the feature on.
 */
export function HolderActions({ treasury, coinMint, quoteMint, authority }: { treasury: string; coinMint: string; quoteMint: string; authority: string }) {
  const { account } = useWallet();
  const programs = usePrograms();
  const [version, setVersion] = useState(0);
  const [loaded, setLoaded] = useState<{ owner: string | null; data: TreasuryHolderData | null } | undefined>(undefined);
  const owner = account?.address ?? null;
  useEffect(() => {
    let live = true;
    void loadTreasuryHolder(treasury, owner, coinMint, quoteMint).then((d) => live && setLoaded({ owner, data: d })).catch(() => live && setLoaded({ owner, data: null }));
    return () => {
      live = false;
    };
  }, [treasury, owner, coinMint, quoteMint, version]);
  const reload = useCallback(() => setVersion((v) => v + 1), []);
  // What was read for another wallet (or for none) is not shown as this wallet's position while the read for this one is under way.
  const data = loaded && loaded.owner === owner ? loaded.data : undefined;

  const release = programs === null ? 'unknown' : releaseOf(programs === 'unavailable' ? null : programs.programs.treasury);
  const head = (
    <h2 id="holder-actions" className="text-2xl font-semibold tracking-tight">
      What you can do as a holder
    </h2>
  );
  if (programs === null || data === undefined) {
    return (
      <section aria-labelledby="holder-actions" className="mt-12">
        {head}
        <p role="status" className="mt-3 text-sm text-muted">
          Reading what this treasury’s program allows…
        </p>
      </section>
    );
  }
  const avail = availability(release, data?.ext ?? null);
  if (avail.kind === 'first-release' || avail.kind === 'not-extended') {
    return (
      <section aria-labelledby="holder-actions" className="mt-12" data-testid="holder-actions" data-availability={avail.kind}>
        {head}
        <p className="mt-3 max-w-2xl text-sm text-muted">{COPY[avail.kind]}</p>
        <div className="mt-4 max-w-2xl">
          <ReleaseNotice programs={programs} program="treasury" what="Votes, redemption at NAV, distributions, revenue rounds, grants and disclosure requests" />
        </div>
      </section>
    );
  }
  if (avail.kind === 'unknown' || !data?.ext || !data.ext.extended) {
    return (
      <section aria-labelledby="holder-actions" className="mt-12" data-testid="holder-actions" data-availability="unknown">
        {head}
        <p className="mt-3 max-w-2xl text-sm text-muted">
          {data?.ext === null || data === null ? 'The extension of this treasury could not be read just now, so no holder action is offered.' : 'This page could not tell whether the treasury program on this network has the extension, so no holder action is offered.'}
        </p>
        <div className="mt-4 max-w-2xl">
          <ReleaseNotice programs={programs} program="treasury" what="Votes, redemption at NAV, distributions, revenue rounds, grants and disclosure requests" />
        </div>
      </section>
    );
  }
  const ext = data.ext;
  const lines = termsLines(ext);
  return (
    <section aria-labelledby="holder-actions" className="mt-12" data-testid="holder-actions" data-availability="live">
      {head}
      <p className="mt-2 max-w-2xl text-sm text-muted">The team extended this treasury once and its terms are fixed. Each action below is a transaction the Opening Cross API builds and your wallet signs; the program checks every rule again.</p>
      <ul className="mt-4 max-w-3xl space-y-2 text-sm" data-testid="ext-terms">
        {lines.map((l) => {
          const cut = l.text.indexOf('. ');
          return (
            <li key={l.id}>
              <span className="font-medium">{l.text.slice(0, cut + 1)}</span>
              {l.text.slice(cut + 1)}
            </li>
          );
        })}
      </ul>
      {ext.state === 'liquidating' ? (
        <p role="status" className="mt-4 max-w-3xl rounded-[var(--radius-card)] border border-accent px-4 py-3 text-sm">
          This treasury is liquidating: new proposals, spending and deposits are closed. Holders can still redeem, unstake and reclaim their votes.
        </p>
      ) : null}
      {!account ? (
        <p role="status" className="mt-6 rounded-[var(--radius-card)] border border-border p-5 text-sm text-muted">
          Connect a wallet with Connect wallet at the top right to see your position and act on it.
        </p>
      ) : (
        <Connected account={account} treasury={treasury} coinMint={coinMint} authority={authority} data={data} ext={ext} onChanged={reload} />
      )}
    </section>
  );
}

function Connected({ account, treasury, coinMint, authority, data, ext, onChanged }: { account: UiWalletAccount; treasury: string; coinMint: string; authority: string; data: TreasuryHolderData; ext: Ext; onChanged: () => void }) {
  const sign = useSigner(account);
  const owner = account.address;
  const [now, setNow] = useState(() => BigInt(Math.floor(Date.now() / 1000)));
  useEffect(() => {
    const t = setInterval(() => setNow(BigInt(Math.floor(Date.now() / 1000))), 1000);
    return () => clearInterval(t);
  }, []);
  const dec = data.decimals;
  const held = data.position ? BigInt(data.position.held) : 0n;
  const liquidating = ext.state === 'liquidating';
  return (
    <div className="mt-8 space-y-8">
      <Position data={data} owner={owner} treasury={treasury} sign={sign} onChanged={onChanged} liquidating={liquidating} />
      {ext.terms.governance ? <Proposals data={data} ext={ext} treasury={treasury} owner={owner} sign={sign} now={now} onChanged={onChanged} liquidating={liquidating} authority={authority} /> : null}
      {ext.terms.nav ? <Nav ext={ext} data={data} treasury={treasury} owner={owner} sign={sign} onChanged={onChanged} now={now} /> : null}
      {ext.terms.revenue ? <Rounds rounds={data.rounds} treasury={treasury} owner={owner} sign={sign} onChanged={onChanged} decimals={dec?.quote ?? null} /> : null}
      {data.grants && data.grants.length > 0 ? <Grants grants={data.grants} treasury={treasury} owner={owner} sign={sign} onChanged={onChanged} coinDecimals={dec?.coin ?? null} now={now} /> : null}
      {ext.terms.disclosure ? <Disclosure ext={ext} held={held} treasury={treasury} owner={owner} sign={sign} onChanged={onChanged} now={now} /> : null}
      <p className="text-xs text-muted" data-testid="coin-ref">
        Coin {shortAddress(coinMint)}. Amounts are shown in whole coins; {dec ? '' : 'the coin’s decimals could not be read, so forms that take an amount are off. '}the treasury program has not been audited and runs on devnet only.
      </p>
    </div>
  );
}

function Unread({ what }: { what: string }) {
  return (
    <p role="status" className="text-sm text-muted">
      {what} could not be read just now, so nothing is offered for it.
    </p>
  );
}

function AmountForm({ label, decimals, max, action, hint, testId }: { label: string; decimals: number; max?: bigint; action: (amount: bigint) => React.ReactNode; hint?: string; testId: string }) {
  const [text, setText] = useState('');
  const amount = text ? parseAtoms(text, decimals) : null;
  const bad = text !== '' && (amount === null || amount === 0n);
  const over = amount !== null && max !== undefined && amount > max;
  return (
    <div className="space-y-2">
      <label className="block text-sm">
        <span className="text-muted">{label}</span>
        <input inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)} aria-invalid={bad || over} className={FIELD} placeholder="0" data-testid={testId} />
      </label>
      {bad ? <p className="text-xs text-accent-text">Enter an amount above zero with at most {decimals} decimal places.</p> : null}
      {over ? <p className="text-xs text-accent-text">That is more than the {formatAtoms(max!, decimals)} available.</p> : null}
      {hint ? <p className="text-xs text-muted">{hint}</p> : null}
      {amount !== null && amount > 0n && !over ? action(amount) : null}
    </div>
  );
}

function Position({ data, owner, treasury, sign, onChanged, liquidating }: { data: TreasuryHolderData; owner: string; treasury: string; sign: Signer; onChanged: () => void; liquidating: boolean }) {
  const p = data.position;
  const dec = data.decimals;
  return (
    <div className={CARD} data-testid="position">
      <h3 className="font-medium">Your position</h3>
      {!p || !dec ? (
        <div className="mt-2">
          <Unread what="Your position" />
        </div>
      ) : (
        <>
          <dl className="mt-3 grid gap-4 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-xs text-muted">Coins in your wallet</dt>
              <dd className="mt-0.5 font-mono" data-testid="held">{coinText(p.held, dec.coin)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Staked</dt>
              <dd className="mt-0.5 font-mono" data-testid="staked">{coinText(p.staked, dec.coin)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Distributions you can claim</dt>
              <dd className="mt-0.5 font-mono" data-testid="claimable">{quoteText(p.claimable, dec.quote)}</dd>
            </div>
          </dl>
          <div className="mt-4 grid gap-6 md:grid-cols-2">
            <div className="space-y-3">
              {BigInt(p.claimable) > 0n ? (
                <ActionButton label={`Claim ${quoteText(p.claimable, dec.quote)}`} path={`/v1/treasuries/${treasury}/tx/claim-distribution`} body={() => ({ owner })} sign={sign} onDone={onChanged} testId="claim-distribution" />
              ) : (
                <p className="text-sm text-muted">Nothing to claim now. Distributions go to staked coins; deposits of quote tokens and paid revenue rounds add to what you can claim.</p>
              )}
            </div>
            <div className="space-y-4">
              {liquidating ? null : <DepositCard treasury={treasury} owner={owner} sign={sign} onChanged={onChanged} quoteDecimals={dec.quote} />}
              {liquidating ? null : (
                <AmountForm
                  label="Stake coins to earn distributions"
                  decimals={dec.coin}
                  max={BigInt(p.held)}
                  testId="stake-amount"
                  hint="Staked coins are held by the treasury program and can be unstaked at any time; the program never blocks an exit."
                  action={(amount) => <ActionButton label={`Stake ${formatAtoms(amount, dec.coin)} coins`} path={`/v1/treasuries/${treasury}/tx/stake`} body={() => ({ owner, amount: String(amount) })} sign={sign} onDone={onChanged} variant="secondary" testId="stake" />}
                />
              )}
              {BigInt(p.staked) > 0n ? (
                <AmountForm
                  label="Unstake coins"
                  decimals={dec.coin}
                  max={BigInt(p.staked)}
                  testId="unstake-amount"
                  action={(amount) => <ActionButton label={`Unstake ${formatAtoms(amount, dec.coin)} coins`} path={`/v1/treasuries/${treasury}/tx/unstake`} body={() => ({ owner, amount: String(amount) })} sign={sign} onDone={onChanged} variant="secondary" testId="unstake" />}
                />
              ) : null}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Proposals({ data, ext, treasury, owner, sign, now, onChanged, liquidating, authority }: { data: TreasuryHolderData; ext: Ext; treasury: string; owner: string; sign: Signer; now: bigint; onChanged: () => void; liquidating: boolean; authority: string }) {
  const list = data.proposals;
  const dec = data.decimals;
  return (
    <div className={CARD} data-testid="proposals">
      <h3 className="font-medium">Proposals</h3>
      {list === null || !dec ? (
        <div className="mt-2">
          <Unread what="The proposals" />
        </div>
      ) : list.length === 0 ? (
        <p className="mt-2 text-sm text-muted">There are no proposals yet. {ext.terms.governance && data.position && BigInt(data.position.held) > 0n ? `A holder of at least ${Number((ext.terms.governance.proposerMinBps / 100).toFixed(2))}% of the supply can open one.` : ''}</p>
      ) : (
        <ul className="mt-3 divide-y divide-border border-y border-border" data-testid="proposal-list">
          {list.map((p) => (
            <ProposalRow key={p.id} p={p} data={data} treasury={treasury} owner={owner} sign={sign} now={now} onChanged={onChanged} liquidating={liquidating} coinDecimals={dec.coin} quoteDecimals={dec.quote} />
          ))}
        </ul>
      )}
      {liquidating || !dec ? null : (
        <ProposeCard treasury={treasury} owner={owner} sign={sign} onChanged={onChanged} held={data.position ? BigInt(data.position.held) : 0n} supply={BigInt(ext.balances.coinSupply)} minBps={ext.terms.governance!.proposerMinBps} isAuthority={owner === authority} coinDecimals={dec.coin} quoteDecimals={dec.quote} hasNav={ext.terms.nav !== null} />
      )}
    </div>
  );
}

function ProposalRow({ p, data, treasury, owner, sign, now, onChanged, liquidating, coinDecimals, quoteDecimals }: { p: Proposal; data: TreasuryHolderData; treasury: string; owner: string; sign: Signer; now: bigint; onChanged: () => void; liquidating: boolean; coinDecimals: number; quoteDecimals: number }) {
  const [support, setSupport] = useState(true);
  const voted = p.vote ? BigInt(p.vote.yes) + BigInt(p.vote.no) > 0n : false;
  const actions = proposalActions(p, data.position, voted, now);
  const share = yesShare(p);
  const voting = actions.find((a) => a.id === 'vote');
  return (
    <li className="py-4" data-testid="proposal" data-status={p.status}>
      <p className="font-medium">
        #{p.id}: {KIND_TEXT[p.kind]}
        {p.kind === 'spend' ? `, ${quoteText(p.amount, quoteDecimals)} to ${p.destination ? shortAddress(p.destination) : 'a destination fixed in the proposal'}` : ''}
      </p>
      <p className="mt-1 text-sm text-muted" data-testid="proposal-status">
        {STATUS_TEXT[p.status]}. Yes {coinText(p.yes, coinDecimals)}, no {coinText(p.no, coinDecimals)}{share ? ` (${share} yes)` : ''}; quorum needs {coinText(p.quorumNeeded, coinDecimals)} in all.{' '}
        {p.status === 'voting' ? `Voting ends ${clock(p.voteEndsAt)}, in ${formatDuration(BigInt(p.voteEndsAt) - now > 0n ? BigInt(p.voteEndsAt) - now : 0n)}.` : p.status === 'timelock' ? `Executable from ${clock(p.executableAt)}.` : p.status === 'executable' ? `It must be executed before ${clock(p.expiresAt)}.` : ''}
      </p>
      {p.vote && voted ? (
        <p className="mt-1 text-sm" data-testid="my-vote">
          You voted {BigInt(p.vote.yes) > 0n ? `yes with ${coinText(p.vote.yes, coinDecimals)}` : `no with ${coinText(p.vote.no, coinDecimals)}`}. {now >= BigInt(p.voteEndsAt) ? 'Voting has ended, so the coins can be reclaimed.' : 'Those coins stay locked until voting ends.'}
        </p>
      ) : null}
      {voting && !liquidating && !voted ? (
        <div className="mt-3 max-w-md space-y-3">
          <fieldset className="flex gap-4 text-sm">
            <legend className="sr-only">Your vote on proposal {p.id}</legend>
            {[true, false].map((v) => (
              <label key={String(v)} className="flex min-h-6 cursor-pointer items-center gap-2">
                <input type="radio" name={`support-${p.id}`} checked={support === v} onChange={() => setSupport(v)} className="size-5 accent-[var(--accent-fill)]" />
                {v ? 'Yes' : 'No'}
              </label>
            ))}
          </fieldset>
          {voting.enabled ? (
            <AmountForm
              label="Coins to lock behind your vote"
              decimals={coinDecimals}
              max={data.position ? BigInt(data.position.held) : 0n}
              testId={`vote-amount-${p.id}`}
              hint="The coins are locked in the treasury until voting ends, then you reclaim them. There is no delegation."
              action={(amount) => <ActionButton label={`Vote ${support ? 'yes' : 'no'} with ${formatAtoms(amount, coinDecimals)} coins`} path={`/v1/treasuries/${treasury}/tx/vote`} body={() => ({ voter: owner, id: p.id, support, amount: String(amount) })} sign={sign} onDone={onChanged} testId={`vote-${p.id}`} />}
            />
          ) : (
            <p className="text-sm text-muted">{voting.why}</p>
          )}
        </div>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-3">
        {actions.some((a) => a.id === 'reclaim-vote') ? (
          <div className="min-w-56">
            <ActionButton label="Reclaim the coins locked in your vote" path={`/v1/treasuries/${treasury}/tx/reclaim-vote`} body={() => ({ voter: owner, id: p.id })} sign={sign} onDone={onChanged} variant="secondary" testId={`reclaim-${p.id}`} />
          </div>
        ) : null}
        {actions.some((a) => a.id === 'execute') ? (
          <div className="min-w-56">
            <ActionButton label="Execute this proposal" path={`/v1/treasuries/${treasury}/tx/execute-proposal`} body={() => ({ executor: owner, id: p.id })} sign={sign} onDone={onChanged} variant="secondary" testId={`execute-${p.id}`} />
          </div>
        ) : null}
      </div>
    </li>
  );
}

type Preview = { amount: bigint; payout: string; vault: string; supply: string };

/** Redeem at NAV in two steps: the API builds the transaction and says what it pays, then the wallet signs. The amount shown is the program's own arithmetic, not this page's. */
function Nav({ ext, data, treasury, owner, sign, onChanged, now }: { ext: Ext; data: TreasuryHolderData; treasury: string; owner: string; sign: Signer; onChanged: () => void; now: bigint }) {
  const nav = ext.terms.nav!;
  const dec = data.decimals;
  const open = ext.live.navOpen;
  const period = ext.live.navPeriod;
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const held = data.position ? BigInt(data.position.held) : 0n;
  const amount = dec && text ? parseAtoms(text, dec.coin) : null;
  const bad = text !== '' && (amount === null || amount === 0n);
  const over = amount !== null && amount > held;
  const insider = nav.insiders.includes(owner);

  async function show() {
    if (amount === null || amount === 0n) return;
    setError(null);
    setDone(null);
    setStatus('Asking the API what this pays…');
    try {
      const built = await buildReasoned(`/v1/treasuries/${treasury}/tx/nav-redeem`, { holder: owner, amount: String(amount) });
      setPreview({ amount, payout: String(built.extra.payout), vault: String(built.extra.vault), supply: String(built.extra.supply) });
    } catch (e) {
      setPreview(null);
      setError(failureText(e));
    } finally {
      setStatus(null);
    }
  }
  async function redeem() {
    if (!preview || !dec) return;
    setError(null);
    setStatus('Preparing…');
    try {
      const built = await buildReasoned(`/v1/treasuries/${treasury}/tx/nav-redeem`, { holder: owner, amount: String(preview.amount) });
      if (String(built.extra.payout) !== preview.payout) {
        setPreview({ ...preview, payout: String(built.extra.payout), vault: String(built.extra.vault), supply: String(built.extra.supply) });
        throw new ActionError('The vault or the supply changed while you were looking, so the payout changed. Nothing was signed. Read the new figure and press again.');
      }
      await signSendConfirm(built.txs, sign, setStatus);
      setDone(`Redeemed: ${coinText(preview.amount, dec.coin)} burned, ${quoteText(preview.payout, dec.quote)} paid to your wallet.`);
      setPreview(null);
      setText('');
      onChanged();
    } catch (e) {
      setError(failureText(e));
    } finally {
      setStatus(null);
    }
  }
  return (
    <div className={CARD} data-testid="nav">
      <h3 className="font-medium">Redeem at NAV</h3>
      <p className="mt-2 text-sm" data-testid="nav-state">
        {open && period
          ? `A NAV window is open until ${clock(period.endsAt)}, in ${formatDuration(BigInt(period.endsAt) - now > 0n ? BigInt(period.endsAt) - now : 0n)}. ${dec ? `${coinText(period.burned, dec.coin)} of at most ${Number((nav.capBps / 100).toFixed(2))}% of the ${coinText(period.supplyAtStart, dec.coin)} supply at its start have been redeemed.` : ''}`
          : `No NAV window is open. One opens after a passed vote to open it, or automatically after a missed revenue round${ext.live.missedRounds > 0 ? ` (${ext.live.missedRounds} missed so far)` : ''}.`}
      </p>
      {open && dec ? (
        insider ? (
          <p className="mt-3 text-sm text-accent-text" data-testid="nav-insider">This wallet is one of the treasury’s declared insiders, and insiders cannot redeem at NAV.</p>
        ) : held === 0n ? (
          <p className="mt-3 text-sm text-muted">This wallet holds no coins to redeem.</p>
        ) : (
          <div className="mt-4 max-w-md space-y-3">
            <label className="block text-sm">
              <span className="text-muted">Coins to burn (you hold {formatAtoms(held, dec.coin)})</span>
              <input
                inputMode="decimal"
                value={text}
                onChange={(e) => {
                  setText(e.target.value);
                  setPreview(null);
                }}
                aria-invalid={bad || over}
                className={FIELD}
                placeholder="0"
                data-testid="nav-amount"
              />
            </label>
            {bad ? <p className="text-xs text-accent-text">Enter an amount above zero with at most {dec.coin} decimal places.</p> : null}
            {over ? <p className="text-xs text-accent-text">That is more than the {formatAtoms(held, dec.coin)} coins this wallet holds.</p> : null}
            {amount !== null && amount > 0n && !over ? (
              <button type="button" onClick={() => void show()} disabled={status !== null} className="min-h-11 w-full rounded-full border border-border-strong px-5 py-2.5 text-sm font-medium hover:bg-surface disabled:opacity-50" data-testid="nav-preview">
                {status ?? 'Show what this pays'}
              </button>
            ) : null}
            {preview ? (
              <div className="space-y-3 rounded-lg bg-surface p-3 text-sm" data-testid="nav-quote">
                <p>
                  Burning <span className="font-mono">{coinText(preview.amount, dec.coin)}</span> pays <span className="font-mono font-medium">{quoteText(preview.payout, dec.quote)}</span> from a vault of {quoteText(preview.vault, dec.quote)} over {coinText(preview.supply, dec.coin)} of supply. The coins are burned and cannot be taken back.
                </p>
                <button type="button" onClick={() => void redeem()} disabled={status !== null} className="min-h-11 w-full rounded-full bg-accent-fill px-5 py-3 text-sm font-medium text-on-accent hover:opacity-90 disabled:opacity-50" data-testid="nav-redeem">
                  {status ?? 'Redeem in my wallet'}
                </button>
              </div>
            ) : null}
          </div>
        )
      ) : null}
      {error ? (
        <p role="alert" className="mt-3 text-sm text-accent-text">
          {error}
        </p>
      ) : null}
      {done ? (
        <p role="status" className="mt-3 text-sm text-positive" data-testid="nav-done">
          {done}
        </p>
      ) : null}
    </div>
  );
}

const ROUND_TEXT: Record<Round['status'], string> = {
  open: 'Open: the round has not ended',
  'awaiting-payment': 'Ended: the team is within its payment window',
  late: 'Late: not paid within the window',
  paid: 'Paid',
  missed: 'Marked missed',
};

function Rounds({ rounds, treasury, owner, sign, onChanged, decimals }: { rounds: Round[] | null; treasury: string; owner: string; sign: Signer; onChanged: () => void; decimals: number | null }) {
  return (
    <div className={CARD} data-testid="rounds">
      <h3 className="font-medium">Revenue rounds</h3>
      {rounds === null || decimals === null ? (
        <div className="mt-2">
          <Unread what="The revenue rounds" />
        </div>
      ) : rounds.length === 0 ? (
        <p className="mt-2 text-sm text-muted">The first round has not started yet.</p>
      ) : (
        <ul className="mt-3 divide-y divide-border border-y border-border">
          {rounds.slice(0, 8).map((r) => (
            <li key={r.round} className="py-3 text-sm" data-testid="round" data-status={r.status}>
              <p className="font-medium">
                Round {r.round}: {ROUND_TEXT[r.status]}
              </p>
              <p className="mt-0.5 text-xs text-muted">
                Ends {clock(r.endsAt)}; payment due by {clock(r.payDeadline)}.{r.revenue !== null ? ` Attested revenue ${quoteText(r.revenue, decimals)}${r.due !== null ? `, ${quoteText(r.due, decimals)} paid to stakers` : ''}.` : r.attested ? ' Revenue has been attested.' : ' No revenue attestation yet.'}
              </p>
              {payable(r.status) ? (
                <div className="mt-2 max-w-xs">
                  <ActionButton label={`Pay round ${r.round}`} path={`/v1/treasuries/${treasury}/tx/pay-round`} body={() => ({ payer: owner, round: r.round })} sign={sign} onDone={onChanged} variant="secondary" testId={`pay-round-${r.round}`} />
                  <p className="mt-1 text-xs text-muted">Anyone may pay a round, the company or a sponsor. The amount is fixed by the revenue attestation: the treasury’s share of the attested revenue, paid to stakers. If revenue has not been attested the API says so and nothing is signed.</p>
                </div>
              ) : null}
              {r.status === 'late' ? (
                <div className="mt-2 max-w-xs">
                  <ActionButton label={`Mark round ${r.round} missed`} path={`/v1/treasuries/${treasury}/tx/mark-missed`} body={() => ({ caller: owner, round: r.round })} sign={sign} onDone={onChanged} variant="secondary" testId={`mark-missed-${r.round}`} />
                  <p className="mt-1 text-xs text-muted">Anyone may mark a late round missed. A missed round opens the NAV window.</p>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Grants({ grants, treasury, owner, sign, onChanged, coinDecimals, now }: { grants: Grant[]; treasury: string; owner: string; sign: Signer; onChanged: () => void; coinDecimals: number | null; now: bigint }) {
  const mine = grants.filter((g) => g.beneficiary === owner);
  const expirable = grants.filter((g) => g.status === 'expirable');
  if (coinDecimals === null) return null;
  return (
    <div className={CARD} data-testid="grants">
      <h3 className="font-medium">Team grants</h3>
      <p className="mt-1 text-sm text-muted">
        {grants.length} grant{grants.length === 1 ? '' : 's'} in this treasury. {mine.length === 0 ? 'This wallet is the beneficiary of none.' : `This wallet is the beneficiary of ${mine.length}.`}
      </p>
      <ul className="mt-3 divide-y divide-border border-y border-border">
        {[...mine, ...expirable.filter((g) => g.beneficiary !== owner)].map((g) => (
          <li key={g.id} className="py-3 text-sm" data-testid="grant" data-status={g.status}>
            <p className="font-medium">
              Grant {g.id}: {coinText(g.total, coinDecimals)} to {g.beneficiary === owner ? 'you' : shortAddress(g.beneficiary)}, {coinText(g.released, coinDecimals)} released
            </p>
            <p className="mt-0.5 text-xs text-muted">
              {g.status === 'locked' ? `Locked until ${clock(g.lockupEnd)}, in ${formatDuration(BigInt(g.lockupEnd) - now > 0n ? BigInt(g.lockupEnd) - now : 0n)}.` : g.status === 'expired' ? 'Expired: the unreleased part was burned.' : g.status === 'expirable' ? `Passed its expiry (${clock(g.expiresAt)}); anyone can burn what is left.` : `Releasing in milestones; unreleased coins burn after ${clock(g.expiresAt)}.`}
            </p>
            {g.status === 'releasing' && g.beneficiary === owner ? (
              <ul className="mt-2 space-y-2">
                {g.milestones.map((ms) => (
                  <li key={ms.index} className="flex flex-wrap items-center justify-between gap-3">
                    <span>
                      Milestone {ms.index + 1}: {coinText(ms.amount, coinDecimals)}
                      {ms.requiresAttestation ? ', needs an attestation' : ''}
                      {ms.released ? ' (released)' : ''}
                    </span>
                    {ms.released ? null : (
                      <div className="w-56">
                        <ActionButton label="Release this milestone" path={`/v1/treasuries/${treasury}/tx/release-milestone`} body={() => ({ cranker: owner, grant: g.address, index: ms.index })} sign={sign} onDone={onChanged} variant="secondary" testId={`release-${g.id}-${ms.index}`} />
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            ) : null}
            {g.status === 'expirable' ? (
              <div className="mt-2 max-w-xs">
                <ActionButton label="Burn the expired grant" path={`/v1/treasuries/${treasury}/tx/expire-grant`} body={() => ({ cranker: owner, grant: g.address })} sign={sign} onDone={onChanged} variant="secondary" testId={`expire-${g.id}`} />
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Disclosure({ ext, held, treasury, owner, sign, onChanged, now }: { ext: Ext; held: bigint; treasury: string; owner: string; sign: Signer; onChanged: () => void; now: bigint }) {
  const v = disclosureView(ext, held, now);
  return (
    <div className={CARD} data-testid="disclosure-request" data-state={v.state}>
      <h3 className="font-medium">Ask the team for a disclosure</h3>
      <p className="mt-2 max-w-3xl text-sm text-muted">{v.text}</p>
      {v.state === 'open' ? (
        v.canRequest ? (
          <div className="mt-3 max-w-xs">
            <ActionButton label="Request a disclosure" path={`/v1/treasuries/${treasury}/tx/request-disclosure`} body={() => ({ holder: owner })} sign={sign} onDone={onChanged} testId="request-disclosure" />
          </div>
        ) : (
          <p className="mt-3 text-sm" data-testid="disclosure-why">{v.why}</p>
        )
      ) : null}
    </div>
  );
}
