// The facilitator's confirmation wait against an RPC that fails some of its status polls: the shared public endpoints do this
// under load, and a failed poll must not end the wait while the transaction can still land.
import { describe, expect, it } from 'vitest';
import { LocalFacilitator } from '../src/facilitator.js';
import type { SvmRpc } from '../src/network.js';

function fakeRpc(opts: { statusFailures: number; landsAfterPolls: number }) {
  let polls = 0;
  const sent: string[] = [];
  const rpc = {
    sendTransaction: (wire: string) => ({ send: async () => (sent.push(wire), 'sig') }),
    getSignatureStatuses: () => ({
      send: async () => {
        polls++;
        if (polls <= opts.statusFailures) throw new Error('HTTP error (429): Too Many Requests');
        return { value: [polls > opts.statusFailures + opts.landsAfterPolls ? { err: null, confirmationStatus: 'confirmed' } : null] };
      },
    }),
  };
  return { rpc: rpc as unknown as SvmRpc, sent, polls: () => polls };
}

const facilitator = (rpc: SvmRpc, confirmTimeoutMs = 2_000) =>
  new LocalFacilitator({ rpc, network: 'solana:test', signers: [{ address: 'Fee111111111111111111111111111111111111111' } as never], policy: { payTo: [], assets: [] }, pollMs: 1, confirmTimeoutMs });

describe('settlement confirmation', () => {
  it('rides out failed status polls and resends the same bytes until the transaction lands', async () => {
    const f = fakeRpc({ statusFailures: 3, landsAfterPolls: 2 });
    const out = await facilitator(f.rpc).broadcast('wire', 'sig');
    expect(out).toEqual({ ok: true });
    expect(f.polls()).toBeGreaterThan(3);
  });

  it('reports unconfirmed, not failed, when the endpoint never answers within the deadline', async () => {
    const f = fakeRpc({ statusFailures: 10_000, landsAfterPolls: 0 });
    const out = await facilitator(f.rpc, 50).broadcast('wire', 'sig');
    expect(out).toMatchObject({ ok: false, reason: 'settlement_unconfirmed' });
  });
});
