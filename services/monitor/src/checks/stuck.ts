// Crosses that nobody is moving forward. These are warnings, not reasons to pause: a stuck cross is a keeper that is not
// running, and pausing new orders does not help it. Funds in such a cross are not at risk (anyone can clear, claim and refund),
// but the people in it are waiting.
import { CrossState } from '@opening-cross/sdk';
import type { Check, Finding } from '../types.js';
import { allCrosses } from './vault.js';

export function stuckCrosses(o: { graceSeconds?: number; claimsGraceSeconds?: number } = {}): Check {
  const grace = BigInt(o.graceSeconds ?? 1_800);
  const claims = BigInt(o.claimsGraceSeconds ?? 86_400);
  return {
    name: 'stuck-crosses',
    async run(ctx) {
      const now = BigInt(ctx.now);
      const out: Finding[] = [];
      for (const c of await allCrosses(ctx)) {
        const end = c.data.revealEndTs > c.data.closeTs ? c.data.revealEndTs : c.data.closeTs;
        if (c.data.state === CrossState.Live && now > end + grace) {
          out.push({ check: 'stuck-crosses', subject: `${c.address}:clear`, severity: 'warning', message: `cross ${c.address} closed ${(now - end) / 60n} minutes ago and has not been cleared`, evidence: { cross: c.address, closedAgoSeconds: (now - end).toString(), ordersOpen: c.data.ordersOpen } });
        } else if ((c.data.state === CrossState.Cleared || c.data.state === CrossState.NoPrint) && c.data.ordersOpen > 0 && now > c.data.closeTs + claims) {
          out.push({ check: 'stuck-crosses', subject: `${c.address}:claims`, severity: 'warning', message: `cross ${c.address} has ${c.data.ordersOpen} orders still to claim ${(now - c.data.closeTs) / 3600n} hours after it closed`, evidence: { cross: c.address, ordersOpen: c.data.ordersOpen } });
        }
      }
      return out;
    },
  };
}
