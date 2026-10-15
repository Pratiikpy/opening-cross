'use client';

import { isAddress } from '@solana/kit';
import { useEffect, useMemo, useState } from 'react';
import { Select, Text } from '@/components/issue-wizard/fields';
import { WalletAction } from '@/components/issuer/issuer-action';
import { Facts, Pill, Section } from '@/components/issuer/treasury-ui';
import { readMintFull } from '@/lib/issuer-chain';
import { apiRead, crossSummary, type CrossRow } from '@/lib/issuer-data';
import { type FreshKey, cosign, freshKey } from '@/lib/issuer-settle';
import { atomsOf } from '@/lib/issuer-treasury-console';
import { type AlphaForm, EMPTY_ALPHA, buildAlphaInit } from '@/lib/settle-open';
import { useWallet } from '@/lib/wallet';

type Account = ReturnType<typeof useWallet>['account'];
type Props = { cross: string; row: CrossRow | null; account: Account; wallet: string | undefined; baseDecimals: number | null; quoteDecimals: number | null };

/** A new keypair for an account an action creates (a limit order, a position). It lives in memory for the one action and is renewed after it. */
function useFresh(): [FreshKey | null, () => void] {
  const [key, setKey] = useState<FreshKey | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    void freshKey().then((k) => live && setKey(k));
    return () => {
      live = false;
    };
  }, [n]);
  return [key, () => setN((x) => x + 1)];
}

function useDecimals(mint: string | undefined): number | null {
  const [d, setD] = useState<number | null>(null);
  useEffect(() => {
    if (!mint || !isAddress(mint)) {
      setD(null);
      return;
    }
    let live = true;
    void readMintFull(mint).then((m) => live && setD(m.ok ? m.decimals : null));
    return () => {
      live = false;
    };
  }, [mint]);
  return d;
}

const addressError = (v: string) => (v.trim() !== '' && !isAddress(v.trim()) ? 'This is not a Solana address.' : undefined);
const days = (text: string): bigint | null => (/^\d{1,4}$/.test(text.trim()) && Number(text) >= 1 ? BigInt(text.trim()) * 86_400n : null);

