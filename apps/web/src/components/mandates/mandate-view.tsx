'use client';

import { isAddress } from '@solana/kit';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { Text } from '@/components/issue-wizard/fields';
import { Facts, Pill, Section } from '@/components/issuer/treasury-ui';
import { Failed, FeatureAction, FeatureNotice, Loading, Plain, when } from '@/components/w4/ui';
import {
  type ActivityRead,
  type FundForm,
  type LimitsForm,
  type MandateRead,
  type MandatesRead,
  type OrderForm,
  KIND_LABEL,
  blockerText,
  buildFund,
  buildLimits,
  buildOrder,
  lamportsText,
  newSalt,
  who,
} from '@/lib/mandates';
import type { CrossDetail } from '@/lib/types';
import { useMint, useRead } from '@/lib/use-read';
import { type Market, formatAtoms, parseAtoms } from '@/lib/units';
import { useWallet } from '@/lib/wallet';
import { LimitsFields } from './limits-fields';

const WHAT = 'Auto-invest mandates';
const TONE = { active: 'ok', revoked: 'block', expired: 'warn' } as const;

export function MandateView({ address }: { address: string }) {
  // The index is asked first: a mandate that is not in it, or a network without the program, is said in words and not provoked as a 404.
  const index = useRead<MandatesRead>('/v1/mandates?limit=200');
  if (index.phase === 'loading' || index.phase === 'idle') return <Loading what="the mandate" />;
  if (index.phase === 'ok') {
    if (index.data.release.deployed === false) {
      return (
        <div className="space-y-4">
          <FeatureNotice feature="mandates" what={WHAT} />
          <Plain testId="mandate-not-deployed">{index.data.note ?? 'cross_mandate is not deployed on this network, so there is no mandate to read.'}</Plain>
        </div>
      );
    }
    if (index.data.mandates.length < 200 && !index.data.mandates.some((m) => m.mandate === address)) {
      return (
        <div className="space-y-4">
          <FeatureNotice feature="mandates" what={WHAT} />
          <Failed testId="mandate-error">No mandate is known at {address} on this network.</Failed>
        </div>
      );
    }
  }
  return <Mandate address={address} />;
}

