'use client';

import { useEffect, useMemo, useState } from 'react';
import { Text } from '@/components/issue-wizard/fields';
import { readMintFull } from '@/lib/issuer-chain';
import { apiRead, type CrossRow } from '@/lib/issuer-data';
import {
  type DammForm, type DbcForm, type DlmmForm, type RaydiumForm,
  EMPTY_DAMM, EMPTY_DBC, EMPTY_DLMM, EMPTY_RAYDIUM, buildDamm, buildDbc, buildDlmm, buildRaydium,
} from '@/lib/settle-open';
import { shortAddress } from '@/lib/units';
import type { useWallet } from '@/lib/wallet';
import { WalletAction } from './issuer-action';
import { Facts, Pill, Section } from './treasury-ui';

type Account = ReturnType<typeof useWallet>['account'];
export type Venues = {
  cross: string;
  state: string;
  creator: string;
  clearingPrice: string | null;
  baseBound: boolean;
  deferredMintWithSettler: boolean;
  venues: Record<string, { opened?: boolean; pool?: string | null; lbPair?: string | null } | null>;
  available: string[];
  note: string;
};

const VENUE_LABEL: Record<string, string> = { dbc: 'Meteora DBC continuation', dammV2: 'Meteora DAMM v2 pool', dlmm: 'Meteora DLMM pair', raydiumCpmm: 'Raydium CPMM pool' };
const ROUTE_OF: Record<string, string> = { 'open-dbc-pool': 'DBC continuation', 'bind-dbc-mint': 'binding the mint', 'seed-damm-v2': 'DAMM v2 pool', 'open-dlmm-pair': 'DLMM pair', 'seed-raydium-cpmm': 'Raydium CPMM pool' };

/** What the API says can be opened for this cross now. A read that fails is shown as unread, never as "nothing can be opened". */
export function useVenues(cross: string, rev: number): { venues: Venues | null; error: string | null } {
  const [state, setState] = useState<{ venues: Venues | null; error: string | null }>({ venues: null, error: null });
  useEffect(() => {
    let live = true;
    void apiRead<Venues>(`/v1/crosses/${cross}/venues`).then((r) => live && setState(r.ok ? { venues: r.data, error: null } : { venues: null, error: r.error }));
    return () => {
      live = false;
    };
  }, [cross, rev]);
  return state;
}

const Check = ({ label, checked, onChange, hint, error }: { label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string; error?: string | undefined }) => (
  <div className="text-sm">
    <label className="flex min-h-11 items-center gap-3">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="size-5" />
      <span>{label}</span>
    </label>
    {error ? <span className="block text-xs text-accent-text">{error}</span> : hint ? <span className="block text-xs text-muted">{hint}</span> : null}
  </div>
);

/** Opens a liquidity venue at the clearing price: the DBC continuation, a DAMM v2 pool (plain, batched, with an Alpha Vault, locked), a DLMM pair (plain, batched, badged) or a Raydium pool. */
export function MarketOpening({ cross, row, account, wallet, reload }: { cross: string; row: CrossRow | null; account: Account; wallet: string | undefined; reload: () => void }) {
  const [rev, setRev] = useState(0);
  const { venues, error } = useVenues(cross, rev);
  const [decimals, setDecimals] = useState<{ base: number | null; quote: number | null }>({ base: null, quote: null });
  useEffect(() => {
    if (!row) return;
    let live = true;
    void Promise.all([readMintFull(row.baseMint), readMintFull(row.quoteMint)]).then(([b, q]) => live && setDecimals({ base: b.ok ? b.decimals : null, quote: q.ok ? q.decimals : null }));
    return () => {
      live = false;
    };
  }, [row]);
  const done = () => {
    setRev((r) => r + 1);
    reload();
  };
  const isCreator = Boolean(venues && wallet && venues.creator === wallet);
  const off = (route: string): string | undefined => {
    if (!venues) return 'Reading what can be opened…';
    if (venues.state === 'Live') return 'The cross has not settled yet.';
    if (venues.clearingPrice === null) return 'The cross did not print a price, so there is nothing to open a market at.';
    if (!venues.available.includes(route)) return `This cannot be opened now: ${venues.note}`;
    if (!isCreator) return `Only the wallet that created the cross can open its market (${shortAddress(venues.creator)}).`;
    return undefined;
  };
  return (
    <Section
      id="open"
      title="Open the market"
      intro="After a cross prints, its creator opens a pool at exactly the clearing price, so the price the auction found is the price the pool starts at. Every form below is built by the API and checked against the cluster and the program’s own rules before your wallet is asked; a refusal is shown in words and nothing is signed."
    >
      {error ? (
        <p role="alert" className="text-sm text-accent-text" data-testid="venues-error">
          What can be opened could not be read: {error}
        </p>
      ) : null}
      {venues ? (
        <div data-testid="venues">
          <Facts
            rows={[
              ['Clearing price', venues.clearingPrice ?? 'none: the cross did not print'],
              ['Base token', venues.baseBound ? 'created' : 'not created yet'],
              ...Object.entries(venues.venues).map(([k, v]): [string, React.ReactNode] => [VENUE_LABEL[k] ?? k, v ? (v.opened ? <Pill key={k} tone="ok">opened</Pill> : <Pill key={k}>not opened</Pill>) : 'not available until the base token exists']),
              ['Available now', venues.available.length === 0 ? 'nothing' : venues.available.map((a) => ROUTE_OF[a] ?? a).join(', ')],
            ]}
          />
          {venues.note ? <p className="mt-3 text-sm text-muted">{venues.note}</p> : null}
        </div>
      ) : null}
      <div className="grid gap-5 lg:grid-cols-2">
        <Dbc cross={cross} account={account} wallet={wallet} off={off} done={done} />
        <Damm cross={cross} account={account} wallet={wallet} off={off('seed-damm-v2')} decimals={decimals} done={done} />
        <Dlmm cross={cross} account={account} wallet={wallet} off={off('open-dlmm-pair')} done={done} />
        <Raydium cross={cross} account={account} wallet={wallet} off={off('seed-raydium-cpmm')} decimals={decimals} done={done} />
      </div>
      <div className="rounded-lg border border-border p-4 text-sm" data-testid="fee-bridge-note">
        <p className="font-medium">Fees of a DBC pool</p>
        <p className="mt-1 text-muted">
          The partner’s trading fees of a DBC continuation reach the fee recipient through the payouts above. A bridge that sends the pool’s creator or partner fees into a fee-sharing vault is not offered: Meteora’s fee-sharing program claims a DBC pool’s fees only when the vault is the pool’s creator or fee claimer, and a pool this protocol opens fixes both (the issuer’s wallet and the settler). Moving the creator would strand its locked and vesting liquidity. After the pool migrates, the DAMM v2 position’s fees do go through a vault (below).
        </p>
      </div>
    </Section>
  );
}

