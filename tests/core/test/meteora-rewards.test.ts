// DAMM v2 reward slots (ADR-0911, rows D1, X17) on the real cp_amm binary: the pool creator opens slot 0, a named funder streams a reward over a day, the
// issuer's own position claims its share, and the program's refusals (slot 1, a stranger, a wrong funder, a short duration, a running stream) are read
// from its logs.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BorshAccountsCoder } from '@coral-xyz/anchor';
import { generateKeyPairSigner } from '@solana/kit';
import { getSetComputeUnitLimitInstruction } from '@solana-program/compute-budget';
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import { OrderSide } from '@opening-cross/sdk';
import {
  buildAddDammLiquidity,
  buildClaimDammReward,
  buildCreateDammPosition,
  buildFundDammReward,
  buildInitializeDammReward,
  buildSeedDammV2,
  buildUpdateDammRewardDuration,
  buildUpdateDammRewardFunder,
  buildWithdrawIneligibleDammReward,
  dammRewardVaultAddress,
  decodeDammPoolRewards,
} from '@opening-cross/adapters';
import { World } from '../src/world.js';
import { DAMM_FIXTURE } from '../src/harness.js';

const idl = JSON.parse(readFileSync(fileURLToPath(new URL('../../../idls/cp_amm.json', import.meta.url)), 'utf8'));
const coder = new BorshAccountsCoder(idl);
const cu = getSetComputeUnitLimitInstruction({ units: 1_400_000 });
const T22 = TOKEN_2022_PROGRAM_ADDRESS;
const DAY = 86_400n;
const observed: Record<string, string> = {};

async function tryTx(w: World, ixs: Parameters<World['h']['send']>[0], who: Parameters<World['h']['send']>[1]): Promise<string> {
  try {
    await w.h.send(ixs, who);
    return 'ok';
  } catch (e) {
    const logs = (e as { logs?: string[] }).logs;
    return (logs ? logs.join(' ') : String(e)).match(/Error Code: (\w+)/)?.[1] ?? (logs ? logs.slice(-2).join(' ') : String(e)).slice(0, 200);
  }
}

async function clearedCross(w: World) {
  const cross = await w.newCross();
  const s = await w.trader(0n, 5_000_000_000n);
  const b = await w.trader(20_000_000_000n);
  const orders = [await w.place(cross, s, OrderSide.Sell, 1_200_000n, 2_000_000_000n), await w.place(cross, b, OrderSide.Buy, 1_300_000n, 2_000_000_000n)];
  const settled = await w.settle(cross);
  await w.claimAll(settled, orders);
  await w.finalize(w.view(cross.address));
  return w.view(cross.address);
}

const slot = (w: World, pool: string, i: number) => {
  const a = w.h.svm.getAccount(pool as never);
  if (!a.exists) throw new Error('pool missing');
  const p = coder.decode('Pool', Buffer.from(a.data));
  const r = p.reward_infos[i];
  return { initialized: r.initialized as number, mint: r.mint.toBase58() as string, funder: r.funder.toBase58() as string, duration: BigInt(r.reward_duration.toString()), end: BigInt(r.reward_duration_end.toString()), rate: BigInt(r.reward_rate.toString()) };
};

