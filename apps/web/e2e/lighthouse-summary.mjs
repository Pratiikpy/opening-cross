// Prints category scores and every failing audit from Lighthouse JSON reports.
import { readFileSync } from 'node:fs';
for (const f of process.argv.slice(2)) {
  const r = JSON.parse(readFileSync(f, 'utf8'));
  console.log(f, Object.entries(r.categories).map(([k, v]) => `${k}=${Math.round(v.score * 100)}`).join(' '));
  for (const a of Object.values(r.audits)) if (a.score !== null && a.score < 0.9 && a.scoreDisplayMode !== 'informative' && a.scoreDisplayMode !== 'manual') console.log('  ', a.id, a.score, a.displayValue ?? '');
}