function Frame({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3 rounded-lg border border-border p-4" data-testid={`open-${id}`}>
      <p className="font-medium">{title}</p>
      {children}
    </div>
  );
}

function Dbc({ cross, account, wallet, off, done }: { cross: string; account: Account; wallet: string | undefined; off: (r: string) => string | undefined; done: () => void }) {
  const [f, setF] = useState<DbcForm>(EMPTY_DBC);
  const built = useMemo(() => buildDbc(f, cross, wallet ?? null), [f, cross, wallet]);
  const reason = off('open-dbc-pool');
  return (
    <Frame id="dbc" title="DBC continuation: a locked, compounding curve from the clearing price">
      <p className="text-xs text-muted">Creates the curve and the pool at the clearing price and binds the base token, in one transaction when they fit. The design below is the locked, compounding one the program accepts; the API names every departure from it.</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <Text label="Name" value={f.name} onChange={(v) => setF({ ...f, name: v })} mono={false} error={f.name !== '' ? built.errors.name : undefined} />
        <Text label="Symbol" value={f.symbol} onChange={(v) => setF({ ...f, symbol: v })} mono={false} error={f.symbol !== '' ? built.errors.symbol : undefined} />
        <Text label="Metadata link" value={f.uri} onChange={(v) => setF({ ...f, uri: v })} error={f.uri !== '' ? built.errors.uri : undefined} />
      </div>
      <div className="text-sm">
        <label className="block">
          <span className="text-muted">Curve design (JSON)</span>
          <textarea value={f.design} onChange={(e) => setF({ ...f, design: e.target.value })} rows={8} spellCheck={false} aria-invalid={Boolean(built.errors.design)} className="mt-1 w-full rounded-lg border border-border-strong bg-bg px-3 py-2.5 font-mono text-xs" data-testid="dbc-design" />
        </label>
        {built.errors.design ? <span className="block text-xs text-accent-text">{built.errors.design}</span> : null}
      </div>
      <Check label="Keep the opening liquidity locked" checked={f.locked} onChange={(v) => setF({ ...f, locked: v })} hint={f.locked ? 'The pool is opened with open_dbc_pool_locked: the creator’s and partner’s liquidity is locked and vesting, and the migration compounds.' : 'Opens with open_dbc_pool: the program does not promise buyers that the opening liquidity stays locked.'} />
      <WalletAction account={account} label="Open the DBC pool" variant="secondary" path="/v1/tx/open-dbc-pool" needs="crossSettle" what="The locked DBC continuation" testId="open-dbc-pool" disabled={Boolean(reason) || !built.body} disabledReason={reason ?? 'Fill in the name, symbol and link.'} body={() => built.body} onDone={done} />
      <WalletAction account={account} label="Bind the base token" variant="secondary" path="/v1/tx/bind-dbc-mint" needs="crossSettle" what="Binding the DBC mint" testId="bind-dbc-mint" disabled={Boolean(off('bind-dbc-mint'))} disabledReason={off('bind-dbc-mint')} connectHint="Anyone can send this once the pool exists." body={() => ({ cross, payer: wallet })} onDone={done} />
    </Frame>
  );
}

