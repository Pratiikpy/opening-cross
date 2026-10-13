'use client';

import { type ProgramReport, type Programs, releaseOf } from '@/lib/holder-programs';

/**
 * The plain statement a screen makes about the program release it depends on. It says nothing when the extension is deployed (the screen
 * then works as written), says that the upgrade is pending when the deployed program is the first release, and says it could not tell when
 * the release could not be read. It never turns "could not tell" into "first release".
 */
export function ReleaseNotice({ programs, program, what, children }: { programs: Programs | null | 'unavailable'; program: 'crossCore' | 'treasury'; what: string; children?: React.ReactNode }) {
  if (programs === null) return null;
  const report: ProgramReport | null = programs === 'unavailable' ? null : programs.programs[program];
  const release = releaseOf(report);
  if (release === 'extended') return null;
  const name = program === 'crossCore' ? 'cross' : 'treasury';
  return (
    <p role="note" data-testid={`release-${release}`} className="rounded-[var(--radius-card)] border border-border bg-surface px-4 py-3 text-sm text-muted">
      <span className="font-medium text-ink">{release === 'first-release' ? 'Not deployed on this network yet. ' : 'Deployment not confirmed. '}</span>
      {release === 'first-release'
        ? `${what} is built and proved on LiteSVM and a local validator, but the ${name} program deployed here is still the first release, so it cannot do this yet. It goes live when the upgrade is funded (H27).`
        : `${what} needs the extended ${name} program. This page could not read which release this network runs, so it does not say either way.`}
      {children}
    </p>
  );
}
