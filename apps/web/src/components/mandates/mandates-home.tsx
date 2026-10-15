'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { Text } from '@/components/issue-wizard/fields';
import { Pill, Section } from '@/components/issuer/treasury-ui';
import { Failed, FeatureAction, FeatureNotice, Loading, Plain, when } from '@/components/w4/ui';
import { type CreateForm, EMPTY_CREATE, type MandateRow, type MandatesRead, buildCreate, who } from '@/lib/mandates';
import { useMint, useRead } from '@/lib/use-read';
import { formatAtoms } from '@/lib/units';
import { useWallet } from '@/lib/wallet';
import { LimitsFields } from './limits-fields';

const WHAT = 'Auto-invest mandates';
const TONE = { active: 'ok', revoked: 'block', expired: 'warn' } as const;

/** Your mandates (as owner and as agent) and the form that creates one. */
export function MandatesHome() {
  const { account } = useWallet();
  const wallet = account?.address ?? null;
  const owned = useRead<MandatesRead>(wallet ? `/v1/owners/${wallet}/mandates` : null);
  const agent = useRead<MandatesRead>(wallet ? `/v1/mandates?agent=${wallet}` : null);
  const [f, setF] = useState<CreateForm>(EMPTY_CREATE);
  const mint = useMint(f.quoteMint.trim().length >= 32 ? f.quoteMint.trim() : null);
  const now = Math.floor(Date.now() / 1000);
  const built = useMemo(() => buildCreate(f, wallet, mint.info?.decimals ?? null, now), [f, wallet, mint.info, now]);
  const symbol = mint.info?.symbol ?? '';
  const [made, setMade] = useState<{ mandate: string; id: string } | null>(null);
  const e = built.errors;
  return (
    <div className="space-y-6">
      <FeatureNotice feature="mandates" what={WHAT} />
      <Plain testId="mandate-promise">
        A mandate lets one key invest for you inside limits that the chain enforces. The agent can place buy orders, cancel and reveal them, and nothing else: it cannot move your tokens anywhere but into a cross, and you can revoke it and withdraw at any moment. It does not make an agent&apos;s judgement good; it makes its worst case small and known.
      </Plain>
      <Section id="mine" title="Mandates you own" intro={<p>The vault of each holds the budget; the agent can only escrow from it.</p>}>
        {!wallet ? <Plain testId="connect-hint">Connect a wallet to see the mandates you own and create one.</Plain> : null}
        {owned.phase === 'loading' ? <Loading what="your mandates" /> : null}
        {owned.phase === 'error' ? <Failed>Your mandates could not be read: {owned.error}</Failed> : null}
        {owned.phase === 'ok' && owned.data.mandates.length === 0 ? <Plain testId="no-owned">{owned.data.note ?? 'You own no mandate on this network.'}</Plain> : null}
        {owned.phase === 'ok' && owned.data.mandates.length > 0 ? <MandateList rows={owned.data.mandates} testId="owned-list" /> : null}
      </Section>
      {wallet ? (
        <Section id="agent" title="Mandates where you are the agent" intro={<p>You place orders for the owner of each, inside its limits.</p>}>
          {agent.phase === 'ok' && agent.data.mandates.length === 0 ? <Plain testId="no-agent">You are the agent of no mandate.</Plain> : null}
          {agent.phase === 'ok' && agent.data.mandates.length > 0 ? <MandateList rows={agent.data.mandates} testId="agent-list" /> : null}
        </Section>
      ) : null}
      <Section id="create" title="Create a mandate" intro={<p>You sign this; the agent never signs anything that creates, funds, re-limits or empties it. The limits are checked here, by the API and again by the program.</p>}>
        <div className="grid gap-4 sm:grid-cols-2" data-testid="create-form">
          <Text label="Agent’s key" value={f.agent} onChange={(v) => setF({ ...f, agent: v })} error={f.agent === '' ? undefined : e.agent} hint="The one key that may place orders. It must differ from yours." />
          <Text label="Quote token" value={f.quoteMint} onChange={(v) => setF({ ...f, quoteMint: v })} error={f.quoteMint === '' ? undefined : e.quoteMint} hint={mint.info ? `${mint.info.symbol ?? 'Token'} with ${mint.info.decimals} decimals.` : mint.failed ? 'This token could not be read on this network.' : 'The token the vault holds and orders pay in.'} />
        </div>
        <LimitsFields value={f.limits} onChange={(limits) => setF({ ...f, limits })} errors={e.limits} symbol={symbol} />
        <div className="grid gap-4 sm:grid-cols-2" data-testid="fund-form">
          <Text label={`Fund the vault now${symbol ? `, in ${symbol}` : ''}`} value={f.fundAmount} onChange={(v) => setF({ ...f, fundAmount: v })} inputMode="decimal" error={e.fundAmount} hint="Optional. You can fund later." />
          <Text label="SOL for the agent’s order rent" value={f.fundSol} onChange={(v) => setF({ ...f, fundSol: v })} inputMode="decimal" error={e.fundSol} hint="The agent places an order only while its signer account holds enough SOL for an order’s rent; it gets the rent back when the order is claimed." />
        </div>
        <div className="max-w-sm">
          <FeatureAction feature="mandates" what={WHAT} account={account} label="Create the mandate" testId="create-mandate" path="/v1/tx/mandate-create" body={() => built.body} disabled={!built.body} disabledReason={wallet ? 'Fill in the fields marked above.' : 'Connect the wallet that will own the mandate.'} onBuilt={(x) => typeof x.mandate === 'string' && setMade({ mandate: x.mandate, id: String(x.id) })} onDone={() => owned.reload()} />
        </div>
        {made ? (
          <p className="text-sm" role="status" data-testid="made">
            Created.{' '}
            <Link href={`/mandates/${made.mandate}`} className="font-mono underline underline-offset-4">
              Open mandate {made.id}
            </Link>
            .
          </p>
        ) : null}
      </Section>
    </div>
  );
}

function MandateList({ rows, testId }: { rows: MandateRow[]; testId: string }) {
  return (
    <ul className="space-y-3" data-testid={testId}>
      {rows.map((m) => (
        <Row key={m.mandate} m={m} />
      ))}
    </ul>
  );
}

function Row({ m }: { m: MandateRow }) {
  const mint = useMint(m.quoteMint);
  const d = mint.info?.decimals ?? null;
  const fmt = (a: string) => (d === null ? a : formatAtoms(BigInt(a), d));
  return (
    <li className="rounded-lg border border-border p-4 text-sm" data-testid={`mandate-${m.mandate}`} data-status={m.status}>
      <p className="flex flex-wrap items-center gap-2">
        <Link href={`/mandates/${m.mandate}`} className="font-mono underline underline-offset-4">
          {who(m.mandate)}
        </Link>
        <Pill tone={TONE[m.status]}>{m.status}</Pill>
        <span className="text-muted">agent {who(m.agent)}</span>
      </p>
      <p className="mt-1 text-muted">
        Up to {fmt(m.limits.maxPerOrder)} per order and {fmt(m.limits.totalCap)} in all; {fmt(m.committed)} committed in {m.orders} order{m.orders === 1 ? '' : 's'}. Expires {when(m.limits.expiresAt)}.
      </p>
    </li>
  );
}