function Damm({ cross, account, wallet, off, decimals, done }: { cross: string; account: Account; wallet: string | undefined; off: string | undefined; decimals: { base: number | null; quote: number | null }; done: () => void }) {
  const [f, setF] = useState<DammForm>(EMPTY_DAMM);
  const [landBy, setLandBy] = useState<string | null>(null);
  const now = Math.floor(Date.now() / 1000);
  const built = useMemo(() => buildDamm(f, cross, wallet ?? null, decimals, now), [f, cross, wallet, decimals, now]);
  const e = built.errors;
  const touched = (k: keyof DammForm) => (f[k] === '' || f[k] === false ? undefined : e[k]);
  return (
    <Frame id="damm" title="DAMM v2 pool at the clearing price">
      <p className="text-xs text-muted">A full-range pool whose first price is exactly the price the cross printed. It can open closed for a batch window with a fee that steps down, with an Alpha Vault that buys before the public, and with its liquidity locked from the first block.</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <Text label="Base tokens to deposit" value={f.baseAmount} onChange={(v) => setF({ ...f, baseAmount: v })} inputMode="decimal" error={touched('baseAmount')} />
        <Text label="Quote tokens to deposit" value={f.quoteAmount} onChange={(v) => setF({ ...f, quoteAmount: v })} inputMode="decimal" error={touched('quoteAmount')} />
        <Text label="Pool fee, %" value={f.feePct} onChange={(v) => setF({ ...f, feePct: v })} inputMode="decimal" error={e.feePct} hint={f.batch ? 'The fee the pool opens with.' : undefined} />
      </div>
      <Check label="Open closed for a batch window" checked={f.batch} onChange={(v) => setF({ ...f, batch: v })} hint="Swaps are refused until the start. The fee then decays from the opening fee to the ending fee." />
      {f.batch ? (
        <div className="grid gap-3 sm:grid-cols-2" data-testid="damm-batch">
          <Text label="Swaps open at" type="datetime-local" mono={false} value={f.startAt} onChange={(v) => setF({ ...f, startAt: v })} error={e.startAt} hint="In your time zone." />
          <Text label="Window, minutes" value={f.windowMins} onChange={(v) => setF({ ...f, windowMins: v })} inputMode="numeric" error={e.windowMins} hint="How long before the start the transaction must land." />
          <Text label="Ending fee, %" value={f.endingFeePct} onChange={(v) => setF({ ...f, endingFeePct: v })} inputMode="decimal" error={e.endingFeePct} />
          <Text label="Fee periods" value={f.periods} onChange={(v) => setF({ ...f, periods: v })} inputMode="numeric" error={e.periods} />
          <Text label="Each period, minutes" value={f.periodMins} onChange={(v) => setF({ ...f, periodMins: v })} inputMode="numeric" error={e.periodMins} />
        </div>
      ) : null}
      <Check label="Bind an Alpha Vault" checked={f.alphaVault} onChange={(v) => setF({ ...f, alphaVault: v })} error={e.alphaVault} hint="Before the public start only the vault can buy. Create the vault below once the pool exists." />
      <Check label="Lock all of the pool’s liquidity for good" checked={f.lockAll} onChange={(v) => setF({ ...f, lockAll: v })} hint="Locked liquidity can never be withdrawn; its trading fees can still be claimed." />
      <WalletAction account={account} label="Open the DAMM v2 pool" variant="secondary" path="/v1/tx/seed-damm-v2" needs="crossSettle" what={f.batch ? 'Batch-opened pools' : 'The DAMM v2 pool'} testId="seed-damm-v2" disabled={Boolean(off) || !built.body} disabledReason={off ?? 'Fill in the fields marked above.'} body={() => built.body} onBuilt={(x) => setLandBy(x.landBy ? String(x.landBy) : null)} onDone={done} />
      {landBy ? (
        <p className="text-xs text-muted" role="status" data-testid="land-by">
          The program refuses the start if the transaction lands after {new Date(Number(landBy) * 1000).toISOString().replace('T', ' ').slice(0, 19)} UTC.
        </p>
      ) : null}
    </Frame>
  );
}

