'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { SmallButton } from '@/components/issue-wizard/fields';
import { RightsCards } from '@/components/treasury/rights-cards';
import { DisclosureBadge, TreasuryStateBadge } from '@/components/treasury/badges';
import { apiRead, treasuries as readTreasuries, type TreasuryRow } from '@/lib/issuer-data';
import { type TreasuryDetail, duration, quote, utc } from '@/lib/treasury';
import { shortAddress } from '@/lib/units';
import { useWallet } from '@/lib/wallet';
import { ConnectPrompt } from './connect-prompt';

export function TreasuryManage() {
  const { account } = useWallet();
  if (!account) return <ConnectPrompt what="the treasuries this wallet controls" />;
  return <List wallet={account.address} />;
}

function List({ wallet }: { wallet: string }) {
  const [rows, setRows] = useState<TreasuryRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void readTreasuries().then((r) => {
      if (!live) return;
      if (r.ok) setRows(r.data.treasuries.filter((t) => t.authority === wallet));
      else setError(r.error);
    });
    return () => {
      live = false;
    };
  }, [wallet]);
  return (
    <div className="mt-8 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-semibold tracking-tight">Your treasuries</h2>
        <Link href="/issuer/treasury/new" className="inline-flex min-h-11 items-center rounded-full bg-accent-fill px-5 py-2.5 text-sm font-medium text-on-accent" data-testid="new-treasury">
          Create a treasury
        </Link>
      </div>
      {error ? <p role="alert" className="text-sm text-accent-text">{error}</p> : null}
      {!rows && !error ? <p role="status" className="text-sm text-muted">Reading your treasuries…</p> : null}
      {rows && rows.length === 0 ? (
        <p className="text-sm text-muted" data-testid="no-treasuries">
          This wallet is not the authority of any treasury. A treasury is optional. It holds proceeds under a spend allowance that needs a live attestation, and it can only be created for a coin whose supply is fixed.
        </p>
      ) : null}
      <ul className="space-y-6">{rows?.map((t) => <Treasury key={t.address} row={t} />)}</ul>
    </div>
  );
}

function Treasury({ row }: { row: TreasuryRow }) {
  const [detail, setDetail] = useState<TreasuryDetail | null>(null);
  const [cards, setCards] = useState(false);
  useEffect(() => {
    let live = true;
    void apiRead<TreasuryDetail>(`/v1/treasuries/${row.address}`).then((r) => live && r.ok && setDetail(r.data));
    return () => {
      live = false;
    };
  }, [row.address]);
  const d = row.quoteDecimals ?? 6;
  return (
    <li className="rounded-[var(--radius-card)] border border-border p-5" data-testid={`treasury-${row.address}`}>
      <div className="flex flex-wrap items-center gap-2">
        {row.state ? <TreasuryStateBadge state={row.state} /> : null}
        <DisclosureBadge state={row.disclosure.state} />
        <span className="font-mono text-xs text-muted">{shortAddress(row.address)}</span>
      </div>
      <dl className="mt-4 grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-muted">In the vault</dt>
          <dd className="font-mono">{quote(row.vaultBalance, d)}</dd>
        </div>
        <div>
          <dt className="text-muted">Allowance</dt>
          <dd className="font-mono">{row.allowance && row.periodSecs ? `${quote(row.allowance, d)} per ${duration(row.periodSecs)}` : 'unavailable'}</dd>
        </div>
        <div>
          <dt className="text-muted">Left this period</dt>
          <dd className="font-mono">{quote(row.spend?.allowanceRemaining, d)}</dd>
        </div>
        <div>
          <dt className="text-muted">Attestation</dt>
          <dd data-testid="attestation">
            {!detail ? 'reading…' : !detail.attestation ? 'unknown' : !detail.attestation.exists ? 'none yet: the team cannot spend' : detail.attestation.live ? `live${detail.attestation.expiry && detail.attestation.expiry !== '0' ? ` until ${utc(detail.attestation.expiry)}` : ''}` : 'lapsed: spending is stopped'}
          </dd>
        </div>
      </dl>
      <p className="mt-3 text-sm text-muted">{row.disclosure.note}</p>
      <div className="mt-4 flex flex-wrap gap-3">
        <SmallButton onClick={() => setCards(!cards)} pressed={cards} testId="toggle-rights">
          {cards ? 'Hide what holders are told' : 'Show what holders are told'}
        </SmallButton>
        <Link href="/issuer/disclosures" className="inline-flex min-h-11 items-center rounded-full border border-border-strong px-4 py-2 text-sm hover:bg-surface">
          Post an update
        </Link>
        <Link href={`/issuer/treasury/${row.address}`} className="inline-flex min-h-11 items-center rounded-full bg-accent-fill px-4 py-2 text-sm font-medium text-on-accent" data-testid={`console-${row.address}`}>
          Open the console
        </Link>
        <Link href={`/treasury/${row.address}`} className="inline-flex min-h-11 items-center rounded-full border border-border-strong px-4 py-2 text-sm hover:bg-surface">
          Open the holder page
        </Link>
      </div>
      {cards ? (detail ? <RightsCards cards={detail.rights} /> : <p className="mt-4 text-sm text-muted">Reading…</p>) : null}
    </li>
  );
}