function Mandate({ address }: { address: string }) {
  const read = useRead<MandateRead>(`/v1/mandates/${address}`);
  const activity = useRead<ActivityRead>(`/v1/mandates/${address}/activity`);
  const { account } = useWallet();
  const wallet = account?.address ?? null;
  const mint = useMint(read.phase === 'ok' ? read.data.quoteMint : null);
  if (read.phase === 'loading' || read.phase === 'idle') return <Loading what="the mandate" />;
  if (read.phase === 'error') return <Failed testId="mandate-error">The mandate could not be read: {read.error}</Failed>;
  const m = read.data;
  const d = mint.info?.decimals ?? null;
  const symbol = mint.info?.symbol ?? '';
  const fmt = (a: string | bigint) => (d === null ? String(a) : formatAtoms(BigInt(a), d));
  const reload = () => {
    read.reload();
    activity.reload();
  };
  const isOwner = wallet === m.owner;
  const isAgent = wallet === m.agent;
  return (
    <div className="space-y-6" data-testid="mandate-view" data-status={m.status}>
      <FeatureNotice feature="mandates" what={WHAT} />
      <Section id="terms" title="The mandate" intro={<p>Funded by its owner and used by one agent, inside limits the chain enforces.</p>}>
        <Facts
          rows={[
            ['Status', <Pill key="s" tone={TONE[m.status]} testId="mandate-status">{m.status}</Pill>],
            ['Owner', who(m.owner)],
            ['Agent', who(m.agent)],
            ['Most one order may escrow', `${fmt(m.limits.maxPerOrder)} ${symbol}`.trim()],
            ['Lifetime cap', `${fmt(m.limits.totalCap)} ${symbol}`.trim()],
            ['Committed so far', `${fmt(m.committed)}, ${fmt(m.capRemaining)} left under the cap`],
            ['Share of a cross’s supply', `${m.limits.maxShareBps / 100}% per order`],
            ['Expires', when(m.limits.expiresAt)],
            ['Vault balance', `${fmt(m.vaultBalance)} ${symbol}`.trim()],
            ['Signer account SOL', m.signerLamports === null ? 'not read' : `${lamportsText(m.signerLamports)} (needs ${lamportsText(m.minSignerLamports)})`],
          ]}
        />
        <div data-testid="allow-view">
          <p className="text-sm font-medium">The agent may buy</p>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-muted">
            {m.limits.allow.map((a) => (
              <li key={`${a.kind}-${a.key}`}>
                {KIND_LABEL[a.kind]} {who(a.key)}
              </li>
            ))}
          </ul>
        </div>
        {m.canPlaceOrder ? (
          <p className="text-sm text-positive" data-testid="can-place">The agent can place an order now.</p>
        ) : (
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted" data-testid="blockers">
            {m.blockers.map((b) => (
              <li key={b}>{blockerText(b)}</li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted" data-testid="not-enforced">
          What is not enforced: the cap counts every escrow ever committed; the share limit applies to one order, so several together can exceed it (the per-order limit and the cap bound that); gated and identity-limited crosses need passes a mandate&apos;s signer account does not have; the agent chooses the price inside the limits. A mandate makes an agent&apos;s worst case small and known.
        </p>
      </Section>
      {isOwner ? <OwnerActions m={m} d={d} symbol={symbol} reload={reload} /> : wallet ? <Plain testId="not-owner">Only the owner, {who(m.owner)}, can fund, change, revoke or empty this mandate.</Plain> : <Plain testId="connect-hint">Connect the owner’s wallet to manage this mandate, or the agent’s to place an order.</Plain>}
      {isAgent ? <AgentActions m={m} reload={reload} /> : null}
      <Sweep m={m} reload={reload} />
      <Section id="activity" title="Orders it placed" intro={<p>Every order the agent placed from this mandate, as the index saw them.</p>}>
        {activity.phase === 'ok' && activity.data.orders.length === 0 ? <Plain testId="no-orders">No order has been placed yet.</Plain> : null}
        {activity.phase === 'ok' && activity.data.orders.length > 0 ? (
          <ul className="space-y-2 text-sm" data-testid="orders">
            {activity.data.orders.map((o) => (
              <li key={o.order_address} className="rounded-lg border border-border px-3 py-2">
                {fmt(o.escrow)} {symbol} escrowed in cross{' '}
                <Link href={`/crosses/${o.cross_address}`} className="font-mono underline underline-offset-4">
                  {who(o.cross_address)}
                </Link>
              </li>
            ))}
          </ul>
        ) : null}
      </Section>
    </div>
  );
}

function OwnerActions({ m, d, symbol, reload }: { m: MandateRead; d: number | null; symbol: string; reload: () => void }) {
  const { account } = useWallet();
  const wallet = account?.address ?? null;
  const [fund, setFund] = useState<FundForm>({ amount: '', sol: '' });
  const built = buildFund(fund, wallet, m.mandate, d);
  const [limits, setLimits] = useState<LimitsForm>(() => ({
    maxPerOrder: d === null ? '' : formatAtoms(BigInt(m.limits.maxPerOrder), d).replace(/,/g, ''),
    totalCap: d === null ? '' : formatAtoms(BigInt(m.limits.totalCap), d).replace(/,/g, ''),
    sharePct: String(m.limits.maxShareBps / 100),
    days: '30',
    allow: m.limits.allow.map((a) => ({ kind: a.kind, key: a.key })),
  }));
  useEffect(() => {
    if (d === null) return;
    setLimits((l) => (l.maxPerOrder === '' ? { ...l, maxPerOrder: formatAtoms(BigInt(m.limits.maxPerOrder), d).replace(/,/g, ''), totalCap: formatAtoms(BigInt(m.limits.totalCap), d).replace(/,/g, '') } : l));
  }, [d, m.limits.maxPerOrder, m.limits.totalCap]);
  const checked = useMemo(() => buildLimits(limits, d, Math.floor(Date.now() / 1000)), [limits, d]);
  const [amount, setAmount] = useState('');
  const withdrawAtoms = amount.trim() === '' ? undefined : d === null ? null : parseAtoms(amount, d);
  const revoked = m.status === 'revoked';
  return (
    <Section id="owner" title="You own this mandate" intro={<p>Revoking is immediate and permanent. Withdrawing works at any time, also after an expiry or a revocation.</p>}>
      <div className="space-y-3" data-testid="fund-box">
        <p className="text-sm font-medium">Fund it</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Text label={`Quote tokens${symbol ? ` (${symbol})` : ''}`} value={fund.amount} onChange={(v) => setFund({ ...fund, amount: v })} inputMode="decimal" />
          <Text label="SOL for order rent" value={fund.sol} onChange={(v) => setFund({ ...fund, sol: v })} inputMode="decimal" error={built.error} />
        </div>
        <div className="max-w-sm">
          <FeatureAction feature="mandates" what={WHAT} account={account} label="Fund the mandate" testId="fund-mandate" path="/v1/tx/mandate-fund" body={() => built.body} disabled={!built.body} disabledReason="Enter an amount of tokens or SOL." onDone={reload} />
        </div>
      </div>
      <div className="space-y-3" data-testid="withdraw-box">
        <p className="text-sm font-medium">Withdraw</p>
        <Text label={`Quote tokens to take out${symbol ? ` (${symbol})` : ''}`} value={amount} onChange={setAmount} inputMode="decimal" hint="Empty: the whole vault." error={withdrawAtoms === null ? 'A number with the token’s decimals.' : withdrawAtoms !== undefined && withdrawAtoms > BigInt(m.vaultBalance) ? `The vault holds ${d === null ? m.vaultBalance : formatAtoms(BigInt(m.vaultBalance), d)}.` : undefined} />
        <div className="grid gap-3 sm:grid-cols-2">
          <FeatureAction
            feature="mandates"
            what={WHAT}
            account={account}
            label="Withdraw tokens"
            testId="withdraw-mandate"
            variant="secondary"
            path="/v1/tx/mandate-withdraw"
            body={() => ({ owner: wallet, mandate: m.mandate, ...(withdrawAtoms ? { amount: withdrawAtoms.toString() } : {}) })}
            disabled={BigInt(m.vaultBalance) === 0n || withdrawAtoms === null || (withdrawAtoms !== undefined && withdrawAtoms > BigInt(m.vaultBalance))}
            disabledReason={BigInt(m.vaultBalance) === 0n ? 'The vault is empty.' : 'Enter an amount the vault holds, or leave it empty.'}
            onDone={reload}
          />
          <FeatureAction feature="mandates" what={WHAT} account={account} label="Withdraw the SOL" testId="withdraw-lamports" variant="secondary" path="/v1/tx/mandate-withdraw-lamports" body={() => ({ owner: wallet, mandate: m.mandate, all: true })} disabled={m.signerLamports === null || BigInt(m.signerLamports) === 0n} disabledReason="The signer account holds no SOL." onDone={reload} />
        </div>
      </div>
      {!revoked ? (
        <details className="rounded-lg border border-border p-3 text-sm" data-testid="limits-details">
          <summary className="min-h-11 cursor-pointer py-2">Change the limits</summary>
          <div className="mt-3 space-y-3">
            <LimitsFields value={limits} onChange={setLimits} errors={checked.errors} symbol={symbol} />
            <div className="max-w-sm">
              <FeatureAction feature="mandates" what={WHAT} account={account} label="Save the limits" testId="set-limits" variant="secondary" path="/v1/tx/mandate-set-limits" body={() => ({ owner: wallet, mandate: m.mandate, limits: checked.limits })} disabled={!checked.limits} disabledReason="Fix the fields marked above." onDone={reload} />
            </div>
          </div>
        </details>
      ) : null}
      <div className="space-y-2 rounded-lg border border-accent p-4" data-testid="revoke-box">
        <p className="font-medium">Revoke</p>
        <p className="text-sm text-muted">{revoked ? 'This mandate was revoked. A revoked mandate stays revoked; you can still withdraw what is left.' : 'The agent can place no further order, at once and for good. Orders already placed stay: you or the agent can cancel them. Your funds stay in the vault until you withdraw them.'}</p>
        <div className="max-w-sm">
          <FeatureAction feature="mandates" what={WHAT} account={account} label="Revoke this mandate for good" testId="revoke-mandate" variant="secondary" path="/v1/tx/mandate-revoke" body={() => ({ owner: wallet, mandate: m.mandate })} disabled={revoked} disabledReason="Already revoked." onDone={reload} />
        </div>
      </div>
    </Section>
  );
}

function AgentActions({ m, reload }: { m: MandateRead; reload: () => void }) {
  const { account } = useWallet();
  const wallet = account?.address ?? null;
  const [f, setF] = useState<OrderForm>({ cross: '', price: '', quantity: '' });
  const [salt, setSalt] = useState<string | null>(null);
  const cross = useRead<CrossDetail>(isAddress(f.cross.trim()) ? `/v1/crosses/${f.cross.trim()}` : null);
  const detail = cross.phase === 'ok' ? cross.data : null;
  const market: Market | null = detail ? { priceScale: BigInt(detail.grid.priceScale), baseDecimals: detail.decimals.base, quoteDecimals: detail.decimals.quote } : null;
  const sealed = detail?.disclosure === 'sealed';
  useEffect(() => {
    setSalt(sealed ? newSalt() : null);
  }, [sealed, f.cross]);
  const grid = detail ? { minPrice: BigInt(detail.grid.minPrice), tick: BigInt(detail.grid.tick), ticks: detail.grid.ticks } : null;
  const built = buildOrder(f, wallet, m.mandate, market, sealed ? salt : null, grid);
  const off = m.canPlaceOrder ? undefined : m.blockers.map(blockerText).join(' ');
  const [placed, setPlaced] = useState<{ nonce: string; warnings: string[]; salt: string | null } | null>(null);
  const [cancel, setCancel] = useState({ cross: '', nonce: '' });
  return (
    <Section id="agent" title="You are this mandate’s agent" intro={<p>You can place buy orders from the vault, and cancel or reveal your orders. You can do nothing else with this mandate.</p>}>
      <div className="space-y-3" data-testid="order-box">
        <Text label="Cross" value={f.cross} onChange={(v) => setF({ ...f, cross: v })} error={f.cross === '' ? undefined : built.errors.cross} hint={detail ? `${detail.state}, ${detail.disclosure} book.` : cross.phase === 'error' ? 'That cross could not be read.' : undefined} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Text label="Price per token" value={f.price} onChange={(v) => setF({ ...f, price: v })} inputMode="decimal" error={f.price === '' ? undefined : built.errors.price} />
          <Text label="Tokens to buy" value={f.quantity} onChange={(v) => setF({ ...f, quantity: v })} inputMode="decimal" error={f.quantity === '' ? undefined : built.errors.quantity} />
        </div>
        {sealed && salt ? (
          <p className="break-all text-xs text-muted" data-testid="salt">
            This cross is sealed. Keep this salt: revealing the order needs it. <span className="font-mono">{salt}</span>
          </p>
        ) : null}
        <div className="max-w-sm">
          <FeatureAction
            feature="mandates"
            what={WHAT}
            account={account}
            label="Place the order"
            testId="place-order"
            path="/v1/tx/mandate-place-order"
            body={() => built.body}
            disabled={!built.body || Boolean(off)}
            disabledReason={off ?? 'Choose a cross, a price and a quantity.'}
            onBuilt={(x) => setPlaced({ nonce: String(x.nonce), warnings: Array.isArray(x.warnings) ? (x.warnings as string[]) : [], salt: sealed ? salt : null })}
            onDone={reload}
          />
        </div>
        {placed ? (
          <div className="text-sm" role="status" data-testid="placed">
            <p>Order placed with nonce {placed.nonce}.{placed.salt ? ' Keep the salt above to reveal it.' : ''}</p>
            {placed.warnings.map((w) => (
              <p key={w} className="text-muted">
                {w}
              </p>
            ))}
          </div>
        ) : null}
      </div>
      <div className="space-y-3" data-testid="cancel-box">
        <p className="text-sm font-medium">Cancel an order</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Text label="Cross of the order" value={cancel.cross} onChange={(v) => setCancel({ ...cancel, cross: v })} error={cancel.cross !== '' && !isAddress(cancel.cross.trim()) ? 'This is not a Solana address.' : undefined} />
          <Text label="Order nonce" value={cancel.nonce} onChange={(v) => setCancel({ ...cancel, nonce: v })} inputMode="numeric" />
        </div>
        <div className="max-w-sm">
          <FeatureAction feature="mandates" what={WHAT} account={account} label="Cancel the order" testId="cancel-order" variant="secondary" path="/v1/tx/mandate-cancel-order" body={() => ({ caller: wallet, mandate: m.mandate, cross: cancel.cross.trim(), nonce: cancel.nonce.trim() })} disabled={!isAddress(cancel.cross.trim()) || !/^\d{1,18}$/.test(cancel.nonce.trim())} disabledReason="Name the cross and the order’s nonce (shown when it was placed)." onDone={reload} />
        </div>
      </div>
    </Section>
  );
}

function Sweep({ m, reload }: { m: MandateRead; reload: () => void }) {
  const { account } = useWallet();
  const [mint, setMint] = useState('');
  const hint = m.limits.allow.find((a) => a.kind === 'base_mint')?.key;
  return (
    <Section id="sweep" title="Send the bought tokens to the owner" intro={<p>Anyone can do this. The base tokens an order bought land in the mandate&apos;s signer account; this moves all of them to the owner&apos;s own account, and the quote token cannot be swept.</p>}>
      <Text label="Base token to sweep" value={mint} onChange={setMint} error={mint !== '' && !isAddress(mint.trim()) ? 'This is not a Solana address.' : undefined} hint={hint ? `For example ${who(hint)}, on this mandate’s allow list.` : undefined} />
      <div className="max-w-sm">
        <FeatureAction feature="mandates" what={WHAT} account={account} label="Sweep to the owner" testId="sweep-mandate" variant="secondary" path="/v1/tx/mandate-sweep" body={() => ({ payer: account?.address, mandate: m.mandate, mint: mint.trim() })} disabled={!isAddress(mint.trim())} disabledReason="Name the base token." onDone={reload} connectHint="Connect any wallet: anyone can sweep." />
      </div>
    </Section>
  );
}
