// dryRun: a later transaction that fails only for want of an account an earlier one creates is inconclusive, not a failure.
import { describe, expect, it } from 'vitest';
import { type RpcClient, dryRun } from '../src/index.js';

const tx = (n: number) => ({ transaction: Buffer.from([n]).toString('base64'), signers: [] });
const fake = (errs: unknown[]): RpcClient =>
  ({
    simulate: async (wire: Uint8Array) => ({ err: errs[wire[0]!] ?? null, logs: [], unitsConsumed: 1, explanation: errs[wire[0]!] ? 'refused' : null }),
  }) as unknown as RpcClient;

describe('dryRun', () => {
  it('marks a later AccountNotInitialized (Anchor 3012) or AccountNotFound as inconclusive', async () => {
    const r = await dryRun([tx(0), tx(1), tx(2)], fake([null, { InstructionError: [0, { Custom: 3012 }] }, 'AccountNotFound']));
    expect(r.map((x) => [x.index, x.simulation.err === null, x.inconclusive])).toEqual([[0, true, false], [1, false, true], [2, false, true]]);
  });

  it('a first transaction that fails the same way is a real failure', async () => {
    const [r] = await dryRun([tx(0)], fake([{ InstructionError: [0, { Custom: 3012 }] }]));
    expect(r!.inconclusive).toBe(false);
  });

  it('any other failure of a later transaction stays a failure', async () => {
    const r = await dryRun([tx(0), tx(1)], fake([null, { InstructionError: [0, { Custom: 6001 }] }]));
    expect(r[1]).toMatchObject({ inconclusive: false });
    expect(r[1]!.simulation.err).not.toBeNull();
  });
});
