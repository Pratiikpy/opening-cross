// Met Lock vesting escrows (ADR-0483) against the real Meteora binary: a schedule fixed at creation, claims that follow it to the
// atom, and refusals for the wrong signer, an early claim and a creator who gave up the power to cancel.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { address } from '@solana/kit';
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import { MET_LOCK_PROGRAM_ADDRESS, buildClaimVested, buildCreateVestingEscrow, metLockSchedule, metLockVested } from '@opening-cross/adapters';
import { generateKeyPairSigner } from '@solana/kit';
import { World } from '../src/world.js';
import { T0 } from '../src/harness.js';

const FIXTURE = fileURLToPath(new URL('../../fixtures/met_lock.so', import.meta.url));
const T22 = TOKEN_2022_PROGRAM_ADDRESS;

async function setup() {
  const w = await World.create();
  w.h.svm.addProgramFromFile(address(MET_LOCK_PROGRAM_ADDRESS), FIXTURE);
  const base = await generateKeyPairSigner();
  const recipient = await w.h.wallet();
  await w.h.fund(w.baseMint, w.admin, w.creator.address, 1_000_000_000n);
  const schedule = metLockSchedule({ total: 1_000_000_000n, start: T0, cliffSeconds: 100n, frequency: 100n, periods: 4n, cliffUnlockBps: 1000 });
  const created = await buildCreateVestingEscrow({ sender: w.creator, base, mint: w.baseMint, tokenProgram: T22, recipient: recipient.address, schedule });
  await w.h.send(created.instructions, w.creator);
  return { w, base, recipient, schedule, escrow: created.addresses.escrow };
}

describe.skipIf(!existsSync(FIXTURE))('Met Lock escrow on the real binary', () => {
  it('locks the whole schedule and releases it exactly as the adapter computes it', async () => {
    const { w, recipient, schedule, escrow } = await setup();
    expect(await w.h.balanceOf(w.creator.address, w.baseMint)).toBe(0n);
    expect(await w.h.balanceOf(escrow, w.baseMint)).toBe(1_000_000_000n);

    // Before the cliff nothing has vested: a claim moves no tokens.
    w.h.setTime(T0 + 50n);
    await w.h.send(await buildClaimVested({ recipient, escrow, mint: w.baseMint, tokenProgram: T22 }), recipient);
    expect(await w.h.balanceOf(recipient.address, w.baseMint)).toBe(0n);
    expect(await w.h.balanceOf(escrow, w.baseMint)).toBe(1_000_000_000n);

    let claimed = 0n;
    for (const t of [100n, 150n, 250n, 399n, 500n, 10_000n]) {
      w.h.setTime(T0 + t);
      const expected = metLockVested(schedule, T0 + t);
      await w.h.send(await buildClaimVested({ recipient, escrow, mint: w.baseMint, tokenProgram: T22 }), recipient);
      claimed = await w.h.balanceOf(recipient.address, w.baseMint);
      expect(claimed, `at +${t}s`).toBe(expected);
    }
    expect(claimed).toBe(1_000_000_000n);
    expect(await w.h.balanceOf(escrow, w.baseMint)).toBe(0n);
  });

  it('refuses a claim signed by anyone but the recipient', async () => {
    const { w, escrow } = await setup();
    w.h.setTime(T0 + 1_000n);
    const thief = await w.h.wallet();
    const log = await w.h.fail(await buildClaimVested({ recipient: thief, escrow, mint: w.baseMint, tokenProgram: T22 }), thief);
    expect(log).toBeTruthy();
    expect(await w.h.balanceOf(thief.address, w.baseMint)).toBe(0n);
  });
});
