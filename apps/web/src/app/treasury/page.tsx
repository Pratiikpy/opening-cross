import type { Metadata } from 'next';
import Link from 'next/link';
import { DisclosureBadge, NetworkTag, TreasuryStateBadge } from '@/components/treasury/badges';
import { get } from '@/lib/api';
import { type TreasuryList, duration, quote, utc } from '@/lib/treasury';
import { shortAddress } from '@/lib/units';

export const metadata: Metadata = {
  title: 'Treasuries',
  description: 'Ownership-coin treasuries held by the Opening Cross treasury program: spend allowance, attestation, liquidation state and disclosure updates, read from chain.',
};
export const revalidate = 10;

export default async function Treasuries() {
  const res = await get<TreasuryList>('/v1/treasuries?limit=100', 10);
  return (
    <div className="mx-auto max-w-[1200px] px-4 py-14 sm:px-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-[34px] font-semibold tracking-tight sm:text-[44px]">Treasuries</h1>
        {res.ok ? <NetworkTag network={res.data.network} /> : null}
      </div>
      <p className="mt-2 max-w-2xl text-muted">
        An ownership coin&apos;s treasury is held by a program, not by the team. The team can spend a capped allowance, only while an auditor&apos;s attestation is live. If it lapses for the grace period, anyone can start liquidation and holders redeem pro rata. Balances and state below are read from chain.
      </p>
      <p className="mt-2 max-w-2xl text-sm text-muted">
        Every treasury listed here is a test treasury on devnet. The treasury program is not audited and nothing is deployed to mainnet.
      </p>
      {!res.ok ? (
        <p role="status" className="mt-10 text-sm text-muted">
          Treasuries are unavailable right now: {res.error}
        </p>
      ) : res.data.treasuries.length === 0 ? (
        <p className="mt-10 text-sm text-muted">No treasury has been created yet.</p>
      ) : (
        <ul className="mt-10 grid gap-4 md:grid-cols-2">
          {res.data.treasuries.map((t) => {
            const d = t.quoteDecimals ?? 6;
            return (
              <li key={t.address}>
                <Link href={`/treasury/${t.address}`} prefetch={false} className="block rounded-[var(--radius-card)] border border-border bg-surface p-5 transition-colors hover:border-border-strong focus-visible:outline-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <TreasuryStateBadge state={t.state} />
                    <DisclosureBadge state={t.disclosure.state} />
                  </div>
                  <p className="mt-3 font-mono text-sm">{shortAddress(t.address)}</p>
                  <p className="text-xs text-muted">Coin {shortAddress(t.coinMint)}</p>
                  {t.chain === 'read' ? (
                    <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
                      <div>
                        <dt className="text-muted">In the vault</dt>
                        <dd className="font-medium">{quote(t.vaultBalance, d)}</dd>
                      </div>
                      <div>
                        <dt className="text-muted">Allowance</dt>
                        <dd className="font-medium">
                          {quote(t.allowance, d)} / {duration(t.periodSecs ?? '0')}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-muted">Left this period</dt>
                        <dd>{t.state === 'Liquidating' ? 'Closed' : quote(t.spend?.allowanceRemaining, d)}</dd>
                      </div>
                      <div>
                        <dt className="text-muted">Created</dt>
                        <dd>{t.createdAt === null ? 'not indexed yet' : utc(t.createdAt)}</dd>
                      </div>
                    </dl>
                  ) : (
                    <p className="mt-4 text-sm text-muted">{t.chain === 'unavailable' ? 'The chain could not be read just now.' : 'This account is no longer a treasury.'}</p>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
