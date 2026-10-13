// The accelerator pipeline (R7): applications grouped by the program or cohort each names. The name is the applicant's own claim and is
// grouped as typed apart from case and spacing, so "Example Accelerator" and "example  accelerator" are one group and nothing is merged beyond that.
import type { ApplicationView, StoredRecord } from './issuer-board';

export type Status = ApplicationView['status'];
export type Pipeline = { cohort: string; counts: Record<Status, number>; items: { id: string; name: string; signer: string; status: Status }[] }[];

const key = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

export function cohorts(apps: readonly { record: StoredRecord; status: Status }[]): Pipeline {
  const groups = new Map<string, Pipeline[number]>();
  for (const { record, status } of apps) {
    const raw = record.body.cohort;
    if (typeof raw !== 'string' || raw.trim() === '') continue;
    const k = key(raw);
    let g = groups.get(k);
    if (!g) {
      g = { cohort: raw.trim().replace(/\s+/g, ' '), counts: { submitted: 0, accepted: 0, 'changes-requested': 0, declined: 0 }, items: [] };
      groups.set(k, g);
    }
    g.counts[status] += 1;
    g.items.push({ id: record.id, name: String(record.body.name), signer: record.signer, status });
  }
  return [...groups.values()].sort((a, b) => b.items.length - a.items.length || (a.cohort < b.cohort ? -1 : 1));
}
