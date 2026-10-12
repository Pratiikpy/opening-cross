// Meteora Dynamic Fee Sharing against the real program binary: an issuer opens a vault that splits the quote token among
// stakeholders by share; anyone funds it and each recipient claims exactly its share.
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { createKeyPairSignerFromBytes } from '@solana/kit';
import { getSetComputeUnitLimitInstruction } from '@solana-program/compute-budget';
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import { MAX_FEE_SHARE_RECIPIENTS, buildClaimFeeShare, buildCreateFeeShareVault, buildFundFeeShareVault } from '@opening-cross/adapters';
import { World } from '../src/world.js';
import { DFS_FIXTURE } from '../src/harness.js';

const cu = getSetComputeUnitLimitInstruction({ units: 400_000 });
const T22 = TOKEN_2022_PROGRAM_ADDRESS;

async function setup() {
  const w = await World.create();
  const base = await createKeyPairSignerFromBytes(Keypair.generate().secretKey);
  const issuer = await w.trader(0n, 0n);
  const treasury = await w.trader(0n, 0n);
  const rewards = await w.trader(0n, 0n);
  const funder = await w.trader(0n, 0n);
  for (const u of [issuer, treasury, rewards]) await w.h.ata(u.address, w.quoteMint, w.admin);
  await w.h.fund(w.quoteMint, w.admin, funder.address, 10_000_000_000n);
  const create = buildCreateFeeShareVault({
    payer: w.creator,
    base,
    owner: w.creator.address,
    mint: w.quoteMint,
    tokenProgram: T22,
    recipients: [
      { address: issuer.address, share: 6000 },
      { address: treasury.address, share: 3000 },
      { address: rewards.address, share: 1000 },
    ],
  });
  await w.h.send([cu, create.instruction], w.creator);
  return { w, base, issuer, treasury, rewards, funder };
}

describe.skipIf(!existsSync(DFS_FIXTURE))('Meteora Dynamic Fee Sharing vault', () => {
  it('splits what is funded by share, and recipients claim exactly their part', async () => {
    const { w, base, issuer, treasury, rewards, funder } = await setup();
    await w.h.send([cu, await buildFundFeeShareVault({ funder, base: base.address, mint: w.quoteMint, tokenProgram: T22, maxAmount: 1_000_000_000n })], funder);
    expect(await w.h.balanceOf(funder.address, w.quoteMint)).toBe(9_000_000_000n);
    const claim = async (user: typeof issuer, index: number) => w.h.send([cu, await buildClaimFeeShare({ user, base: base.address, mint: w.quoteMint, tokenProgram: T22, index })], user);
    await claim(issuer, 0);
    await claim(treasury, 1);
    await claim(rewards, 2);
    expect(await w.h.balanceOf(issuer.address, w.quoteMint)).toBe(600_000_000n);
    expect(await w.h.balanceOf(treasury.address, w.quoteMint)).toBe(300_000_000n);
    expect(await w.h.balanceOf(rewards.address, w.quoteMint)).toBe(100_000_000n);
    // A second funding is shared the same way and a recipient can claim again.
    await w.h.send([cu, await buildFundFeeShareVault({ funder, base: base.address, mint: w.quoteMint, tokenProgram: T22, maxAmount: 500_000_000n })], funder);
    await claim(issuer, 0);
    expect(await w.h.balanceOf(issuer.address, w.quoteMint)).toBe(900_000_000n);
  });

  it('refuses a claim by anyone but the recipient at that index, and a bad recipient list', async () => {
    const { w, base, issuer, treasury, funder } = await setup();
    await w.h.send([cu, await buildFundFeeShareVault({ funder, base: base.address, mint: w.quoteMint, tokenProgram: T22, maxAmount: 1_000_000_000n })], funder);
    const mallory = await w.trader(0n, 0n);
    await w.h.ata(mallory.address, w.quoteMint, w.admin);
    const stolen = await buildClaimFeeShare({ user: mallory, base: base.address, mint: w.quoteMint, tokenProgram: T22, index: 0 });
    expect((await w.h.fail([cu, stolen], mallory)).length > 0).toBe(true);
    // Treasury cannot claim issuer's index either.
    const wrongIndex = await buildClaimFeeShare({ user: treasury, base: base.address, mint: w.quoteMint, tokenProgram: T22, index: 0 });
    expect((await w.h.fail([cu, wrongIndex], treasury)).length > 0).toBe(true);
    expect(await w.h.balanceOf(mallory.address, w.quoteMint)).toBe(0n);
    expect(await w.h.balanceOf(issuer.address, w.quoteMint)).toBe(0n);
    const mk = (addrs: string[]) => buildCreateFeeShareVault({ payer: w.creator, base, owner: w.creator.address, mint: w.quoteMint, tokenProgram: T22, recipients: addrs.map((address) => ({ address: address as never, share: 1 })) });
    expect(() => mk([])).toThrow();
    expect(() => mk(Array.from({ length: MAX_FEE_SHARE_RECIPIENTS + 1 }, (_, i) => `${i}`))).toThrow();
    expect(() => mk([issuer.address, issuer.address])).toThrow();
  });
});