function Dlmm({ cross, account, wallet, off, done }: { cross: string; account: Account; wallet: string | undefined; off: string | undefined; done: () => void }) {
  const [f, setF] = useState<DlmmForm>(EMPTY_DLMM);
  const now = Math.floor(Date.now() / 1000);
  const built = useMemo(() => buildDlmm(f, cross, wallet ?? null, now), [f, cross, wallet, now]);
  const e = built.errors;
  const shown = (k: keyof DlmmForm) => (f[k] === '' || f[k] === false ? undefined : e[k]);
  return (
    <Frame id="dlmm" title="DLMM pair around the clearing price">
      <p className="text-xs text-muted">A pair whose active bin holds the clearing price. It can open closed for a batch window, and for a stock-quoted token it can open behind the two Token Badges Meteora issued, which the real program otherwise refuses.</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <Text label="Bin step, bps" value={f.binStep} onChange={(v) => setF({ ...f, binStep: v })} inputMode="numeric" error={shown('binStep')} />
        <Text label="Base factor" value={f.baseFactor} onChange={(v) => setF({ ...f, baseFactor: v })} inputMode="numeric" error={shown('baseFactor')} />
        <Text label="Power factor (optional)" value={f.baseFeePowerFactor} onChange={(v) => setF({ ...f, baseFeePowerFactor: v })} inputMode="numeric" error={e.baseFeePowerFactor} />
      </div>
      <Check label="Open closed for a batch window" checked={f.batch} onChange={(v) => setF({ ...f, batch: v })} />
      {f.batch ? (
        <div className="grid gap-3 sm:grid-cols-2" data-testid="dlmm-batch">
          <Text label="Swaps open at" type="datetime-local" mono={false} value={f.startAt} onChange={(v) => setF({ ...f, startAt: v })} error={e.startAt} hint="In your time zone." />
          <Text label="Window, minutes" value={f.windowMins} onChange={(v) => setF({ ...f, windowMins: v })} inputMode="numeric" error={e.windowMins} />
        </div>
      ) : null}
      <Check label="Bind an Alpha Vault" checked={f.alphaVault} onChange={(v) => setF({ ...f, alphaVault: v })} error={e.alphaVault} hint="The DLMM Alpha Vault fill is not built: the pair is bound to a vault, but filling it is not offered here." />
      <div className="grid gap-1 sm:grid-cols-2">
        <Check label="The base token needs a Token Badge" checked={f.badgeBase} onChange={(v) => setF({ ...f, badgeBase: v })} />
        <Check label="The quote token needs a Token Badge" checked={f.badgeQuote} onChange={(v) => setF({ ...f, badgeQuote: v })} hint="A listed stock carries extensions the real DLMM refuses without a badge. Only Meteora issues badges; the API checks that each token's badge account exists and belongs to DLMM, and names it when it does not." />
      </div>
      <WalletAction account={account} label={f.badgeBase || f.badgeQuote ? 'Open the badged DLMM pair' : 'Open the DLMM pair'} variant="secondary" path="/v1/tx/open-dlmm-pair" needs="crossSettle" what={f.badgeBase || f.badgeQuote ? 'Stock-quoted pairs behind a Token Badge' : 'The DLMM pair'} testId="open-dlmm-pair" disabled={Boolean(off) || !built.body} disabledReason={off ?? 'Fill in the bin step and the base factor.'} body={() => built.body} onDone={done} />
    </Frame>
  );
}

function Raydium({ cross, account, wallet, off, decimals, done }: { cross: string; account: Account; wallet: string | undefined; off: string | undefined; decimals: { base: number | null; quote: number | null }; done: () => void }) {
  const [f, setF] = useState<RaydiumForm>(EMPTY_RAYDIUM);
  const built = useMemo(() => buildRaydium(f, cross, wallet ?? null, decimals), [f, cross, wallet, decimals]);
  const e = built.errors;
  return (
    <Frame id="raydium" title="Raydium CPMM pool">
      <p className="text-xs text-muted">A constant-product pool at the clearing price. You choose the base amount; the quote amount follows from the price.</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <Text label="Base tokens to deposit" value={f.baseAmount} onChange={(v) => setF({ ...f, baseAmount: v })} inputMode="decimal" error={f.baseAmount === '' ? undefined : e.baseAmount} />
        <Text label="Fee tier (config index)" value={f.ammConfigIndex} onChange={(v) => setF({ ...f, ammConfigIndex: v })} inputMode="numeric" error={e.ammConfigIndex} hint="Empty: the first." />
        <Text label="Opens at (optional)" type="datetime-local" mono={false} value={f.openAt} onChange={(v) => setF({ ...f, openAt: v })} error={e.openAt} hint="Empty: at once." />
      </div>
      <WalletAction account={account} label="Open the Raydium pool" variant="secondary" path="/v1/tx/seed-raydium-cpmm" needs="crossSettle" what="The Raydium pool" testId="seed-raydium-cpmm" disabled={Boolean(off) || !built.body} disabledReason={off ?? 'Enter the base amount.'} body={() => built.body} onDone={done} />
    </Frame>
  );
}

