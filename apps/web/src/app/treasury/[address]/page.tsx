import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { NetworkTag, TreasuryStateBadge } from '@/components/treasury/badges';
import { RightsCards } from '@/components/treasury/rights-cards';
import { DisclosureStatus, UpdatesFeed } from '@/components/treasury/updates-feed';
import { get } from '@/lib/api';
import { type TreasuryDetail, type UpdatesResponse, duration, eventSummary, explorerAddress, explorerTx, quote, utc } from '@/lib/treasury';
import { shortAddress } from '@/lib/units';

type Params = { params: Promise<{ address: string }> };
export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { address } = await params;
  return { title: `Treasury ${shortAddress(address)}` };
}

function Addr({ a }: { a: string }) {
  return (
    <a href={explorerAddress(a)} rel="noreferrer" className="break-all font-mono text-xs underline decoration-border-strong underline-offset-4 hover:text-ink">
      {a}
    </a>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="py-3 sm:grid sm:grid-cols-[220px_1fr] sm:gap-6">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="mt-1 min-w-0 text-sm [overflow-wrap:anywhere] sm:mt-0">{children}</dd>
    </div>
  );
}

export default async function TreasuryPage({ params }: Params) {
  const { address } = await params;
  const [res, upd] = await Promise.all([get<TreasuryDetail>(`/v1/treasuries/${address}`, 0), get<UpdatesResponse>(`/v1/treasuries/${address}/updates`, 0)]);
  if (!res.ok) {
    if (/no treasury|base58/.test(res.error)) notFound();
    return (
      <div className="mx-auto max-w-[1200px] px-4 py-14 sm:px-6">
        <h1 className="text-2xl font-semibold">Treasury {shortAddress(address)}</h1>
        <p role="status" className="mt-4 text-muted">
          This treasury cannot be loaded right now: {res.error}
        </p>
      </div>
    );
  }
  const t = res.data;
  const d = t.terms.quoteDecimals;
  const liquidating = t.state === 'Liquidating';
  const att = t.attestation;
  return (
    <div className="mx-auto max-w-[1000px] px-4 py-14 sm:px-6">
      <p className="text-sm text-muted">
        <Link href="/treasury" className="underline underline-offset-4 hover:text-ink">
          Treasuries
        </Link>
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <h1 className="text-[30px] font-semibold tracking-tight sm:text-[40px]">Treasury {shortAddress(t.address)}</h1>
        <TreasuryStateBadge state={t.state} />
        <NetworkTag network={t.network} />
      </div>
      <p className="mt-2 text-sm text-muted">
        Read from chain at {utc(t.asOf)}. {t.indexed ? 'History is from the indexer.' : 'The indexer has not seen this treasury yet, so history and the reporting clock are not available.'}
      </p>

      <section aria-labelledby="now" className="mt-10">
        <h2 id="now" className="text-2xl font-semibold tracking-tight">Right now</h2>
        <dl className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[
            { k: 'In the vault', v: quote(t.balances.vault, d) },
            { k: liquidating ? 'Spending' : 'Left this period', v: liquidating ? 'Closed for good' : quote(t.spend.allowanceRemaining, d) },
            {
              k: 'Attestation',
              v: liquidating ? 'No longer relevant' : att === null ? 'Could not be read' : att.live ? `Live${att.expiry && att.expiry !== '0' ? `, until ${utc(att.expiry)}` : ', no expiry'}` : att.exists ? 'Expired or not matching' : 'None on chain',
            },
            {
              k: 'Lapse',
              v: liquidating ? 'Liquidation started' : t.lapse.lapsedSince === null ? 'None recorded' : `Recorded ${utc(t.lapse.lapsedSince)}; grace ends ${utc(t.lapse.graceEndsAt!)}`,
            },
          ].map((x) => (
            <div key={x.k} className="rounded-[var(--radius-card)] border border-border bg-surface p-4">
              <dt className="text-sm text-muted">{x.k}</dt>
              <dd className="mt-1 text-[17px] font-semibold leading-snug">{x.v}</dd>
            </div>
          ))}
        </dl>
        {t.snapshot ? (
          <p className="mt-4 text-sm">
            Liquidation snapshot: {quote(t.snapshot.vault, d)} over {t.snapshot.supply} coin atoms. {t.history?.redemptionCount ? `${t.history.redemptionCount} redemption${t.history.redemptionCount === 1 ? '' : 's'} so far, paying ${quote(t.history.redeemedPaid, d)}.` : 'No redemption yet.'}
          </p>
        ) : null}
      </section>

      <section aria-labelledby="terms" className="mt-12">
        <h2 id="terms" className="text-2xl font-semibold tracking-tight">Terms</h2>
        <p className="mt-2 max-w-2xl text-sm text-muted">Fixed when the treasury was created. The program has no instruction that changes them.</p>
        <dl className="mt-4 divide-y divide-border border-y border-border">
          <Row label="Allowance">
            {quote(t.terms.allowance, d)} per {duration(t.terms.periodSecs)}; unspent allowance does not carry over
          </Row>
          <Row label="Grace period">{duration(t.terms.graceSecs)} of recorded lapse before anyone can start liquidation</Row>
          <Row label="Treasury authority (the team)">
            <Addr a={t.terms.authority} />
          </Row>
          <Row label="Coin mint">
            <Addr a={t.terms.coinMint} />
            <span className="mt-1 block text-muted">
              Supply {t.balances.coinSupply ?? 'unavailable'} atoms; mint authority {t.balances.coinMintAuthority === null ? 'revoked' : t.balances.coinMintAuthority === 'unknown' ? 'could not be read' : t.balances.coinMintAuthority}
            </span>
          </Row>
          <Row label="Quote mint">
            <Addr a={t.terms.quoteMint} />
          </Row>
          <Row label="Vault">
            <Addr a={t.balances.vaultAddress} />
          </Row>
          <Row label="Attestation credential and schema">
            <Addr a={t.terms.credential} />
            <span className="mt-1 block">
              <Addr a={t.terms.schema} />
            </span>
          </Row>
          {att ? (
            <Row label="Attestation account">
              <Addr a={att.address} />
            </Row>
          ) : null}
          <Row label="Treasury program">
            <Addr a={t.program} />
            <span className="mt-1 block text-muted">
              {t.programUpgradeAuthority === null ? 'No upgrade authority: it can never change.' : t.programUpgradeAuthority === 'unknown' ? 'Upgrade authority could not be read.' : `Upgrade authority: ${t.programUpgradeAuthority}`}
            </span>
          </Row>
        </dl>
      </section>

      <section aria-labelledby="disclosure" className="mt-12">
        <h2 id="disclosure" className="text-2xl font-semibold tracking-tight">Disclosure updates</h2>
        <p className="mt-2 max-w-2xl text-sm text-muted">
          The treasury owner signs each update with the treasury authority key and anchors its id in a Memo transaction signed by the same key, so the chain says when it was posted and by whom. Each update names the one before it. The content is the owner&apos;s statement; the only figure the chain can check is the spend.
        </p>
        <div className="mt-4">
          <DisclosureStatus d={t.disclosure} periodText={duration(t.terms.periodSecs)} />
        </div>
        {upd.ok ? <UpdatesFeed updates={upd.data.updates} decimals={d} /> : <p role="status" className="mt-4 text-sm text-muted">Updates are unavailable right now: {upd.error}</p>}
      </section>

      <RightsCards cards={t.rights} />

      <section aria-labelledby="events" className="mt-14">
        <h2 id="events" className="text-2xl font-semibold tracking-tight">Recent program events</h2>
        {t.events.length === 0 ? (
          <p className="mt-4 text-sm text-muted">{t.indexed ? 'No events indexed.' : 'Events appear once the indexer has seen this treasury.'}</p>
        ) : (
          <ul className="mt-4 divide-y divide-border border-y border-border">
            {t.events.map((e) => (
              <li key={`${e.signature}:${e.name}:${e.slot}`} className="py-3 sm:grid sm:grid-cols-[160px_1fr_auto] sm:gap-6">
                <p className="text-sm text-muted">{e.time === null ? 'time unknown' : utc(e.time)}</p>
                <p className="mt-1 text-sm sm:mt-0">{eventSummary(e, d)}</p>
                <a href={explorerTx(e.signature)} rel="noreferrer" className="mt-1 font-mono text-xs underline underline-offset-4 hover:text-ink sm:mt-0">
                  {e.signature.slice(0, 8)}…
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="mt-14 text-xs text-muted">
        Devnet only. The treasury program has not been audited and no treasury exists on mainnet. The rights cards describe the deployed program&apos;s code; they are not legal advice and not an offer of securities.
      </p>
    </div>
  );
}
