// Calibration reasons travel inside signed promises as short machine codes (NEED_9_SAMPLES_FOR_A_BOUNDED_BAND (have 0);
// SAMPLES 0<30; ...). The record keeps them verbatim; this turns them into a sentence a person can read. A code that
// is not recognised is shown as it is, never dropped.

const PART: [RegExp, (m: RegExpExecArray) => string][] = [
  [/^NEED_(\d+)_SAMPLES_FOR_A_BOUNDED_BAND \(have (\d+)\)$/, (m) => `at least ${m[1]} graded crosses to bound a band at all (${m[2]} so far)`],
  [/^SAMPLES (\d+)<(\d+)$/, (m) => `${m[1]} of the ${m[2]} graded crosses needed`],
  [/^DISTINCT_DAYS (\d+)<(\d+)$/, (m) => `${m[1]} of the ${m[2]} separate days needed`],
  [/^HELD_OUT (\d+)<(\d+)$/, (m) => `${m[1]} of the ${m[2]} held-out checks needed`],
];

const BELOW = /^COVERAGE_BELOW_NOMINAL measured ([\d.]+)% \[([\d.]+), ([\d.]+)\] is below nominal (\d+)%$/;

/** A sentence explaining why a band claims no coverage, or null when there is nothing to explain. */
export function explainCalibration(reason: string | null): string | null {
  if (!reason) return null;
  const needs: string[] = [];
  const other: string[] = [];
  for (const raw of reason.split('; ')) {
    const below = BELOW.exec(raw);
    if (below) {
      other.push(`On held-out crosses the band held ${below[1]}% of the time (95% range ${below[2]}% to ${below[3]}%), below the ${below[4]}% it would have to claim.`);
      continue;
    }
    const hit = PART.map(([re, f]) => ({ m: re.exec(raw), f })).find((x) => x.m);
    if (hit?.m) needs.push(hit.f(hit.m));
    else other.push(raw);
  }
  return [needs.length ? `A band claims a coverage only once enough crosses have been graded: ${needs.join('; ')}.` : '', ...other].filter(Boolean).join(' ');
}