/** Everything Meteora offers around a cross's market that the cross-settle page does not already cover. Each action is built by the API from the chain, simulated, and signed in the wallet. */
export function MeteoraMore() {
  const { account } = useWallet();
  const wallet = account?.address;
  const [typed, setTyped] = useState('');
  const [row, setRow] = useState<CrossRow | null>(null);
  const cross = typed.trim();
  const ok = isAddress(cross);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get('cross');
    if (q && isAddress(q)) setTyped(q);
  }, []);
  useEffect(() => {
    if (!ok) {
      setRow(null);
      return;
    }
    let live = true;
    void crossSummary(1000).then((r) => live && setRow(r.ok ? (r.data.crosses.find((c) => c.address === cross) ?? null) : null));
    return () => {
      live = false;
    };
  }, [cross, ok]);
  const baseDecimals = useDecimals(row?.baseMint);
  const quoteDecimals = useDecimals(row?.quoteMint);
  return (
    <div className="mt-12 space-y-6" id="more-meteora" data-testid="meteora-more">
      <div className="space-y-2">
        <h2 className="text-xl font-semibold">More around the market</h2>
        <p className="max-w-3xl text-sm text-muted">
          Reward streams for the pool’s liquidity providers, the conviction ladder and its rebalance, a change of mind in an Alpha Vault, and the buyer’s side of a fixed-price tranche. All of it is Meteora’s own program; this page builds the transactions, your wallet signs them, and nothing here holds
          your tokens.
        </p>
        <div className="max-w-xl">
          <Text label="Cross address" value={typed} onChange={setTyped} error={addressError(typed)} hint="The cross whose market these actions belong to." />
        </div>
      </div>
      {ok ? (
        <>
          <AlphaChange cross={cross} row={row} account={account ?? null} wallet={wallet} baseDecimals={baseDecimals} quoteDecimals={quoteDecimals} />
          <RewardSlots cross={cross} row={row} account={account ?? null} wallet={wallet} baseDecimals={baseDecimals} quoteDecimals={quoteDecimals} />
          <Ladder cross={cross} row={row} account={account ?? null} wallet={wallet} baseDecimals={baseDecimals} quoteDecimals={quoteDecimals} />
          <Tranche cross={cross} row={row} account={account ?? null} wallet={wallet} baseDecimals={baseDecimals} quoteDecimals={quoteDecimals} />
        </>
      ) : (
        <p className="text-sm text-muted" data-testid="more-pick">
          Enter a cross address to see what can be done with its market.
        </p>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------------------------------------ Alpha Vault, a change of mind
function AlphaChange({ cross, row, account, wallet, quoteDecimals }: Props) {
  const [amount, setAmount] = useState('');
  const [f, setF] = useState<AlphaForm>(EMPTY_ALPHA);
  const built = useMemo(() => buildAlphaInit(f, cross, wallet ?? null, quoteDecimals), [f, cross, wallet, quoteDecimals]);
  const parsed = amount.trim() === '' ? null : atomsOf(amount, quoteDecimals, 'The amount');
  const isCreator = row !== null && wallet !== undefined && row.creator === wallet;
  return (
    <Section id="alpha-more" title="Alpha Vault: a vault on a DLMM pair, and a change of mind" intro="A DLMM pair opened with “Bind an Alpha Vault” can have a vault of its own, filled from the issuer’s ladder before the pair opens. Whoever deposited into a pro-rata vault can take the deposit back until the vault starts buying, then close the empty escrow for its rent. A first-come vault does not give deposits back.">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-3 rounded-lg border border-border p-4" data-testid="alpha-dlmm-create">
          <p className="font-medium">Create the vault for the DLMM pair</p>
          <Select label="Mode" value={f.mode} onChange={(v) => setF({ ...f, mode: v as AlphaForm['mode'] })} options={[['prorata', 'Pro rata'], ['fcfs', 'First come, first served']]} />
          {f.mode === 'prorata' ? (
            <Text label="The most the vault buys, in quote tokens" value={f.buyingCap} onChange={(v) => setF({ ...f, buyingCap: v })} inputMode="decimal" error={f.buyingCap === '' ? undefined : built.errors.buyingCap} />
          ) : (
            <>
              <Text label="The most the vault takes in" value={f.depositCap} onChange={(v) => setF({ ...f, depositCap: v })} inputMode="decimal" error={f.depositCap === '' ? undefined : built.errors.depositCap} />
              <Text label="The most one wallet may deposit" value={f.perWalletCap} onChange={(v) => setF({ ...f, perWalletCap: v })} inputMode="decimal" error={f.perWalletCap === '' ? undefined : built.errors.perWalletCap} />
            </>
          )}
          <Text label="Claiming starts" type="datetime-local" mono={false} value={f.vestStart} onChange={(v) => setF({ ...f, vestStart: v })} error={f.vestStart === '' ? undefined : built.errors.vestStart} />
          <Text label="Vesting ends" type="datetime-local" mono={false} value={f.vestEnd} onChange={(v) => setF({ ...f, vestEnd: v })} error={f.vestEnd === '' ? undefined : built.errors.vestEnd} />
          <WalletAction account={account} label="Create the vault" variant="secondary" path="/v1/tx/alpha-vault-init" what="The Alpha Vault" testId="alpha-dlmm-init" disabled={!built.body || !isCreator} disabledReason={!isCreator ? 'Only the wallet that created the cross can create its vault.' : 'Fill in the fields marked above.'} body={() => (built.body ? { ...built.body, venue: 'dlmm' } : null)} onDone={() => undefined} />
        </div>
        <div className="space-y-3 rounded-lg border border-border p-4" data-testid="alpha-change">
          <p className="font-medium">Take a deposit back</p>
          <Text label="Amount, in quote tokens (empty: all of it)" value={amount} onChange={setAmount} inputMode="decimal" error={parsed && !parsed.ok ? parsed.error : undefined} />
          <WalletAction account={account} label="Withdraw" variant="secondary" path="/v1/tx/alpha-vault-withdraw" what="The Alpha Vault" testId="alpha-withdraw-deposit" disabled={parsed !== null && !parsed.ok} disabledReason="Enter a valid amount or leave it empty." connectHint="Connect the wallet that deposited." body={() => ({ cross, owner: wallet, ...(parsed && parsed.ok ? { amount: parsed.atoms } : {}) })} onDone={() => undefined} />
          <WalletAction account={account} label="Close my empty escrow" variant="secondary" path="/v1/tx/alpha-vault-close-escrow" what="The Alpha Vault" testId="alpha-close-escrow" connectHint="Connect the wallet that deposited." body={() => ({ cross, owner: wallet })} onDone={() => undefined} />
          <p className="text-xs text-muted">The API refuses with the reason when the vault is first come, has started buying, or the escrow still holds a deposit.</p>
        </div>
      </div>
    </Section>
  );
}

// ------------------------------------------------------------------------------------------------------------------------------ DAMM v2 reward slots
type Slot = { index: number; initialized: boolean; mint: string; funder: string; durationSecs: string; endsAt: string; perSecond: string; secondsLeft: string; streaming: boolean };
type RewardsRead = { pool: string; creator: string; liquidity: string; slots: Slot[]; note: string };

function RewardSlots({ cross, row, account, wallet }: Props) {
  const [rev, setRev] = useState(0);
  const [read, setRead] = useState<RewardsRead | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mint, setMint] = useState('');
  const [dur, setDur] = useState('7');
  const [funder, setFunder] = useState('');
  const [fundAmount, setFundAmount] = useState('');
  const [carry, setCarry] = useState(false);
  const [share, setShare] = useState('25');
  const [key, renew] = useFresh();
  useEffect(() => {
    let live = true;
    void apiRead<RewardsRead>(`/v1/crosses/${cross}/damm-rewards`).then((r) => {
      if (!live) return;
      if (r.ok) {
        setRead(r.data);
        setError(null);
      } else {
        setRead(null);
        setError(r.error);
      }
    });
    return () => {
      live = false;
    };
  }, [cross, rev]);
  const reload = () => setRev((r) => r + 1);
  const slot = read?.slots[0];
  const decimals = useDecimals(slot?.initialized ? slot.mint : undefined);
  const fundParsed = fundAmount.trim() === '' ? null : atomsOf(fundAmount, decimals, 'The amount');
  const secs = days(dur);
  const pct = Number(share);
  const shareBps = Number.isFinite(pct) && pct > 0 && pct <= 100 ? Math.round(pct * 100) : null;
  const isCreator = read !== null && wallet !== undefined && read.creator === wallet;
  return (
    <Section id="rewards" title="Reward stream for liquidity providers" intro="A DAMM v2 pool has two reward slots. The pool’s creator opens slot 0 and names who may fund it; the funder puts a token in, and the pool streams it to everyone who holds liquidity, in proportion to their share, including the issuer’s own position. Meteora’s program does the streaming and the claiming.">
      {error ? (
        <p role="alert" className="text-sm text-accent-text" data-testid="rewards-error">
          {error}
        </p>
      ) : null}
      {read && slot ? (
        <div data-testid="rewards-state">
          <Facts
            rows={[
              ['Pool', read.pool],
              ['Slot 0', slot.initialized ? <Pill tone={slot.streaming ? 'ok' : 'info'}>{slot.streaming ? 'streaming' : 'open, not streaming'}</Pill> : <Pill tone="warn">not opened</Pill>],
              ...(slot.initialized ? ([['Reward token', slot.mint], ['Only this wallet may fund it', slot.funder], ['Streams over', `${Number(slot.durationSecs) / 86_400} days from each funding`], ['Rate now', `${slot.perSecond} atoms per second`], ['Seconds left', slot.streaming ? slot.secondsLeft : '0']] as [string, string][]) : []),
            ]}
          />
        </div>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-3 rounded-lg border border-border p-4" data-testid="rewards-open">
          <p className="font-medium">Open slot 0</p>
          <Text label="Reward token (mint address)" value={mint} onChange={setMint} error={addressError(mint)} />
          <Text label="Each funding streams over, days (1 to 365)" value={dur} onChange={setDur} inputMode="numeric" error={secs === null || secs > 365n * 86_400n ? 'A whole number of days from 1 to 365.' : undefined} />
          <Text label="Only this wallet may fund (empty: you)" value={funder} onChange={setFunder} error={addressError(funder)} />
          <WalletAction account={account} label="Open the slot" variant="secondary" path="/v1/tx/damm-reward-init" what="Reward slots" testId="rewards-init" disabled={!isAddress(mint.trim()) || secs === null || secs > 365n * 86_400n || (funder.trim() !== '' && !isAddress(funder.trim())) || !isCreator} disabledReason={!isCreator ? 'Only the pool’s creator can open slot 0.' : 'Fill in the fields marked above.'} body={() => ({ cross, signer: wallet, rewardMint: mint.trim(), durationSecs: String(secs), ...(funder.trim() !== '' ? { funder: funder.trim() } : {}) })} onDone={reload} />
        </div>
        <div className="space-y-3 rounded-lg border border-border p-4" data-testid="rewards-fund">
          <p className="font-medium">Fund slot 0</p>
          <Text label="Amount of the reward token" value={fundAmount} onChange={setFundAmount} inputMode="decimal" error={fundParsed && !fundParsed.ok ? fundParsed.error : undefined} hint="The stream runs for the slot’s duration from now." />
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={carry} onChange={(e) => setCarry(e.target.checked)} />
            <span>Carry what has not streamed yet into this funding</span>
          </label>
          <WalletAction account={account} label="Fund the slot" variant="secondary" path="/v1/tx/damm-reward-fund" what="Reward slots" testId="rewards-fund-go" disabled={!slot?.initialized || !fundParsed || !fundParsed.ok} disabledReason={!slot?.initialized ? 'Open the slot first.' : 'Enter an amount.'} connectHint="Connect the funder’s wallet." body={() => ({ cross, funder: wallet, amount: fundParsed && fundParsed.ok ? fundParsed.atoms : '0', carryForward: carry })} onDone={reload} />
        </div>
        <div className="space-y-3 rounded-lg border border-border p-4" data-testid="rewards-claim">
          <p className="font-medium">Claim my share</p>
          <p className="text-sm text-muted">Pays what slot 0 has streamed to the pool’s issuer position. Holders who joined the pool claim their own position the same way.</p>
          <WalletAction account={account} label="Claim" variant="secondary" path="/v1/tx/damm-reward-claim" what="Reward slots" testId="rewards-claim-go" disabled={!slot?.initialized} disabledReason="Slot 0 is not open." connectHint="Connect the wallet that holds the position." body={() => ({ cross, owner: wallet })} onDone={reload} />
        </div>
        <div className="space-y-3 rounded-lg border border-border p-4" data-testid="rewards-join">
          <p className="font-medium">Join the pool with liquidity of my own</p>
          <Text label="Share of the pool’s current liquidity, %" value={share} onChange={setShare} inputMode="decimal" error={shareBps === null ? 'A percentage above 0 and up to 100.' : undefined} hint="Both tokens are taken in the pool’s ratio, with 1% of room for the price to move." />
          <WalletAction account={account} label="Join the pool" variant="secondary" path="/v1/tx/damm-lp-join" what="Joining the pool" testId="rewards-join-go" disabled={shareBps === null || !key} disabledReason="Enter a percentage." cosign={key ? (tx) => cosign(tx, key) : undefined} connectHint="Connect the wallet that will own the position." body={() => ({ cross, owner: wallet, positionNftMint: key?.address, shareBps })} onDone={() => { renew(); reload(); }} />
          <p className="text-xs text-muted">A new account is made for your position NFT and signs next to your wallet. It holds nothing and is not stored.</p>
        </div>
      </div>
    </Section>
  );
}

// ------------------------------------------------------------------------------------------------------------------------------ the conviction ladder
type LadderRead = { pair: string; activeId: number; position: string; owner: string; lowerBinId: number; upperBinId: number; baseLeft: string; quoteEarned: string; status: { untouched: boolean; passed: boolean; worthRebalancing: boolean; baseFrom: number | null; baseTo: number | null }; note: string };

function Ladder({ cross, row, account, wallet, baseDecimals, quoteDecimals }: Props) {
  const [position, setPosition] = useState('');
  const [read, setRead] = useState<LadderRead | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bins, setBins] = useState('30');
  const [shape, setShape] = useState('flat');
  const [amount, setAmount] = useState('');
  const [count, setCount] = useState('6');
  const [order, setOrder] = useState('');
  const [binIds, setBinIds] = useState('');
  const [keyA, renewA] = useFresh();
  const [keyB, renewB] = useFresh();
  const look = async () => {
    setRead(null);
    setError(null);
    const r = await apiRead<LadderRead>(`/v1/crosses/${cross}/ladder?position=${position.trim()}`);
    if (r.ok) setRead(r.data);
    else setError(r.error);
  };
  const parsed = amount.trim() === '' ? null : atomsOf(amount, baseDecimals, 'The amount');
  const binList = binIds.split(',').map((x) => x.trim()).filter((x) => x !== '');
  const binsOk = binList.length > 0 && binList.every((x) => /^-?\d{1,7}$/.test(x));
  const n = Number(bins);
  const cnt = Number(count);
  const fmt = (atoms: string, d: number | null) => (d === null ? atoms : (Number(atoms) / 10 ** d).toLocaleString(undefined, { maximumFractionDigits: d }));
  void row;
  return (
    <Section id="ladder" title="Conviction ladder" intro="Unsold base tokens can stand above the clearing price as liquidity in a position, or as limit orders. Buyers who want more than the call gave them walk up the ladder at its prices. Once they have walked into it, a rebalance withdraws what is left and lays the base again above the new price. The ladder is yours to withdraw: Meteora lets you cancel or withdraw it a second after you place it. It shows depth; it is not a lock.">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-3 rounded-lg border border-border p-4" data-testid="ladder-read">
          <p className="font-medium">Read a ladder position</p>
          <Text label="Position address" value={position} onChange={setPosition} error={addressError(position)} />
          <button type="button" onClick={() => void look()} disabled={!isAddress(position.trim())} data-testid="ladder-look" className="min-h-11 rounded-full border border-border-strong px-4 py-2 text-sm hover:bg-surface disabled:opacity-50">
            Read it
          </button>
          {error ? (
            <p role="alert" className="text-sm text-accent-text" data-testid="ladder-error">
              {error}
            </p>
          ) : null}
          {read ? (
            <div data-testid="ladder-state">
              <Facts
                rows={[
                  ['Market is at bin', String(read.activeId)],
                  ['Ladder spans bins', `${read.lowerBinId} to ${read.upperBinId}`],
                  ['Base still in it', fmt(read.baseLeft, baseDecimals)],
                  ['Quote it has earned', fmt(read.quoteEarned, quoteDecimals)],
                  ['Status', read.status.untouched ? <Pill tone="ok">untouched: it stands above the market</Pill> : read.status.baseFrom === null ? <Pill tone="info">sold out</Pill> : <Pill tone="warn">the market has walked into it</Pill>],
                ]}
              />
            </div>
          ) : null}
        </div>
        <div className="space-y-3 rounded-lg border border-border p-4" data-testid="ladder-rebalance">
          <p className="font-medium">Rebalance</p>
          <p className="text-sm text-muted">Two steps, each signed by you. First withdraw the position (its quote is your proceeds; its base returns to your wallet). Then lay that base again above the new price.</p>
          <WalletAction account={account} label="1. Withdraw the position" variant="secondary" path="/v1/tx/ladder-rebalance-withdraw" what="Rebalancing" testId="ladder-withdraw" disabled={!isAddress(position.trim()) || !read?.status.worthRebalancing} disabledReason={!read ? 'Read the position first.' : 'Nothing to rebalance: no buyer has reached it, or it holds no base.'} body={() => ({ cross, owner: wallet, position: position.trim() })} onDone={() => undefined} />
          <Text label="Bins in the new ladder (1 to 70)" value={bins} onChange={setBins} inputMode="numeric" error={Number.isInteger(n) && n >= 1 && n <= 70 ? undefined : 'A whole number from 1 to 70.'} />
          <Select label="Shape" value={shape} onChange={setShape} options={[['flat', 'Even'], ['taper', 'More near the price'], ['wall', 'More at the top']]} />
          <WalletAction account={account} label="2. Lay the base again" variant="secondary" path="/v1/tx/ladder-rebalance-relay" what="Rebalancing" testId="ladder-relay" disabled={!read || read.baseLeft === '0' || !keyA || !(Number.isInteger(n) && n >= 1 && n <= 70)} disabledReason={!read ? 'Read the position first.' : 'There is no base left to lay.'} cosign={keyA ? (tx) => cosign(tx, keyA) : undefined} body={() => ({ cross, owner: wallet, newPosition: keyA?.address, baseAmount: read?.baseLeft, bins: n, shape })} onDone={() => renewA()} />
          <p className="text-xs text-muted">The amount in step 2 is what step 1 returned; the API refuses if your wallet holds less.</p>
        </div>
        <div className="space-y-3 rounded-lg border border-border p-4" data-testid="ladder-orders">
          <p className="font-medium">Sell above the price with limit orders</p>
          <Text label="Base tokens to sell" value={amount} onChange={setAmount} inputMode="decimal" error={parsed && !parsed.ok ? parsed.error : undefined} />
          <Text label="Rungs (1 to 70)" value={count} onChange={setCount} inputMode="numeric" error={Number.isInteger(cnt) && cnt >= 1 && cnt <= 70 ? undefined : 'A whole number from 1 to 70.'} />
          <WalletAction account={account} label="Place the limit orders" variant="secondary" path="/v1/tx/ladder-limit-place" what="Limit orders" testId="ladder-place" disabled={!parsed || !parsed.ok || !keyB || !(Number.isInteger(cnt) && cnt >= 1 && cnt <= 70)} disabledReason="Enter an amount." cosign={keyB ? (tx) => cosign(tx, keyB) : undefined} body={() => ({ cross, owner: wallet, limitOrder: keyB?.address, baseAmount: parsed && parsed.ok ? parsed.atoms : '0', count: cnt, shape })} onBuilt={(x) => setOrder(typeof x.limitOrder === 'string' ? x.limitOrder : '')} onDone={() => renewB()} />
          <p className="text-xs text-muted">Each rung sells a fixed amount at one price and earns no trading fee. A new account is made for the order and signs next to your wallet.</p>
        </div>
        <div className="space-y-3 rounded-lg border border-border p-4" data-testid="ladder-cancel">
          <p className="font-medium">Cancel or close a limit order</p>
          <Text label="Limit order address" value={order} onChange={setOrder} error={addressError(order)} />
          <Text label="Bin ids to cancel, comma separated" value={binIds} onChange={setBinIds} error={binIds.trim() !== '' && !binsOk ? 'Whole bin ids, separated by commas.' : undefined} hint="The placement showed them." />
          <WalletAction account={account} label="Cancel these rungs" variant="secondary" path="/v1/tx/ladder-limit-cancel" what="Limit orders" testId="ladder-cancel-go" disabled={!isAddress(order.trim()) || !binsOk} disabledReason="Enter the order and its bins." body={() => ({ cross, owner: wallet, limitOrder: order.trim(), binIds: binList.map(Number) })} onDone={() => undefined} />
          <WalletAction account={account} label="Close the empty order" variant="secondary" path="/v1/tx/ladder-limit-close" what="Limit orders" testId="ladder-close-go" disabled={!isAddress(order.trim())} disabledReason="Enter the order." body={() => ({ cross, owner: wallet, limitOrder: order.trim() })} onDone={() => undefined} />
        </div>
      </div>
    </Section>
  );
}

// ------------------------------------------------------------------------------------------------------------------------------ the fixed-price tranche, buyer side
function Tranche({ cross, account, wallet, quoteDecimals }: Props) {
  const [base, setBase] = useState('');
  const [amount, setAmount] = useState('');
  const parsed = amount.trim() === '' ? null : atomsOf(amount, quoteDecimals, 'The amount');
  const baseOk = isAddress(base.trim());
  return (
    <Section id="tranche" title="Fixed-price tranche: deposit, claim, withdraw" intro="A tranche sells more of the token to people who did not bid, at exactly the price the call discovered. Buyers deposit quote tokens while the sale is open and claim the tokens once it has ended or filled; the issuer then withdraws what was raised. The tranche’s key is the address the issuer used when opening it. A token with the transfer hook is handled: the hook’s accounts are added for you.">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-3 rounded-lg border border-border p-4" data-testid="tranche-buyer">
          <p className="font-medium">As a buyer</p>
          <Text label="The tranche’s key (the issuer shares it)" value={base} onChange={setBase} error={addressError(base)} />
          <Text label="Deposit, in quote tokens" value={amount} onChange={setAmount} inputMode="decimal" error={parsed && !parsed.ok ? parsed.error : undefined} hint="The vault takes less than you ask when the sale’s cap or your own cap leaves less room." />
          <WalletAction account={account} label="Deposit" variant="secondary" path="/v1/tx/presale-deposit" what="The tranche" testId="tranche-deposit" disabled={!baseOk || !parsed || !parsed.ok} disabledReason="Enter the tranche and an amount." connectHint="Connect the wallet that buys." body={() => ({ cross, base: base.trim(), buyer: wallet, amount: parsed && parsed.ok ? parsed.atoms : '0' })} onDone={() => undefined} />
          <WalletAction account={account} label="Claim my tokens" variant="secondary" path="/v1/tx/presale-claim" what="The tranche" testId="tranche-claim" disabled={!baseOk} disabledReason="Enter the tranche." connectHint="Connect the wallet that bought." body={() => ({ cross, base: base.trim(), buyer: wallet })} onDone={() => undefined} />
        </div>
        <div className="space-y-3 rounded-lg border border-border p-4" data-testid="tranche-issuer">
          <p className="font-medium">As the issuer</p>
          <WalletAction account={account} label="Withdraw what was raised" variant="secondary" path="/v1/tx/presale-creator-withdraw" what="The tranche" testId="tranche-withdraw" disabled={!baseOk} disabledReason="Enter the tranche’s key on the left." connectHint="Connect the wallet that created the cross." body={() => ({ cross, base: base.trim(), creator: wallet })} onDone={() => undefined} />
          <p className="text-xs text-muted">Allowed once, after the sale has completed. A failed sale returns the base token instead. Opening a tranche is on the form above, under “Open the market”.</p>
        </div>
      </div>
    </Section>
  );
}