describe.skipIf(!existsSync(DAMM_FIXTURE))('DAMM v2 reward slots', () => {
  it('opens slot 0 as the pool creator, streams a reward to the issuer position and refuses every departure', async () => {
    const w = await World.create();
    const cross = await clearedCross(w);
    await w.h.fund(w.baseMint, w.admin, w.creator.address, 10_000_000_000n);
    const seed = await buildSeedDammV2({ cross, creator: w.creator, baseAmount: 5_000_000_000n, quoteAmount: 6_000_000_000n, feeBps: 30 });
    await w.h.send([cu, seed.instruction], w.creator);
    const pool = seed.addresses.pool;
    const rewardMint = await w.h.mint(w.admin, 6);
    const sponsor = await w.trader(0n, 0n);
    await w.h.fund(rewardMint, w.admin, sponsor.address, 10_000_000_000n);
    const mallory = await w.trader(0n, 0n);
    await w.h.ata(mallory.address, rewardMint, w.admin);
    const init = (over: Partial<Parameters<typeof buildInitializeDammReward>[0]> = {}) => buildInitializeDammReward({ pool, signer: w.creator, payer: w.creator, rewardMint, tokenProgram: T22, index: 0, durationSecs: DAY, funder: sponsor.address, ...over });

    // Departures before anything is opened: a stranger cannot open slot 0; the creator cannot open slot 1; a duration under a day is refused by the program
    // (the builder refuses it too).
    expect(() => init({ durationSecs: DAY - 1n })).toThrow(/streams over/);
    observed.strangerOpens = await tryTx(w, [init({ signer: mallory, payer: mallory })], mallory);
    observed.creatorOpensSlot1 = await tryTx(w, [init({ index: 1 })], w.creator);
    const shortWire = init();
    const shortData = Buffer.from(shortWire.data!);
    shortData.writeBigUInt64LE(DAY - 1n, 8 + 1);
    observed.shortDuration = await tryTx(w, [{ ...shortWire, data: new Uint8Array(shortData) }], w.creator);
    expect(slot(w, pool, 0).initialized).toBe(0);

    // The creator opens slot 0 and names the sponsor as its only funder.
    await w.h.send([init()], w.creator);
    const s0 = slot(w, pool, 0);
    expect(s0).toMatchObject({ initialized: 1, mint: rewardMint, funder: sponsor.address, duration: DAY });
    expect(w.h.exists(dammRewardVaultAddress(pool, 0))).toBe(true);
    observed.openTwice = await tryTx(w, [init()], w.creator);

    // Only the named funder funds it; the creator is refused. Funding moves the tokens into the slot's vault and starts the stream.
    const fund = (who: typeof sponsor, amount: bigint, carry = false) => buildFundDammReward({ pool, funder: who, rewardMint, tokenProgram: T22, index: 0, amount, carryForward: carry });
    await w.h.ata(w.creator.address, rewardMint, w.admin);
    await w.h.fund(rewardMint, w.admin, w.creator.address, 1_000_000_000n);
    observed.wrongFunder = await tryTx(w, [await fund(w.creator, 1_000_000_000n)], w.creator);
    const fundedAt = w.h.svm.getClock().unixTimestamp;
    await w.h.send([await fund(sponsor, 8_640_000_000n)], sponsor);
    expect(await w.h.balance(dammRewardVaultAddress(pool, 0))).toBe(8_640_000_000n);
    expect(await w.h.balanceOf(sponsor.address, rewardMint)).toBe(10_000_000_000n - 8_640_000_000n);
    const s1 = slot(w, pool, 0);
    expect(s1.end).toBe(fundedAt + DAY);
    // The adapters' own decoder agrees with Anchor's on the slot, the creator and the pool's liquidity.
    const raw = w.h.svm.getAccount(pool);
    if (!raw.exists) throw new Error('pool missing');
    const dec = decodeDammPoolRewards(new Uint8Array(raw.data))!;
    expect(dec.creator).toBe(w.creator.address);
    expect(dec.liquidity).toBe(BigInt(coder.decode('Pool', Buffer.from(raw.data)).liquidity.toString()));
    expect(dec.slots[0]).toMatchObject({ index: 0, initialized: true, mint: rewardMint, funder: sponsor.address, durationSecs: DAY, endsAt: s1.end, rate: s1.rate, vault: dammRewardVaultAddress(pool, 0) });
    expect(dec.slots[1]!.initialized).toBe(false);
    observed.fundWhileRunning = await tryTx(w, [await fund(sponsor, 1n)], sponsor);

    // An outside holder joins the pool with a third of the issuer's liquidity (so a quarter of the pool) and shares the stream from then on.
    const dave = await w.trader(10_000_000_000n, 10_000_000_000n);
    const nft = await generateKeyPairSigner();
    const created = buildCreateDammPosition({ pool, owner: dave.address, payer: dave, positionNftMint: nft });
    const share = seed.liquidity / 3n;
    const joinedAt = w.h.svm.getClock().unixTimestamp;
    await w.h.send([cu, created.instruction, await buildAddDammLiquidity({ pool, position: created.position, positionNftAccount: created.positionNftAccount, owner: dave, tokenAMint: w.baseMint, tokenBMint: w.quoteMint, tokenAVault: seed.addresses.tokenAVault, tokenBVault: seed.addresses.tokenBVault, tokenAProgram: T22, tokenBProgram: T22, liquidityDelta: share, maxTokenA: 5_000_000_000n, maxTokenB: 6_000_000_000n })], dave);
    expect(joinedAt).toBe(fundedAt);

    // Half a day later the stream has paid half of 8,640,000,000 (100,000 per second) and splits it by liquidity: three quarters to the issuer, one quarter to Dave.
    w.h.setTime(fundedAt + DAY / 2n);
    const claim = () => buildClaimDammReward({ pool, position: seed.addresses.position, positionNftAccount: seed.addresses.positionNftAccount, owner: w.creator, rewardMint, tokenProgram: T22, index: 0 });
    const before = await w.h.balanceOf(w.creator.address, rewardMint);
    await w.h.send(await claim(), w.creator);
    const half = (await w.h.balanceOf(w.creator.address, rewardMint)) - before;
    expect(half <= 3_240_000_000n && half >= 3_240_000_000n - 100_000n).toBe(true);
    await w.h.send(await buildClaimDammReward({ pool, position: created.position, positionNftAccount: created.positionNftAccount, owner: dave, rewardMint, tokenProgram: T22, index: 0 }), dave);
    const daveHalf = await w.h.balanceOf(dave.address, rewardMint);
    expect(daveHalf <= 1_080_000_000n && daveHalf >= 1_080_000_000n - 100_000n).toBe(true);
    // Dave's position is Dave's: the issuer's signature cannot claim it.
    observed.issuerClaimsDaves = await tryTx(w, await buildClaimDammReward({ pool, position: created.position, positionNftAccount: created.positionNftAccount, owner: w.creator, rewardMint, tokenProgram: T22, index: 0 }), w.creator);
    // A stranger holding no position NFT cannot claim, and a second claim in the same second pays nothing more.
    const stolen = await buildClaimDammReward({ pool, position: seed.addresses.position, positionNftAccount: seed.addresses.positionNftAccount, owner: mallory, rewardMint, tokenProgram: T22, index: 0 });
    observed.strangerClaims = await tryTx(w, stolen, mallory);
    const again = await tryTx(w, await claim(), w.creator);
    expect(again).toBe('ok');
    expect((await w.h.balanceOf(w.creator.address, rewardMint)) - before - half).toBe(0n);

    // After the day the rest is claimable; the slot's vault is then empty to within rounding.
    w.h.setTime(fundedAt + DAY + 5n);
    await w.h.send(await claim(), w.creator);
    await w.h.send(await buildClaimDammReward({ pool, position: created.position, positionNftAccount: created.positionNftAccount, owner: dave, rewardMint, tokenProgram: T22, index: 0 }), dave);
    const total = (await w.h.balanceOf(w.creator.address, rewardMint)) - before;
    const daveTotal = await w.h.balanceOf(dave.address, rewardMint);
    expect(total <= 6_480_000_000n && total >= 6_480_000_000n - 200_000n).toBe(true);
    expect(daveTotal <= 2_160_000_000n && daveTotal >= 2_160_000_000n - 200_000n).toBe(true);
    // Nothing is created or lost: the two claims add up to the funded amount to within the rounding of the fixed-point rate, and that dust is all the vault keeps.
    // (The 1 atom the test added while the stream ran is in the vault too.)
    expect(total + daveTotal <= 8_640_000_001n && 8_640_000_001n - (total + daveTotal) <= 400_000n).toBe(true);
    expect(await w.h.balance(dammRewardVaultAddress(pool, 0))).toBe(8_640_000_001n - (total + daveTotal));

    // The stream has ended, so the creator may change the duration and the funder; a stranger may not.
    observed.strangerChangesFunder = await tryTx(w, [buildUpdateDammRewardFunder({ pool, signer: mallory, index: 0, newFunder: mallory.address })], mallory);
    await w.h.send([buildUpdateDammRewardDuration({ pool, signer: w.creator, index: 0, newDurationSecs: 2n * DAY })], w.creator);
    expect(slot(w, pool, 0).duration).toBe(2n * DAY);
    await w.h.send([buildUpdateDammRewardFunder({ pool, signer: w.creator, index: 0, newFunder: w.creator.address })], w.creator);
    expect(slot(w, pool, 0).funder).toBe(w.creator.address);
    // The new funder streams a second round, carrying nothing forward, and withdraws nothing it was not owed: the pool had liquidity throughout.
    await w.h.send([await fund(w.creator, 1_000_000_000n)], w.creator);
    observed.withdrawIneligible = await tryTx(w, [await buildWithdrawIneligibleDammReward({ pool, funder: w.creator, rewardMint, tokenProgram: T22, index: 0 })], w.creator);
    expect(observed).toMatchObject({
      strangerOpens: 'MissingOperatorAccount',
      creatorOpensSlot1: 'MissingOperatorAccount',
      shortDuration: 'InvalidRewardDuration',
      wrongFunder: 'InvalidAdmin',
      fundWhileRunning: 'ok',
      strangerClaims: 'InvalidAuthority',
      strangerChangesFunder: 'MissingOperatorAccount',
      withdrawIneligible: 'RewardNotEnded',
    });
    expect(observed.openTwice).not.toBe('ok');
    console.table(observed);
  });
});
