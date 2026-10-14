'use client';

import { isAddress } from '@solana/kit';
import { useEffect, useMemo, useState } from 'react';
import { SmallButton, Text } from '@/components/issue-wizard/fields';
import { type CrossRow, crossSummary } from '@/lib/issuer-data';
import { readMintFull } from '@/lib/issuer-chain';
import { atomsOf, fmt } from '@/lib/issuer-treasury-console';
import { GREENSHOE_LEVELS, type FreshKey, type SettlementRead, VENUE_NAME, cosign, freshKey, loadSettlement } from '@/lib/issuer-settle';
import { utc } from '@/lib/treasury';
import { shortAddress } from '@/lib/units';
import { useWallet } from '@/lib/wallet';
import { WalletAction } from './issuer-action';
import { ProgramNotice } from './program-notice';
import { AlphaVault, FeeSharing, MetLock } from './settle-meteora';
import { MarketOpening } from './settle-open';
import { Facts, Pill, Section } from './treasury-ui';

const LIVE_TODAY: { feature: string; today: string; after: string; here: string }[] = [
  { feature: 'Open a venue: DBC continuation, DAMM v2 pool, DLMM pair, Raydium CPMM pool', today: 'Live (first release of cross_settle), proved on devnet', after: 'Unchanged', here: 'The Open the market forms below build them.' },
  { feature: 'Claim the partner’s trading fees; withdraw the partner surplus; withdraw the migration fee; claim the pool-creation fee', today: 'Not available', after: 'Four instructions of the upgraded cross_settle, paid only to the addresses the cross fixed', here: 'Buttons below.' },
  { feature: 'Locked, compounding DBC continuation and the fees of its protocol-owned liquidity', today: 'Not available', after: 'open_dbc_pool_locked and claim_pol_fees', here: 'Claiming the position’s fees is below; opening the pool is done with the SDK.' },
  { feature: 'Greenshoe: standing bids under the clearing price for a week', today: 'Not available', after: 'create, place, settle and finish', here: 'Buttons below.' },
  { feature: 'Batch-opened pools, Alpha Vault entry and Met Lock vesting', today: 'Not available', after: 'seed_damm_v2_batched, open_dlmm_pair_batched, the Alpha Vault fill, Met Lock', here: 'Forms below: open the market, the Alpha Vault, Met Lock. Position vesting (lock.vest) and the DLMM Alpha Vault fill are not offered.' },
  { feature: 'Stock-quoted DLMM pair behind a Token Badge', today: 'Not available', after: 'open_dlmm_pair_badged, once Meteora issues the badge', here: 'Form below (name the two badges); the badge is Meteora’s to issue.' },
];

