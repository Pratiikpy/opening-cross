import { describe, expect, it } from 'vitest';
import { fetchEncodedAccount } from '@solana/kit';
import { CROSS_CORE_PROGRAM_ADDRESS, protocolAddress, getProtocolDecoder } from '@opening-cross/sdk';
import { rpc } from '../src/surfnet.js';
import { FEES, world } from '../src/world.js';

describe('the surfnet', () => {
  it('runs cross_core from its real address, with a protocol account an admin initialised', async () => {
    const w = await world();
    const prog = await fetchEncodedAccount(rpc, CROSS_CORE_PROGRAM_ADDRESS, { commitment: 'confirmed' });
    expect(prog.exists && prog.executable).toBe(true);
    const acct = await fetchEncodedAccount(rpc, await protocolAddress(), { commitment: 'confirmed' });
    expect(acct.exists).toBe(true);
    if (acct.exists) {
      const p = getProtocolDecoder().decode(acct.data);
      expect(p.admin).toBe(w.operator.address);
      expect([...p.feeBps]).toEqual(FEES);
    }
  });
});
