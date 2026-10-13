import { describe, expect, it } from 'vitest';
import type { StoredRecord } from '../src/lib/issuer-board';
import { cohorts } from '../src/lib/issuer-pipeline';

const app = (id: string, name: string, cohort: unknown): StoredRecord => ({ id, kind: 'application', signer: `S${id}`, subject: null, issuedAt: 1, body: { name, cohort }, signature: 's' });

describe('cohorts', () => {
  it('groups by the name applicants typed, apart from case and spacing, and counts statuses', () => {
    const p = cohorts([
      { record: app('1', 'A', 'Example Accelerator'), status: 'accepted' },
      { record: app('2', 'B', ' example   accelerator '), status: 'submitted' },
      { record: app('3', 'C', 'Other Program'), status: 'declined' },
    ]);
    expect(p.map((g) => [g.cohort, g.items.length])).toEqual([['Example Accelerator', 2], ['Other Program', 1]]);
    expect(p[0]!.counts).toEqual({ submitted: 1, accepted: 1, 'changes-requested': 0, declined: 0 });
  });
  it('leaves out applications that name no cohort, and merges nothing else', () => {
    expect(cohorts([{ record: app('1', 'A', null), status: 'submitted' }, { record: app('2', 'B', '  '), status: 'submitted' }, { record: app('3', 'C', 7), status: 'submitted' }])).toEqual([]);
    expect(cohorts([{ record: app('1', 'A', 'Acme'), status: 'submitted' }, { record: app('2', 'B', 'Acme Labs'), status: 'submitted' }]).length).toBe(2);
  });
});
