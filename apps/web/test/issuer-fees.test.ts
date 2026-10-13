import { describe, expect, it } from 'vitest';
import { KINDS, PROPOSED_SCHEDULE, protocolFeeBps as pkgProtocol, totalFeeBps as pkgTotal } from '../../../packages/fees/src/schedule';
import { PROPOSED_FEES, protocolFeeBps, totalFeeBps } from '../src/lib/issuer-fees';

describe('fee maths equals packages/fees', () => {
  it('the proposed schedule is the package’s', () => {
    expect(KINDS.map((k) => PROPOSED_FEES[k])).toEqual([...PROPOSED_SCHEDULE]);
  });
  it('protocol and total fee agree for every kind and every integrator fee from 0 to 300', () => {
    for (const kind of KINDS) {
      for (let i = 0; i <= 300; i++) {
        const p = protocolFeeBps(PROPOSED_FEES, kind, i);
        expect(p, `${kind} ${i}`).toBe(pkgProtocol(PROPOSED_SCHEDULE, kind, i));
        expect(totalFeeBps(p, i)).toBe(pkgTotal(p, i));
      }
    }
  });
  it('no integrator fee means no fee at all', () => {
    for (const kind of KINDS) expect(totalFeeBps(protocolFeeBps(PROPOSED_FEES, kind, 0), 0)).toBe(0);
  });
});