export function SettleConsole() {
  const { account } = useWallet();
  const wallet = account?.address ?? null;
  const [rows, setRows] = useState<CrossRow[] | null>(null);
  const [rowsError, setRowsError] = useState<string | null>(null);
  const [selected, setSelected] = useState('');
  const [typed, setTyped] = useState('');

  useEffect(() => {
    let live = true;
    void crossSummary(1000).then((r) => {
      if (!live) return;
      if (r.ok) setRows(r.data.crosses);
      else setRowsError(r.error);
    });
    const q = new URLSearchParams(window.location.search).get('cross');
    if (q && isAddress(q)) setSelected(q);
    return () => {
      live = false;
    };
  }, []);

  const mine = useMemo(() => (rows && wallet ? rows.filter((r) => r.creator === wallet) : []), [rows, wallet]);
  const typedOk = isAddress(typed.trim());
  return (
    <div className="mt-8 space-y-6">
      <ProgramNotice which="crossSettle" what="The upgraded cross_settle (partner payouts, protected liquidity fees, greenshoe)" />
      <Section id="live" title="What is live today, and what comes with the upgrade" intro="The programs on devnet are the first release. The ones below marked “Not available” are built and proved on LiteSVM against the real Meteora and Raydium binaries; they go live when the upgrade is funded (H27). This page never offers a button the deployed program would refuse: each one is simulated on the cluster before your wallet is asked, and nothing is signed if the program says no.">
        <div className="overflow-x-auto" role="region" aria-label="What is live today and what comes with the upgrade" tabIndex={0}>
          <table className="w-full min-w-[640px] text-left text-sm" data-testid="live-table">
            <caption className="sr-only">What is live today and what comes with the upgrade</caption>
            <thead>
              <tr className="border-b border-border text-muted">
                <th scope="col" className="py-2 pr-4 font-medium">
                  Feature
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  On devnet today
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  After the upgrade
                </th>
                <th scope="col" className="py-2 font-medium">
                  On this page
                </th>
              </tr>
            </thead>
            <tbody>
              {LIVE_TODAY.map((r) => (
                <tr key={r.feature} className="border-b border-border align-top">
                  <th scope="row" className="py-3 pr-4 font-normal">
                    {r.feature}
                  </th>
                  <td className="py-3 pr-4 text-muted">{r.today}</td>
                  <td className="py-3 pr-4 text-muted">{r.after}</td>
                  <td className="py-3 text-muted">{r.here}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section id="pick" title="Choose a cross" intro="The crosses your wallet created are listed. Payouts and the greenshoe belong to a cross that has settled; anyone may send a payout, and it can only go to the address the cross fixed.">
        {!wallet ? <p className="text-sm text-muted" data-testid="connect-for-list">Connect the wallet you issue from to list your crosses, or paste a cross address below.</p> : null}
        {rowsError ? <p role="alert" className="text-sm text-accent-text">{rowsError}</p> : null}
        {wallet && rows && mine.length === 0 ? <p className="text-sm text-muted" data-testid="no-crosses">This wallet has created no cross on this network.</p> : null}
        {mine.length > 0 ? (
          <ul className="grid gap-2" data-testid="my-crosses">
            {mine.map((r) => (
              <li key={r.address}>
                <button type="button" onClick={() => setSelected(r.address)} aria-pressed={selected === r.address} data-testid={`pick-${r.address}`} className={`flex min-h-11 w-full flex-wrap items-center justify-between gap-2 rounded-lg border px-4 py-2 text-left text-sm ${selected === r.address ? 'border-ink' : 'border-border'}`}>
                  <span className="font-mono">{shortAddress(r.address)}</span>
                  <Pill tone={r.state === 'Finalized' ? 'ok' : r.state === 'NoPrint' ? 'block' : 'warn'}>{r.state}</Pill>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="grid grid-cols-[1fr_auto] items-end gap-3">
          <Text label="Or a cross address" value={typed} onChange={setTyped} error={typed.trim() !== '' && !typedOk ? 'This is not a Solana address.' : undefined} />
          <SmallButton testId="use-typed" disabled={!typedOk} onClick={() => setSelected(typed.trim())}>
            Use this cross
          </SmallButton>
        </div>
      </Section>

      {selected ? <Selected key={selected} cross={selected} row={rows?.find((r) => r.address === selected) ?? null} account={account ?? null} /> : null}
    </div>
  );
}

function Selected({ cross, row, account }: { cross: string; row: CrossRow | null; account: ReturnType<typeof useWallet>['account'] }) {
  const [settlement, setSettlement] = useState<SettlementRead | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [quoteDecimals, setQuoteDecimals] = useState<number | null>(null);
  const [rev, setRev] = useState(0);
  const reload = () => setRev((r) => r + 1);
  useEffect(() => {
    let live = true;
    void loadSettlement(cross).then((r) => {
      if (!live) return;
      if (r.ok) {
        setSettlement(r.data);
        setError(null);
      } else setError(r.error);
    });
    return () => {
      live = false;
    };
  }, [cross, rev]);
  useEffect(() => {
    if (!row) return;
    let live = true;
    void readMintFull(row.quoteMint).then((m) => live && setQuoteDecimals(m.ok ? m.decimals : null));
    return () => {
      live = false;
    };
  }, [row]);
  const wallet = account?.address;
  const live = row?.state === 'Live';
  const noPrint = row?.state === 'NoPrint';
  const why = live ? 'The cross has not settled yet.' : noPrint ? 'This cross did not print, so no venue was opened and there is nothing to pay out.' : undefined;
  const off = Boolean(live || noPrint);
  const payer = () => ({ cross, payer: wallet });
  const [destination, setDestination] = useState<string | null>(null);

  return (
    <>
      <Section id="record" title="This cross" intro="What the indexer saw of its venue and its partner payouts. A figure that could not be read is shown as unread, not as zero.">
        <p className="break-all font-mono text-xs text-muted" data-testid="selected-cross">
          {cross}
        </p>
        {error ? <p role="alert" className="text-sm text-accent-text" data-testid="settlement-error">{error}</p> : null}
        {settlement ? (
          <div data-testid="settlement-record">
            <Facts
              rows={[
                ['State', row ? row.state : 'not in the index'],
                ['Venue', settlement.venue ? `${VENUE_NAME[settlement.venue.venue] ?? settlement.venue.venue}${settlement.venue.pool ? ` (${shortAddress(settlement.venue.pool)})` : ''}` : 'none opened by an adapter'],
                ['Partner trading fees claimed', settlement.partner ? `${fmt(settlement.partner.fee_quote, quoteDecimals, 'quote')} in ${settlement.partner.fee_claims} claim${settlement.partner.fee_claims === 1 ? '' : 's'}` : 'none'],
                ['Partner surplus withdrawn', settlement.partner ? fmt(settlement.partner.surplus_withdrawn, quoteDecimals, 'quote') : 'none'],
                ['Migration fee withdrawn', settlement.partner ? fmt(settlement.partner.migration_fee, quoteDecimals, 'quote') : 'none'],
                ['Pool-creation fee claimed', settlement.partner ? `${settlement.partner.pool_creation_lamports} lamports` : 'none'],
              ]}
            />
            {settlement.note ? <p className="mt-3 text-sm text-muted">{settlement.note}</p> : null}
          </div>
        ) : !error ? (
          <p className="text-sm text-muted" role="status">
            Reading…
          </p>
        ) : null}
      </Section>

      <Section id="payouts" title="Partner payouts" intro="A cross opened as a DBC continuation earns the partner a share of the pool’s trading fees, a share of the surplus quote after migration, a slice of the migration fee, and a pool-creation fee. Each button sends one payout. Where the money goes is fixed by the program when the cross is created: a caller cannot redirect it, and anyone may send it.">
        <div className="grid gap-4 sm:grid-cols-2">
          <PayoutButton account={account} label="Claim the partner’s trading fees" what="Partner payouts" path="/v1/tx/claim-partner-fee" body={payer} off={off} why={why} testId="claim-partner-fee" onBuilt={(x) => setDestination(String(x.recipient ?? ''))} onDone={reload} />
          <PayoutButton account={account} label="Withdraw the partner surplus" what="Partner payouts" path="/v1/tx/withdraw-partner-surplus" body={payer} off={off} why={why} testId="withdraw-partner-surplus" onBuilt={(x) => setDestination(String(x.recipient ?? ''))} onDone={reload} />
          <PayoutButton account={account} label="Withdraw the migration fee" what="Partner payouts" path="/v1/tx/withdraw-partner-migration-fee" body={payer} off={off} why={why} testId="withdraw-partner-migration-fee" onBuilt={(x) => setDestination(String(x.recipient ?? ''))} onDone={reload} />
          <PayoutButton account={account} label="Claim the pool-creation fee" what="Partner payouts" path="/v1/tx/claim-partner-pool-creation-fee" body={payer} off={off} why={why} testId="claim-partner-pool-creation-fee" onBuilt={(x) => setDestination(String(x.recipient ?? ''))} onDone={reload} />
        </div>
        {destination ? (
          <p className="text-sm text-muted" role="status" data-testid="payout-destination">
            The program pays this to <span className="break-all font-mono">{destination}</span>, the address the cross fixed. Check it against your wallet’s prompt.
          </p>
        ) : null}
      </Section>

      <PolFees account={account} cross={cross} off={off} why={why} />
      <MarketOpening cross={cross} row={row} account={account} wallet={wallet} reload={reload} />
      <AlphaVault cross={cross} row={row} account={account} wallet={wallet} quoteDecimals={quoteDecimals} />
      <MetLock account={account} wallet={wallet} />
      <FeeSharing cross={cross} row={row} account={account} wallet={wallet} />
      <Greenshoe account={account} cross={cross} row={row} settlement={settlement} quoteDecimals={quoteDecimals} reload={reload} wallet={wallet} />
    </>
  );
}

function PayoutButton({ account, label, what, path, body, off, why, testId, onBuilt, onDone }: { account: ReturnType<typeof useWallet>['account']; label: string; what: string; path: string; body: () => unknown; off: boolean; why: string | undefined; testId: string; onBuilt: (x: Record<string, unknown>) => void; onDone: () => void }) {
  return <WalletAction account={account} label={label} variant="secondary" path={path} needs="crossSettle" what={what} body={body} disabled={off} disabledReason={why} testId={testId} onBuilt={(x) => onBuilt(x)} onDone={onDone} />;
}

const POL_FIELDS: [string, string, string][] = [
  ['pool', 'Pool', 'The DAMM v2 pool the continuation migrated into.'],
  ['position', 'Position', 'The protocol-owned liquidity position.'],
  ['positionNftAccount', 'Position NFT account', 'The token account holding the position’s NFT.'],
  ['tokenAMint', 'Token A mint', ''],
  ['tokenBMint', 'Token B mint', ''],
  ['tokenAVault', 'Token A vault', ''],
  ['tokenBVault', 'Token B vault', ''],
];

function PolFees({ account, cross, off, why }: { account: ReturnType<typeof useWallet>['account']; cross: string; off: boolean; why: string | undefined }) {
  const [v, setV] = useState<Record<string, string>>({});
  const ok = POL_FIELDS.every(([k]) => isAddress((v[k] ?? '').trim()));
  return (
    <Section id="pol" title="Fees of the protected liquidity" intro="A locked, compounding continuation leaves a liquidity position in the migrated pool that nobody can withdraw. Its trading fees can be claimed, and they go to the issuer’s proceeds address, not to the caller. The addresses are those of the migrated pool; read them from its page on Meteora.">
      <div className="grid gap-4 sm:grid-cols-2" data-testid="pol-form">
        {POL_FIELDS.map(([k, label, hint]) => (
          <Text key={k} label={label} value={v[k] ?? ''} onChange={(x) => setV({ ...v, [k]: x })} error={(v[k] ?? '').trim() !== '' && !isAddress(v[k]!.trim()) ? 'This is not a Solana address.' : undefined} {...(hint ? { hint } : {})} />
        ))}
      </div>
      <div className="max-w-sm">
        <WalletAction
          account={account}
          label="Claim the position’s fees"
          variant="secondary"
          path="/v1/tx/claim-pol-fees"
          needs="crossSettle"
          what="Fees of the protected liquidity"
          testId="claim-pol-fees"
          disabled={off || !ok}
          disabledReason={why ?? 'Fill in all seven addresses.'}
          body={() => ({ cross, payer: account?.address, ...Object.fromEntries(POL_FIELDS.map(([k]) => [k, (v[k] ?? '').trim()])) })}
          onDone={() => undefined}
        />
      </div>
    </Section>
  );
}

function Greenshoe({ account, cross, row, settlement, quoteDecimals, reload, wallet }: { account: ReturnType<typeof useWallet>['account']; cross: string; row: CrossRow | null; settlement: SettlementRead | null; quoteDecimals: number | null; reload: () => void; wallet: string | undefined }) {
  const g = settlement?.greenshoe ?? null;
  const [budget, setBudget] = useState('');
  const [start, setStart] = useState('');
  const [periodHours, setPeriodHours] = useState('24');
  const [periodCap, setPeriodCap] = useState('');
  const b = budget.trim() === '' ? null : atomsOf(budget, quoteDecimals, 'The budget');
  const cap = periodCap.trim() === '' ? null : atomsOf(periodCap, quoteDecimals, 'The cap per period');
  const startTs = start ? Math.floor(new Date(start).getTime() / 1000) : null;
  const hours = /^\d{1,4}$/.test(periodHours.trim()) ? Number(periodHours.trim()) : null;
  const isCreator = row !== null && wallet !== undefined && row.creator === wallet;
  return (
    <Section id="greenshoe" title="Greenshoe" intro="After a cross finalizes, you can commit a budget of at least 10% of what buyers paid as standing bids under the clearing price in the cross’s DLMM pair, for a week. What the bids buy is burned and what is unspent comes back to you, so it works as price support, not as a way to take tokens. Only you, the creator, can start one; anyone can settle it once the week is over.">
      {!g ? (
        <div className="space-y-3 rounded-lg border border-border p-4" data-testid="greenshoe-create">
          <p className="font-medium">Commit a budget</p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Text label="Budget, in quote tokens" value={budget} onChange={setBudget} inputMode="decimal" error={b && !b.ok ? b.error : undefined} hint="At least 10% of what buyers paid: the program names the exact minimum if this is under it." />
            <Text label="The bids start" type="datetime-local" mono={false} value={start} onChange={setStart} hint="Now or later." />
            <Text label="A period lasts, hours" value={periodHours} onChange={setPeriodHours} inputMode="numeric" error={hours === null ? 'A whole number of hours.' : undefined} hint="Bids are rate limited: at most the cap below in each period." />
            <Text label="Most to place in a period, in quote tokens" value={periodCap} onChange={setPeriodCap} inputMode="decimal" error={cap && !cap.ok ? cap.error : undefined} />
          </div>
          <WalletAction
            account={account}
            label="Commit the budget"
            variant="secondary"
            path="/v1/tx/create-greenshoe"
            needs="crossSettle"
            what="The greenshoe"
            testId="create-greenshoe"
            disabled={!(b?.ok && cap?.ok && startTs !== null && hours !== null) || !isCreator || row?.state !== 'Finalized'}
            disabledReason={row?.state !== 'Finalized' ? 'A greenshoe follows a finalized cross.' : !isCreator ? 'Only the wallet that created the cross can commit a greenshoe.' : 'Fill in the budget, the start and the cap.'}
            body={() => ({ cross, creator: wallet, budget: b && b.ok ? b.atoms : '0', startTs: String(startTs), periodSecs: String((hours ?? 0) * 3600), periodCap: cap && cap.ok ? cap.atoms : '0' })}
            onDone={reload}
          />
        </div>
      ) : (
        <div className="space-y-4" data-testid="greenshoe-state">
          <Facts
            rows={[
              ['Budget', fmt(g.budget, quoteDecimals, 'quote')],
              ['Placed so far', g.onChain ? fmt(g.onChain.deployed, quoteDecimals, 'quote') : 'unread'],
              ['Bids placed', `${g.bids.length}`],
              ['Levels settled', `${g.settled_levels.length}`],
              ['Window', `${utc(g.start_ts)} to ${utc(g.expires_ts)}${g.expired ? ' (over)' : ''}`],
              ['Finished', g.finished ? `yes: ${fmt(g.burned, null, '')} burned, ${fmt(g.returned, quoteDecimals, 'quote')} returned to you` : 'no'],
            ]}
          />
          {g.finished ? null : (
            <div className="grid gap-4 lg:grid-cols-3">
              {GREENSHOE_LEVELS.map((level) => (
                <Level key={level} level={level} account={account} cross={cross} g={g} quoteDecimals={quoteDecimals} reload={reload} wallet={wallet} />
              ))}
            </div>
          )}
          {!g.finished && g.expired ? (
            <div className="max-w-sm">
              <WalletAction account={account} label="Finish the greenshoe" variant="secondary" path="/v1/tx/finish-greenshoe" needs="crossSettle" what="The greenshoe" testId="finish-greenshoe" body={() => ({ cross, payer: wallet })} onDone={reload} />
              <p className="mt-1 text-xs text-muted">Burns what the bids bought and returns the unspent budget to you. Every placed level must be settled first.</p>
            </div>
          ) : null}
        </div>
      )}
    </Section>
  );
}

function Level({ level, account, cross, g, quoteDecimals, reload, wallet }: { level: number; account: ReturnType<typeof useWallet>['account']; cross: string; g: NonNullable<SettlementRead['greenshoe']>; quoteDecimals: number | null; reload: () => void; wallet: string | undefined }) {
  const [amount, setAmount] = useState('');
  const [key, setKey] = useState<FreshKey | null>(null);
  const order = g.onChain?.orders[level];
  const placed = order !== undefined && !isUnset(order);
  const settled = g.onChain?.levelSettled[level] === true;
  const a = amount.trim() === '' ? null : atomsOf(amount, quoteDecimals, 'The bid');
  useEffect(() => {
    let live = true;
    void freshKey().then((k) => live && setKey(k));
    return () => {
      live = false;
    };
  }, [placed]);
  return (
    <div className="space-y-3 rounded-lg border border-border p-4" data-testid={`gs-level-${level}`}>
      <div className="flex items-center gap-2">
        <span className="font-medium">Level {level + 1}</span>
        <Pill tone={settled ? 'info' : placed ? 'ok' : 'warn'}>{settled ? 'Settled' : placed ? 'Placed' : 'Open'}</Pill>
      </div>
      {!placed && !g.expired ? (
        <>
          <Text label="Amount, in quote tokens" value={amount} onChange={setAmount} inputMode="decimal" error={a && !a.ok ? a.error : undefined} hint="At most a third of the budget in one level, rounded up." />
          <WalletAction
            account={account}
            label={`Place level ${level + 1}`}
            variant="secondary"
            path="/v1/tx/deploy-greenshoe-bid"
            needs="crossSettle"
            what="The greenshoe"
            testId={`deploy-bid-${level}`}
            disabled={!a?.ok || key === null}
            disabledReason="Enter an amount."
            cosign={key ? (tx) => cosign(tx, key) : undefined}
            body={() => ({ cross, payer: wallet, limitOrder: key?.address, level, amount: a && a.ok ? a.atoms : '0' })}
            onDone={reload}
          />
          <p className="text-xs text-muted">A new limit-order account is made for this bid and signs next to your wallet. It holds nothing else and is not stored.</p>
        </>
      ) : null}
      {placed && !settled && g.expired ? (
        <WalletAction account={account} label={`Settle level ${level + 1}`} variant="secondary" path="/v1/tx/settle-greenshoe-level" needs="crossSettle" what="The greenshoe" testId={`settle-level-${level}`} body={() => ({ cross, payer: wallet, level })} onDone={reload} />
      ) : null}
      {placed && !g.expired ? <p className="text-xs text-muted">The bid stands until {utc(g.expires_ts)}.</p> : null}
      {!placed && g.expired ? <p className="text-xs text-muted">The week is over; this level was never placed.</p> : null}
    </div>
  );
}

/** An unplaced level holds the all-zero address, which base58 writes as a run of ones. */
const isUnset = (address: string) => /^1+$/.test(address);
