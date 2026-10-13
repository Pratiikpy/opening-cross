'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Chip } from '@/components/issue-wizard/fields';
import type { ApplicationView, StoredRecord } from '@/lib/issuer-board';
import { apiRead } from '@/lib/issuer-data';
import { cohorts, type Pipeline } from '@/lib/issuer-pipeline';
import { shortAddress } from '@/lib/units';

const TONE = { submitted: 'info', accepted: 'ok', 'changes-requested': 'warn', declined: 'block' } as const;
const TEXT = { submitted: 'Submitted', accepted: 'Accepted', 'changes-requested': 'Changes requested', declined: 'Declined' } as const;

/** The public pipeline: applications that name a program or cohort, grouped by what they named and with the latest decision on each. */
export function Accelerators() {
  const [pipeline, setPipeline] = useState<Pipeline | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void (async () => {
      const r = await apiRead<{ records: StoredRecord[] }>('/v1/issuer/records?kind=application&limit=200');
      if (!live) return;
      if (!r.ok) return setError(r.error);
      const withCohort = r.data.records.filter((x) => typeof x.body.cohort === 'string' && x.body.cohort.trim() !== '');
      const views = await Promise.all(
        withCohort.slice(0, 60).map(async (x) => {
          const v = await apiRead<ApplicationView>(`/v1/issuer/applications/${x.id}`);
          return { record: x, status: v.ok ? v.data.status : ('submitted' as const) };
        }),
      );
      if (live) setPipeline(cohorts(views));
    })();
    return () => {
      live = false;
    };
  }, []);
  return (
    <div className="mt-8 space-y-10">
      <section aria-labelledby="how-h" className="max-w-2xl space-y-3 text-sm">
        <h2 id="how-h" className="text-xl font-semibold tracking-tight">
          How a cohort company raises here
        </h2>
        <p className="text-muted">
          A company that belongs to an accelerator or a program runs its raise the same way as any issuer: it drafts the cross in the wizard, tests demand with a draft listing, and applies for review naming the program it belongs to. The cross is public and priced by the same rule for everyone.
        </p>
        <ol className="list-decimal space-y-1 pl-5 text-muted">
          <li>
            <Link className="underline underline-offset-4" href="/issuer/demand">Publish a draft listing</Link> and share it with your cohort and audience.
          </li>
          <li>
            <Link className="underline underline-offset-4" href="/issue">Open the wizard</Link>, simulate, and create the cross.
          </li>
          <li>
            <Link className="underline underline-offset-4" href="/issuer/apply">Apply for review</Link> and name your program in the cohort field.
          </li>
        </ol>
        <p className="rounded-lg border border-border bg-surface p-3 text-muted" data-testid="no-partnership">
          There is no partnership with any accelerator behind this page. The cohort an applicant names is the applicant&apos;s own statement and nobody verifies it. A program that wants its companies listed here as members, or wants a say in how its cohort raises, has to agree that with the people who run this product.
        </p>
      </section>
      <section aria-labelledby="pipe-h">
        <h2 id="pipe-h" className="text-xl font-semibold tracking-tight">
          The pipeline
        </h2>
        {error ? <p role="alert" className="mt-3 text-sm text-accent-text">{error}</p> : !pipeline ? <p role="status" className="mt-3 text-sm text-muted">Reading applications…</p> : pipeline.length === 0 ? (
          <p className="mt-3 text-sm text-muted" data-testid="empty-pipeline">No application has named a program or cohort yet.</p>
        ) : (
          <div className="mt-4 space-y-6" data-testid="pipeline">
            {pipeline.map((c) => (
              <div key={c.cohort}>
                <h3 className="font-medium">{c.cohort}</h3>
                <p className="text-xs text-muted">Named by the applicants themselves. {c.counts.accepted} accepted, {c.counts.submitted + c.counts['changes-requested']} open, {c.counts.declined} declined.</p>
                <ul className="mt-2 divide-y divide-border border-y border-border text-sm">
                  {c.items.map((i) => (
                    <li key={i.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
                      <span className="font-medium">{i.name}</span>
                      <span className="font-mono text-xs text-muted">{shortAddress(i.signer)}</span>
                      <Chip tone={TONE[i.status]}>{TEXT[i.status]}</Chip>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
