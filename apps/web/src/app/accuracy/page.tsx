import type { Metadata } from 'next';
import { API_URL, get } from '@/lib/api';
import { explainCalibration } from '@/lib/reasons';
import type { AccuracyView, BucketReport } from '@/lib/trust-types';
import { shortAddress } from '@/lib/units';

export const metadata: Metadata = {
  title: 'Track record',
  description: 'Every price band Opening Cross signs, graded against the price the cross actually printed. Misses and unresolved bands are counted too.',
};
export const dynamic = 'force-dynamic';

const WINDOW = ['Early in the call', 'Middle of the call', 'Late in the call'];
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const pct = (x: number | null) => (x === null ? '—' : `${(x * 100).toFixed(1)}%`);

function Bucket({ b, bounds }: { b: BucketReport; bounds: number[] }) {
  const label = WINDOW[b.bucket] ?? `Part ${b.bucket + 1}`;
  const c = b.calibration;
  const claimed = b.hit + b.miss;
  if (b.issued === 0) {
    return (
      <li className="py-5" data-testid={`bucket-${b.bucket}`}>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-lg font-medium">{label}</h3>
          <span className="text-sm text-muted">No bands signed yet</span>
        </div>
      </li>
    );
  }
  return (
    <li className="py-6" data-testid={`bucket-${b.bucket}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-lg font-medium">{label}</h3>
        <span className={`rounded-full border px-2.5 py-0.5 text-xs ${c.status === 'CALIBRATED' ? 'border-positive text-positive' : 'border-border text-muted'}`}>
          {c.status === 'CALIBRATED' ? 'Claims coverage' : 'Provisional: claims none'}
        </span>
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
        <Stat label="Signed" value={String(b.issued)} />
        <Stat label="Inside the band" value={claimed ? `${b.hit} of ${claimed}` : '—'} />
        <Stat label="Hit rate" value={pct(b.coverage)} note={b.coverageWilsonLo !== null ? `95% range ${pct(b.coverageWilsonLo)} to ${pct(b.coverageWilsonHi)}` : `target ${pct(b.nominalCoverage)}`} />
        <Stat label="Typical miss" value={b.medianAbsErrorTicks === null ? '—' : `${b.medianAbsErrorTicks} ticks`} note={b.meanAbsErrorTicks === null ? undefined : `mean ${b.meanAbsErrorTicks.toFixed(1)}`} />
      </dl>
      <p className="mt-3 text-sm text-muted">
        {plural(b.scored, 'scored estimate')} · {b.void} void (the cross did not print) · {b.unresolved} still unresolved. Calibration: {plural(c.n, 'graded cross', 'graded crosses')} over {plural(c.distinctDays, 'day')}.
        {c.status === 'PROVISIONAL' && c.reason ? ` ${explainCalibration(c.reason)}` : ''}
      </p>
      <span className="sr-only">Window bounds in basis points: {bounds.join(', ')}</span>
    </li>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note?: string | undefined }) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-1 font-mono">{value}</dd>
      {note ? <dd className="mt-0.5 text-xs text-muted">{note}</dd> : null}
    </div>
  );
}

export default async function Accuracy() {
  const res = await get<AccuracyView>('/v1/accuracy', 0);
  return (
    <div className="mx-auto max-w-[800px] px-4 py-12 sm:px-6">
      <h1 className="text-[34px] font-semibold tracking-tight">Track record</h1>
      <p className="mt-3 text-muted">
        Before a cross closes, Opening Cross signs a price band: where the final price should land. When the cross prints, the band is graded against the real result. Every band is counted here, including the misses, the crosses that never printed and the ones not yet resolved.
      </p>
      {!res.ok ? (
        <p role="status" className="mt-8 rounded-[var(--radius-card)] border border-border p-5 text-sm text-muted">
          The track record cannot be loaded right now: {res.error}
        </p>
      ) : res.data.totals.issued === 0 ? (
        <p role="status" className="mt-8 rounded-[var(--radius-card)] border border-border p-5 text-sm text-muted" data-testid="no-promises">
          No band has been signed on {res.data.cluster} yet. The first one appears when an open-book cross is inside its call window. Nothing on this page is example data.
        </p>
      ) : (
        <>
          <dl className="mt-8 grid grid-cols-2 gap-4 border-y border-border py-5 text-sm sm:grid-cols-4" data-testid="accuracy-totals">
            <Stat label="Bands signed" value={String(res.data.totals.issued)} />
            <Stat label="Crosses covered" value={String(res.data.totals.crosses)} />
            <Stat label="Graded" value={String(res.data.totals.graded)} />
            <Stat label="Void or unresolved" value={`${res.data.totals.void} / ${res.data.totals.unresolved}`} />
          </dl>
          <ul className="divide-y divide-border">
            {res.data.buckets.map((b) => (
              <Bucket key={b.bucket} b={b} bounds={res.data.policy.bucketBoundsBps} />
            ))}
          </ul>
        </>
      )}
      <section className="mt-10 rounded-[var(--radius-card)] border border-border p-6 text-sm" aria-labelledby="how">
        <h2 id="how" className="font-medium">
          How to check this yourself
        </h2>
        <p className="mt-2 text-muted">
          A band claims a hit rate only after enough crosses have been graded to test it, and it loses that claim if it under-covers. Until then it is provisional and its error is recorded without a claim. Each band is a signed record anyone can verify with the open-source checker in the repository, which also recomputes the price from the published book:
        </p>
        <pre tabIndex={0} className="mt-3 overflow-x-auto rounded-lg bg-surface p-3 font-mono text-xs">{`pnpm --filter @opening-cross/promises verify ${API_URL}/v1/promises/<promise id> --inputs ${API_URL}/v1/promises/<promise id>/inputs`}</pre>
        <p className="mt-3 text-muted">
          {res.ok && res.data.signer ? `Bands are signed by ${shortAddress(res.data.signer)}; any other signer is not ours. ` : ''}
          Bands are also folded into a Merkle root written to Solana, which bounds when each was issued.
        </p>
      </section>
    </div>
  );
}
