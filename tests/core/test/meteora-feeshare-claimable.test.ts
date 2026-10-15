// Dynamic Fee Sharing: the claimable amount, computed from the vault account alone, equals what a real claim pays (ADR-0912, row D7), and the accumulator's
// scale is the program's own (a Q64 fixed-point `fee_per_share`). Run on the real dynamic_fee_sharing binary with shares that do not divide the funding, so
// the rounding is exercised and not hidden.
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { createKeyPairSignerFromBytes } from '@solana/kit';
import { getSetComputeUnitLimitInstruction } from '@solana-program/compute-budget';
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import {
  buildClaimFeeShare,
  buildCreateFeeShareVault,
  buildFundFeeShareVault,
  decodeFeeShareVault,
  feeShareAccumulatorStep,
  feeShareAddresses,
  feeShareClaimable,
  feeShareClaimableAfterFunding,
} from '@opening-cross/adapters';
import { World } from '../src/world.js';
import { DFS_FIXTURE } from '../src/harness.js';

const cu = getSetComputeUnitLimitInstruction({ units: 400_000 });
const T22 = TOKEN_2022_PROGRAM_ADDRESS;

describe.skipIf(!existsSync(DFS_FIXTURE))('Dynamic Fee Sharing claimable amount', () => {
  it('equals what a real claim pays, before and after claims and fundings, and the accumulator moves by (amount << 64) / total_share', async () => {
    const w = await World.create();
    const base = await createKeyPairSignerFromBytes(Keypair.generate().secretKey);
    const people = [await w.trader(0n, 0n), await w.trader(0n, 0n), await w.trader(0n, 0n)];
    const weights = [7, 13, 17];
    const funder = await w.trader(10_000_000_000n);
    for (const u of people) await w.h.ata(u.address, w.quoteMint, w.admin);
    await w.h.send([cu, buildCreateFeeShareVault({ payer: w.creator, base, owner: w.creator.address, mint: w.quoteMint, tokenProgram: T22, recipients: people.map((p, i) => ({ address: p.address, share: weights[i]! })) }).instruction], w.creator);
    const vaultAddress = feeShareAddresses(base.address, w.quoteMint).feeVault;
    const read = () => {
      const a = w.h.svm.getAccount(vaultAddress);
      if (!a.exists) throw new Error('vault missing');
      const v = decodeFeeShareVault(a.data);
      if (!v) throw new Error('vault does not decode');
      return v;
    };
    const fundNow = async (amount: bigint) => w.h.send([cu, await buildFundFeeShareVault({ funder, base: base.address, mint: w.quoteMint, tokenProgram: T22, maxAmount: amount })], funder);
    const claim = async (i: number) => {
      const before = await w.h.balanceOf(people[i]!.address, w.quoteMint);
      await w.h.send([cu, await buildClaimFeeShare({ user: people[i]!, base: base.address, mint: w.quoteMint, tokenProgram: T22, index: i })], people[i]!);
      return (await w.h.balanceOf(people[i]!.address, w.quoteMint)) - before;
    };

    // The vault decodes: three recipients, their weights, nothing funded.
    const empty = read();
    expect(empty.users.map((u) => [u.index, u.address, u.share])).toEqual(people.map((p, i) => [i, p.address, weights[i]]));
    expect([empty.totalShare, empty.totalFundedFee, empty.feePerShare, empty.base, empty.tokenMint]).toEqual([37, 0n, 0n, base.address, w.quoteMint]);

    // First funding, 1,000,000,007 (not divisible by 37): the accumulator moves by the documented step and the claimable amounts follow from it.
    const first = 1_000_000_007n;
    const funded = await (async () => {
      await fundNow(first);
      return read();
    })();
    expect(funded.totalFundedFee).toBe(first);
    expect(funded.feePerShare).toBe(feeShareAccumulatorStep(first, 37));
    const promised = people.map((_, i) => feeShareClaimable(funded, i));
    expect(promised).toEqual(weights.map((s) => (BigInt(s) * feeShareAccumulatorStep(first, 37)) >> 64n));
    const second = 333_333_333n;

    // Recipient 0 claims the first funding: the real payment is the computed figure to the atom, and the checkpoint moves to the accumulator.
    expect(await claim(0)).toBe(promised[0]);
    const afterFirstClaim = read();
    expect(afterFirstClaim.users[0]!.checkpoint).toBe(funded.feePerShare);
    expect(afterFirstClaim.users[0]!.feeClaimed).toBe(promised[0]);
    expect(feeShareClaimable(afterFirstClaim, 0)).toBe(0n);
    // The others' figures did not change by someone else's claim.
    expect([feeShareClaimable(afterFirstClaim, 1), feeShareClaimable(afterFirstClaim, 2)]).toEqual([promised[1], promised[2]]);

    // The projection of a funding that has not happened equals the figure after it does, for every recipient, from the vault as it stands now.
    const projected = people.map((_, i) => feeShareClaimableAfterFunding(afterFirstClaim, i, second));

    // Second funding: recipient 0 is owed only the new part, the others the old and the new, as projected before it happened.
    await fundNow(second);
    const afterSecond = read();
    const owed = people.map((_, i) => feeShareClaimable(afterSecond, i));
    expect(owed).toEqual(projected);
    const paid = [await claim(0), await claim(1), await claim(2)];
    expect(paid).toEqual(owed);

    // Conservation: everything paid, plus the first claim, is no more than was funded, and the shortfall is rounding dust under one atom per recipient per funding.
    const total = promised[0]! + paid[0]! + paid[1]! + paid[2]!;
    expect(total <= first + second).toBe(true);
    expect(first + second - total <= 6n).toBe(true);
    expect(await w.h.balance(feeShareAddresses(base.address, w.quoteMint).tokenVault)).toBe(first + second - total);
    // Nothing is claimable twice.
    expect(people.map((_, i) => feeShareClaimable(read(), i))).toEqual([0n, 0n, 0n]);
  });

  it('is refused by the program with a single recipient, as its documentation says', async () => {
    const w = await World.create();
    const base = await createKeyPairSignerFromBytes(Keypair.generate().secretKey);
    const [a, b] = [await w.trader(0n, 0n), await w.trader(0n, 0n)];
    // The builder refuses a single recipient; to see what the program says, shorten a valid two-recipient instruction to one entry by hand.
    expect(() => buildCreateFeeShareVault({ payer: w.creator, base, owner: w.creator.address, mint: w.quoteMint, tokenProgram: T22, recipients: [{ address: a.address, share: 1 }] })).toThrow(/2 to 5 recipients/);
    const two = buildCreateFeeShareVault({ payer: w.creator, base, owner: w.creator.address, mint: w.quoteMint, tokenProgram: T22, recipients: [{ address: a.address, share: 1 }, { address: b.address, share: 1 }] });
    const data = Buffer.from(two.instruction.data!);
    data.writeUInt32LE(1, 8 + 64);
    const logs = await w.h.fail([cu, { ...two.instruction, data: new Uint8Array(data.subarray(0, 8 + 64 + 4 + 36)) }], w.creator);
    expect(logs.match(/Error Code: (\w+)/)?.[1]).toBe('ExceededUser');
  });
});
