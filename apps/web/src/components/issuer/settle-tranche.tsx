'use client';

import { useEffect, useMemo, useState } from 'react';
import { Text } from '@/components/issue-wizard/fields';
import { FeatureAction, FeatureNotice, Plain } from '@/components/w4/ui';
import type { GraduationRead } from '@/lib/graduation';
import { venueLabel } from '@/lib/graduation';
import { type FreshKey, cosign, freshKey } from '@/lib/issuer-settle';
import { EMPTY_FUTARCHY, EMPTY_PRESALE, type FutarchyForm, type PresaleForm, buildFutarchy, buildPresale, depositLine, fullSaleProceeds, futarchyBlocker } from '@/lib/tranche';
import type { CrossDetail } from '@/lib/types';
import { useMint, useRead } from '@/lib/use-read';
import { formatAtoms, parseAtoms, shortAddress } from '@/lib/units';
import type { useWallet } from '@/lib/wallet';

type Account = ReturnType<typeof useWallet>['account'];

function Frame({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3 rounded-lg border border-border p-4" data-testid={`open-${id}`}>
      <p className="font-medium">{title}</p>
      {children}
    </div>
  );
}

const Check = ({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) => (
  <label className="flex min-h-11 items-center gap-3 text-sm">
    <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="size-5" />
    <span>{label}</span>
  </label>
);

/** A new keypair for the presale's base account. It lives in memory for the one action and is renewed after it. */
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

/**
 * The fixed-price tranche (B4) and the MetaDAO futarchy DAO (X3) of the settle page. Both are instructions of the batch 2 build of cross_settle, so each says
 * whether the connected network has it and is off, with the reason, while it does not. The vote of a governed cross gates the DAO and not the tranche.
 */
export function TrancheSteps({ cross, clearingPrice, baseBound, creator, account, wallet, graduation, done }: { cross: string; clearingPrice: string | null; baseBound: boolean; creator: string; account: Account; wallet: string | undefined; graduation: GraduationRead | null; done: () => void }) {
  const detail = useRead<CrossDetail>(`/v1/crosses/${cross}`);
  const d = detail.phase === 'ok' ? detail.data : null;
  const base = useMint(d?.baseMint ?? null);
  const quote = useMint(d?.quoteMint ?? null);
  const decimals = { base: base.info?.decimals ?? d?.decimals.base ?? null, quote: quote.info?.decimals ?? d?.decimals.quote ?? null };
  const price = clearingPrice !== null ? BigInt(clearingPrice) : null;
  const priceScale = d ? BigInt(d.grid.priceScale) : null;
  const isCreator = wallet !== undefined && wallet === creator;
  const common = !d ? 'Reading the cross…' : price === null ? 'The cross did not print a price, so there is nothing to open a market at.' : !baseBound ? 'The cross has no base token yet.' : !isCreator ? `Only the wallet that created the cross can open its market (${shortAddress(creator)}).` : undefined;
  return (
    <div className="grid gap-5 lg:grid-cols-2" data-testid="tranche-steps">
      <Presale cross={cross} account={account} wallet={wallet} off={common} decimals={decimals} price={price} priceScale={priceScale} done={done} />
      <Futarchy cross={cross} account={account} wallet={wallet} off={common} decimals={decimals} price={price} priceScale={priceScale} base={base.info} quote={quote.info} graduation={graduation} done={done} />
    </div>
  );
}

function Presale({ cross, account, wallet, off, decimals, price, priceScale, done }: { cross: string; account: Account; wallet: string | undefined; off: string | undefined; decimals: { base: number | null; quote: number | null }; price: bigint | null; priceScale: bigint | null; done: () => void }) {
  const [f, setF] = useState<PresaleForm>(EMPTY_PRESALE);
  const [key, renew] = useFresh();
  const [made, setMade] = useState<string | null>(null);
  const built = useMemo(() => buildPresale(f, cross, wallet ?? null, key?.address ?? null, decimals), [f, cross, wallet, key, decimals]);
  const e = built.errors;
  const shown = (k: keyof PresaleForm) => (f[k] === '' ? undefined : e[k]);
  const set = <K extends keyof PresaleForm>(k: K) => (v: PresaleForm[K]) => setF((x) => ({ ...x, [k]: v }));
  const supply = decimals.base === null ? null : parseAtoms(f.supply, decimals.base);
  const proceeds = supply !== null && supply > 0n && price !== null && priceScale !== null && decimals.quote !== null ? fullSaleProceeds(supply, price, priceScale) : null;
  return (
    <Frame id="presale" title="Fixed-price tranche at the clearing price (Meteora Presale Vault)">
      <FeatureNotice feature="fixedPricePresale" what="A fixed-price tranche at the clearing price" />
      <p className="text-xs text-muted">
        After the call printed, sell more of the token to everyone who did not bid, at exactly the price the call found. The API pins the price: the program refuses any other. Deposits, claims and the unsold refund are Meteora&apos;s program. This tranche is not a graduation venue, so a vote does not gate it.
      </p>
      <div className="grid gap-3 sm:grid-cols-2" data-testid="presale-form">
        <Text label="Tokens in the tranche" value={f.supply} onChange={set('supply')} inputMode="decimal" error={shown('supply')} hint="Moved from your wallet into the sale's vault." />
        <Text label="Most it may raise, quote tokens" value={f.maxCap} onChange={set('maxCap')} inputMode="decimal" error={shown('maxCap')} hint={proceeds !== null && decimals.quote !== null ? `Selling every token at the clearing price brings in ${formatAtoms(proceeds, decimals.quote)}.` : undefined} />
        <Text label="Least it needs, quote tokens" value={f.minCap} onChange={set('minCap')} inputMode="decimal" error={shown('minCap')} hint="Empty: no minimum." />
        <Text label="Smallest deposit, quote tokens" value={f.buyerMin} onChange={set('buyerMin')} inputMode="decimal" error={shown('buyerMin')} hint="Empty: no minimum." />
        <Text label="Largest deposit per buyer, quote tokens" value={f.buyerMax} onChange={set('buyerMax')} inputMode="decimal" error={shown('buyerMax')} />
        <Text label="Opens at" type="datetime-local" mono={false} value={f.startAt} onChange={set('startAt')} error={shown('startAt')} hint="In your time zone." />
        <Text label="Closes at" type="datetime-local" mono={false} value={f.endAt} onChange={set('endAt')} error={shown('endAt')} />
        <Text label="Deposit fee, % (optional)" value={f.depositFeePct} onChange={set('depositFeePct')} inputMode="decimal" error={e.depositFeePct} />
        <Text label="Released to buyers at once, %" value={f.releaseNowPct} onChange={set('releaseNowPct')} inputMode="decimal" error={e.releaseNowPct} />
        <Text label="Lock, days" value={f.lockDays} onChange={set('lockDays')} inputMode="numeric" error={e.lockDays} />
        <Text label="Vesting, days" value={f.vestDays} onChange={set('vestDays')} inputMode="numeric" error={e.vestDays} />
        <div className="text-sm">
          <label className="block">
            <span className="text-muted">Tokens nobody buys</span>
            <select value={f.unsold} onChange={(ev) => set('unsold')(ev.target.value as 'refund' | 'burn')} className="mt-1 min-h-11 w-full rounded-lg border border-border-strong bg-bg px-3 py-2.5">
              <option value="refund">Return them to me</option>
              <option value="burn">Burn them</option>
            </select>
          </label>
        </div>
      </div>
      <FeatureAction
        feature="fixedPricePresale"
        what="A fixed-price tranche at the clearing price"
        account={account}
        label="Open the tranche"
        variant="secondary"
        path="/v1/tx/open-fixed-price-presale"
        testId="open-fixed-price-presale"
        disabled={Boolean(off) || !built.body}
        disabledReason={off ?? 'Fill in the fields marked above.'}
        body={() => built.body}
        cosign={key ? (tx) => cosign(tx, key) : undefined}
        onBuilt={(x) => setMade(typeof x.presale === 'string' ? x.presale : null)}
        onDone={() => {
          renew();
          done();
        }}
      />
      <p className="text-xs text-muted">A new account is made for this sale and signs next to your wallet. It holds nothing and is not stored.</p>
      {made ? (
        <p className="break-all text-xs text-muted" role="status" data-testid="presale-address">
          Presale: <span className="font-mono">{made}</span>
        </p>
      ) : null}
    </Frame>
  );
}

function Futarchy({ cross, account, wallet, off, decimals, price, priceScale, base, quote, graduation, done }: { cross: string; account: Account; wallet: string | undefined; off: string | undefined; decimals: { base: number | null; quote: number | null }; price: bigint | null; priceScale: bigint | null; base: { program: string } | null; quote: { program: string; decimals: number } | null; graduation: GraduationRead | null; done: () => void }) {
  const [f, setF] = useState<FutarchyForm>(EMPTY_FUTARCHY);
  const built = useMemo(() => buildFutarchy(f, cross, wallet ?? null, decimals), [f, cross, wallet, decimals]);
  const e = built.errors;
  const set = <K extends keyof FutarchyForm>(k: K) => (v: FutarchyForm[K]) => setF((x) => ({ ...x, [k]: v }));
  const blocker = futarchyBlocker(base, quote);
  const gated = graduation?.governed && graduation.applies !== false;
  const voteOff = gated ? (graduation?.outcome ? (graduation.outcome.venue === 'metadao_futarchy' ? undefined : `Holders voted for ${venueLabel(graduation.outcome.venue)}, not a MetaDAO DAO. The settlement program opens only the venue they chose.`) : 'This cross set the governed-graduation rule, and no vote has passed. The settlement program opens a pool only on the venue its holders choose.') : undefined;
  const reason = off ?? blocker ?? voteOff;
  const line = depositLine(f.baseAmount, decimals, price, priceScale);
  return (
    <Frame id="futarchy" title="MetaDAO futarchy DAO at the clearing price">
      <FeatureNotice feature="futarchyDao" what="A MetaDAO futarchy DAO at the clearing price" />
      <p className="text-xs text-muted">
        Open a MetaDAO DAO whose spot pool starts at the price the call found, with your opening liquidity. After it exists the DAO&apos;s treasury and rules are MetaDAO&apos;s: a Squads multisig governed by decision markets. The cross decides the price; MetaDAO decides what happens next.
      </p>
      {blocker ? <Plain testId="futarchy-blocker">{blocker}</Plain> : null}
      {voteOff && !off ? <Plain testId="futarchy-vote-gate">{voteOff}</Plain> : null}
      <div className="grid gap-3 sm:grid-cols-2" data-testid="futarchy-form">
        <Text label="Base tokens to deposit" value={f.baseAmount} onChange={set('baseAmount')} inputMode="decimal" error={f.baseAmount === '' ? undefined : e.baseAmount} hint={line ?? 'The quote deposit follows from the price: you do not type it.'} />
        <Text label="DAO number (optional)" value={f.nonce} onChange={set('nonce')} inputMode="numeric" error={e.nonce} hint="Empty: the first number you have not used." />
      </div>
      <details className="rounded-lg border border-border p-3 text-sm">
        <summary className="min-h-11 cursor-pointer py-2">MetaDAO settings (optional)</summary>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Text label="Pass threshold, %" value={f.passPct} onChange={set('passPct')} inputMode="decimal" error={e.passPct} hint="Empty: the adapter's default." />
          <Text label="Proposal length, days" value={f.proposalDays} onChange={set('proposalDays')} inputMode="numeric" error={e.proposalDays} />
          <Text label="TWAP start delay, minutes" value={f.twapDelayMins} onChange={set('twapDelayMins')} inputMode="numeric" error={e.twapDelayMins} />
          <Text label="Team-sponsored pass threshold, %" value={f.teamPassPct} onChange={set('teamPassPct')} inputMode="decimal" error={e.teamPassPct} />
          <Text label="Minimum quote liquidity" value={f.minQuote} onChange={set('minQuote')} inputMode="decimal" error={e.minQuote} />
          <Text label="Minimum base liquidity" value={f.minBase} onChange={set('minBase')} inputMode="decimal" error={e.minBase} />
          <Text label="Base tokens to stake" value={f.baseToStake} onChange={set('baseToStake')} inputMode="decimal" error={e.baseToStake} />
          <Text label="Largest TWAP change per update" value={f.maxChange} onChange={set('maxChange')} inputMode="numeric" error={e.maxChange} />
        </div>
      </details>
      <FeatureAction
        feature="futarchyDao"
        what="A MetaDAO futarchy DAO at the clearing price"
        account={account}
        label="Open the DAO"
        variant="secondary"
        path="/v1/tx/seed-futarchy-dao"
        testId="seed-futarchy-dao"
        disabled={Boolean(reason) || !built.body}
        disabledReason={reason ?? 'Enter the base amount.'}
        body={() => built.body}
        onDone={done}
      />
    </Frame>
  );
}

/** The state of a governed cross at the top of the settle page: which venue the vote allows, and why the others are off. */
export function GovernedNote({ cross, g }: { cross: string; g: GraduationRead | null }) {
  if (!g || !g.governed || g.applies === false) return null;
  return (
    <div className="rounded-lg border border-border p-4 text-sm" data-testid="governed-note" data-outcome={g.outcome?.venue ?? 'none'}>
      <p className="font-medium">{g.outcome ? `Holders chose ${venueLabel(g.outcome.venue)}` : 'This cross is governed: its holders choose the venue'}</p>
      <p className="mt-1 text-muted">
        {g.outcome
          ? `Only ${venueLabel(g.outcome.venue)} can be opened for this cross; the settlement program refuses a pool on any other venue. The DBC continuation and the fixed-price tranche are not graduation venues and are not gated.`
          : 'The settlement program opens a pool only on the venue a passed vote chose, so the DAMM v2, DLMM, Raydium and MetaDAO steps are off until one passes. The DBC continuation and the fixed-price tranche are not graduation venues and are not gated.'}{' '}
        <a href={`/crosses/${cross}`} className="underline underline-offset-4" data-testid="governed-link">
          The vote
        </a>
      </p>
    </div>
  );
}
