// Governed graduation (D10, Z0; ADR-0656): a cross whose creator set FLAG_GOVERNED_GRADUATION can open a pool only at the venue
// a holder vote chose. Against the real cp-amm binary: the vote is run, the outcome published, and the adapter refuses
// every other path.
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type Address, type KeyPairSigner, type ReadonlyUint8Array, getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';
import { getSetComputeUnitLimitInstruction } from '@solana-program/compute-budget';
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import { FLAG_GOVERNED_GRADUATION, OrderSide, SupplyMode, ata, readonly, withAccounts } from '@opening-cross/sdk';
import { buildOpenDlmmPair, buildSeedDammV2, buildSeedRaydiumCpmm } from '@opening-cross/adapters';
import {
  CROSS_GRADUATE_PROGRAM_ADDRESS,
  findCharterPda,
  findVotePda,
  getCastVoteInstruction,
  getCharterDecoder,
  getFinalizeRoundInstruction,
  getInitCharterInstruction,
  getOutcomeDecoder,
  getOutcomeEncoder,
  getPostVolumeInstruction,
  getPublishOutcomeInstruction,
  getRoundDecoder,
  getStartRoundInstruction,
  getWithdrawVoteInstruction,
} from '@opening-cross/cross-graduate-client';
import { RulesWorld } from '../src/rules-world.js';
import { DAMM_FIXTURE } from '../src/harness.js';

const TOKEN = 1_000_000n;
const DAY = 86_400n;
const cu = getSetComputeUnitLimitInstruction({ units: 1_400_000 });
const text = (s: string) => new TextEncoder().encode(s);
const pda = (seeds: ReadonlyUint8Array[]) => getProgramDerivedAddress({ programAddress: CROSS_GRADUATE_PROGRAM_ADDRESS, seeds }).then(([a]) => a);
const roundPda = (cross: Address, index: number) => pda([text('round'), getAddressEncoder().encode(cross), new Uint8Array([index])]);
const outcomePda = (cross: Address) => pda([text('outcome'), getAddressEncoder().encode(cross)]);

async function setup(charter: { quorumBps?: number; windowSecs?: bigint; minVolume?: bigint; attester?: Address | null } = {}) {
  const w = await RulesWorld.createRules();
  const cross = await w.newRuledCross({ supplyMode: SupplyMode.Escrow, rules: { flags: FLAG_GOVERNED_GRADUATION } });
  const [charterAddr] = await findCharterPda({ cross: cross.address });
  const attester = await w.h.wallet();
  const initCharter = () =>
    getInitCharterInstruction({
      creator: w.creator,
      cross: cross.address,
      charter: charterAddr,
      quorumBps: charter.quorumBps ?? 2_000,
      windowSecs: charter.windowSecs ?? 3n * DAY,
      minVolume: charter.minVolume ?? 0n,
      volumeAttester: charter.attester === undefined ? (charter.minVolume ? attester.address : null) : charter.attester,
    });
  await w.h.send([initCharter()], w.creator);
  // A market: 2,000 base tokens change hands at the clearing price. The seller keeps 3,000 and the buyer holds 2,000.
  const seller = await w.trader(0n, 5_000n * TOKEN);
  const buyer = await w.trader(20_000n * TOKEN);
  const orders = [await w.place(cross, seller, OrderSide.Sell, 1_200_000n, 2_000n * TOKEN), await w.place(cross, buyer, OrderSide.Buy, 1_300_000n, 2_000n * TOKEN)];
  const settled = await w.settle(cross);
  await w.claimAll(settled, orders);
  await w.finalize(w.view(cross.address));
  return { w, cross: w.view(cross.address), charterAddr, seller, buyer, attester, initCharter };
}
type S = Awaited<ReturnType<typeof setup>>;

const readCharter = (s: S) => getCharterDecoder().decode((s.w.h.svm.getAccount(s.charterAddr) as { data: Uint8Array }).data);
const readRound = async (s: S, index: number) => getRoundDecoder().decode((s.w.h.svm.getAccount(await roundPda(s.cross.address, index)) as { data: Uint8Array }).data);

async function startRound(s: S, index: number, who: KeyPairSigner = s.w.creator) {
  const round = await roundPda(s.cross.address, index);
  const ix = getStartRoundInstruction({ creator: who, cross: s.cross.address, charter: s.charterAddr, baseMint: s.w.baseMint, round, escrow: await ata(round, s.w.baseMint, TOKEN_2022_PROGRAM_ADDRESS), tokenProgram: TOKEN_2022_PROGRAM_ADDRESS });
  return { round, ix };
}
async function voteIx(s: S, round: Address, voter: KeyPairSigner, venue: number, amount: bigint) {
  const [vote] = await findVotePda({ round, voter: voter.address });
  return getCastVoteInstruction({ voter, round, baseMint: s.w.baseMint, voterToken: await ata(voter.address, s.w.baseMint, TOKEN_2022_PROGRAM_ADDRESS), escrow: await ata(round, s.w.baseMint, TOKEN_2022_PROGRAM_ADDRESS), vote, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS, venue, amount });
}
const finalizeIx = (s: S, round: Address) => getFinalizeRoundInstruction({ round, charter: s.charterAddr, baseMint: s.w.baseMint });
async function publishIx(s: S, round: Address, payer: KeyPairSigner) {
  return getPublishOutcomeInstruction({ payer, round, outcome: await outcomePda(s.cross.address) });
}
async function withdrawIx(s: S, round: Address, voter: KeyPairSigner) {
  const [vote] = await findVotePda({ round, voter: voter.address });
  return getWithdrawVoteInstruction({ voter, round, baseMint: s.w.baseMint, vote, escrow: await ata(round, s.w.baseMint, TOKEN_2022_PROGRAM_ADDRESS), voterToken: await ata(voter.address, s.w.baseMint, TOKEN_2022_PROGRAM_ADDRESS), tokenProgram: TOKEN_2022_PROGRAM_ADDRESS });
}

/** Runs a whole passing round for venue 0 (buyer 2,000 tokens against seller 500 for venue 1) and publishes the outcome. */
async function pass(s: S, index = 0) {
  const { round, ix } = await startRound(s, index);
  await s.w.h.send([ix], s.w.creator);
  await s.w.h.send([await voteIx(s, round, s.buyer, 0, 2_000n * TOKEN)], s.buyer);
  await s.w.h.send([await voteIx(s, round, s.seller, 1, 500n * TOKEN)], s.seller);
  s.w.h.setTime((await readRound(s, index)).closesTs);
  await s.w.h.send([finalizeIx(s, round)], s.w.admin);
  await s.w.h.send([await publishIx(s, round, s.w.admin)], s.w.admin);
  return round;
}

describe.skipIf(!existsSync(DAMM_FIXTURE))('governed graduation', () => {
  it('without a passed vote the creator cannot seed a pool, with one the pool opens at P*', async () => {
    const s = await setup();
    const { w, cross } = s;
    const seed = await buildSeedDammV2({ cross, creator: w.creator, baseAmount: 5n * TOKEN, quoteAmount: 6n * TOKEN, feeBps: 30 });
    // No outcome account at all, and an outcome account that does not exist yet.
    expect(await w.h.fail([cu, seed.instruction], w.creator)).toContain('GraduationNotApproved');
    const outcome = await outcomePda(cross.address);
    expect(await w.h.fail([cu, withAccounts(seed.instruction, [readonly(outcome)])], w.creator)).toContain('GraduationNotApproved');
    // The same cross, ungoverned by the flag's absence, is covered by damm.test.ts.
    const round = await pass(s);
    const o = getOutcomeDecoder().decode((w.h.svm.getAccount(outcome) as { data: Uint8Array }).data);
    expect(o).toMatchObject({ cross: cross.address, venue: 0, round: 0 });
    expect(readCharter(s)).toMatchObject({ passed: true, active: false, rounds: 1 });
    // The outcome in hand, the pool opens: the adapter still checks P*, the creator and the rest. (The creator's liquidity is minted
    // now, after the vote, so that it did not count towards the supply the quorum is measured against.)
    await w.h.fund(w.baseMint, w.admin, w.creator.address, 10_000n * TOKEN);
    await w.h.send([cu, withAccounts(seed.instruction, [readonly(outcome)])], w.creator);
    expect(w.h.exists(seed.addresses.pool)).toBe(true);
    // Voters get their tokens back after the window.
    const before = await w.h.balanceOf(s.buyer.address, w.baseMint);
    await w.h.send([await withdrawIx(s, round, s.buyer)], s.buyer);
    expect(await w.h.balanceOf(s.buyer.address, w.baseMint)).toBe(before + 2_000n * TOKEN);
  });

  it('an outcome for another venue, for another cross or forged is refused', async () => {
    const s = await setup();
    const { w, cross } = s;
    const seed = await buildSeedDammV2({ cross, creator: w.creator, baseAmount: 5n * TOKEN, quoteAmount: 6n * TOKEN, feeBps: 30 });
    // Venue 1 (DLMM) wins: the DAMM adapter refuses.
    const { round, ix } = await startRound(s, 0);
    await w.h.send([ix], w.creator);
    await w.h.send([await voteIx(s, round, s.buyer, 1, 2_000n * TOKEN)], s.buyer);
    w.h.setTime((await readRound(s, 0)).closesTs);
    await w.h.send([finalizeIx(s, round)], w.admin);
    await w.h.send([await publishIx(s, round, w.admin)], w.admin);
    const outcome = await outcomePda(cross.address);
    expect(await w.h.fail([cu, withAccounts(seed.instruction, [readonly(outcome)])], w.creator)).toContain('GraduationNotApproved');
    // Another account in the outcome's place, even one with the right bytes, is not the PDA.
    const copy = (await w.h.wallet()).address;
    const real = w.h.svm.getAccount(outcome);
    if (!real.exists) throw new Error('missing');
    w.h.svm.setAccount({ address: copy, data: real.data, executable: false, lamports: real.lamports, programAddress: real.programAddress, space: BigInt(real.data.length) });
    expect(await w.h.fail([cu, withAccounts(seed.instruction, [readonly(copy)])], w.creator)).toContain('GraduationNotApproved');

    // An account at the outcome's own address but owned by another program, with the right bytes, is not an outcome either.
    const fresh = await setup();
    await fresh.w.h.fund(fresh.w.baseMint, fresh.w.admin, fresh.w.creator.address, 10_000n * TOKEN);
    const freshSeed = await buildSeedDammV2({ cross: fresh.cross, creator: fresh.w.creator, baseAmount: 5n * TOKEN, quoteAmount: 6n * TOKEN, feeBps: 30 });
    const freshOutcome = await outcomePda(fresh.cross.address);
    // A well-formed outcome for this cross and this venue, at the right address, owned by the wrong program.
    const bytes = new Uint8Array(getOutcomeEncoder().encode({ cross: fresh.cross.address, venue: 0, round: 0, publishedTs: 0n, bump: 255 }));
    fresh.w.h.svm.setAccount({ address: freshOutcome, data: bytes, executable: false, lamports: real.lamports, programAddress: TOKEN_2022_PROGRAM_ADDRESS, space: BigInt(bytes.length) });
    expect(await fresh.w.h.fail([cu, withAccounts(freshSeed.instruction, [readonly(freshOutcome)])], fresh.w.creator)).toContain('GraduationNotApproved');
    // The same bytes owned by cross_graduate are accepted (the ownership is the whole difference), so the pool opens.
    fresh.w.h.svm.setAccount({ address: freshOutcome, data: bytes, executable: false, lamports: real.lamports, programAddress: CROSS_GRADUATE_PROGRAM_ADDRESS, space: BigInt(bytes.length) });
    await fresh.w.h.send([cu, withAccounts(freshSeed.instruction, [readonly(freshOutcome)])], fresh.w.creator);

    // The same outcome names DLMM: the Raydium adapter refuses it, the DLMM adapter without it refuses too, and with it gets past the gate.
    const dlmm = await buildOpenDlmmPair({ cross, creator: w.creator, binStep: 25, baseFactor: 10_000 });
    const ray = await buildSeedRaydiumCpmm({ cross, creator: w.creator, baseAmount: 5n * TOKEN });
    const logsOf = async (ix: Parameters<typeof withAccounts>[0]) => {
      try {
        await w.h.send([cu, ix], w.creator);
        return 'OK';
      } catch (e) {
        return (e as { logs?: string[] }).logs?.join('\n') ?? String(e);
      }
    };
    expect(await logsOf(withAccounts(ray.instruction, [readonly(outcome)]))).toContain('GraduationNotApproved');
    expect(await logsOf(dlmm.instruction)).toContain('GraduationNotApproved');
    expect(await logsOf(withAccounts(dlmm.instruction, [readonly(outcome)]))).not.toContain('GraduationNotApproved');
  });
});

describe('the vote', () => {
  it('a charter needs sane terms, the creator, a governed cross and no orders yet', async () => {
    const w = await RulesWorld.createRules();
    const governed = await w.newRuledCross({ supplyMode: SupplyMode.Escrow, rules: { flags: FLAG_GOVERNED_GRADUATION } });
    const plain = await w.newRuledCross({ supplyMode: SupplyMode.Escrow });
    const make = async (cross: Address, over: { quorumBps?: number; windowSecs?: bigint; minVolume?: bigint; attester?: Address | null; creator?: KeyPairSigner } = {}) => {
      const [charter] = await findCharterPda({ cross });
      return getInitCharterInstruction({ creator: over.creator ?? w.creator, cross, charter, quorumBps: over.quorumBps ?? 2_000, windowSecs: over.windowSecs ?? 3n * DAY, minVolume: over.minVolume ?? 0n, volumeAttester: over.attester ?? null });
    };
    expect(await w.h.fail([await make(governed.address, { quorumBps: 999 })], w.creator)).toContain('BadCharter');
    expect(await w.h.fail([await make(governed.address, { quorumBps: 10_001 })], w.creator)).toContain('BadCharter');
    expect(await w.h.fail([await make(governed.address, { windowSecs: 3n * DAY - 1n })], w.creator)).toContain('BadCharter');
    expect(await w.h.fail([await make(governed.address, { windowSecs: 30n * DAY + 1n })], w.creator)).toContain('BadCharter');
    expect(await w.h.fail([await make(governed.address, { minVolume: 5n })], w.creator)).toContain('BadCharter'); // a volume gate needs an attester
    const stranger = await w.h.wallet();
    expect(await w.h.fail([await make(governed.address, { creator: stranger })], stranger)).toContain('NotTheCreator');
    expect(await w.h.fail([await make(plain.address)], w.creator)).toContain('NotGoverned');
    await w.h.send([await make(governed.address)], w.creator);
    // After the first order it is too late.
    const late = await w.newRuledCross({ supplyMode: SupplyMode.Escrow, rules: { flags: FLAG_GOVERNED_GRADUATION } });
    const buyer = await w.trader(10n * TOKEN);
    await w.place(late, buyer, OrderSide.Buy, 1_000_000n, TOKEN);
    expect(await w.h.fail([await make(late.address)], w.creator)).toContain('TooLate');
  });

  it('a round starts only for the creator, after the cross is finalized, and one at a time', async () => {
    const w = await RulesWorld.createRules();
    const cross = await w.newRuledCross({ supplyMode: SupplyMode.Escrow, rules: { flags: FLAG_GOVERNED_GRADUATION } });
    const [charterAddr] = await findCharterPda({ cross: cross.address });
    await w.h.send([getInitCharterInstruction({ creator: w.creator, cross: cross.address, charter: charterAddr, quorumBps: 2_000, windowSecs: 3n * DAY, minVolume: 0n, volumeAttester: null })], w.creator);
    const early = { w, cross, charterAddr } as unknown as S;
    expect(await w.h.fail([(await startRound(early, 0)).ix], w.creator)).toContain('CrossNotFinalized');

    const s = await setup();
    const stranger = await s.w.h.wallet();
    expect(await s.w.h.fail([(await startRound(s, 0, stranger)).ix], stranger)).toBeTruthy();
    const { ix } = await startRound(s, 0);
    await s.w.h.send([ix], s.w.creator);
    expect(await s.w.h.fail([(await startRound(s, 1)).ix], s.w.creator)).toContain('RoundOpen');
  });

  it('weights a vote by what stays locked: the tokens cannot move until the window ends, nor change venue', async () => {
    const s = await setup();
    const { w } = s;
    const { round, ix } = await startRound(s, 0);
    await w.h.send([ix], w.creator);
    const before = await w.h.balanceOf(s.buyer.address, w.baseMint);
    await w.h.send([await voteIx(s, round, s.buyer, 0, 1_000n * TOKEN)], s.buyer);
    await w.h.send([await voteIx(s, round, s.buyer, 0, 500n * TOKEN)], s.buyer); // adding to the stake
    expect(await w.h.balanceOf(s.buyer.address, w.baseMint)).toBe(before - 1_500n * TOKEN);
    expect(await w.h.balanceOf(round, w.baseMint)).toBe(1_500n * TOKEN);
    expect(await w.h.fail([await voteIx(s, round, s.buyer, 1, 1n)], s.buyer)).toContain('VenueLocked');
    expect(await w.h.fail([await voteIx(s, round, s.buyer, 4, 1n)], s.buyer)).toContain('UnknownVenue');
    expect(await w.h.fail([await voteIx(s, round, s.buyer, 0, 0n)], s.buyer)).toContain('NothingToDo');
    expect(await w.h.fail([await withdrawIx(s, round, s.buyer)], s.buyer)).toContain('WindowOpen');
    expect(await w.h.fail([await voteIx(s, round, s.buyer, 0, 10_000n * TOKEN)], s.buyer)).toBeTruthy(); // more than held
    expect(await w.h.fail([finalizeIx(s, round)], w.admin)).toContain('WindowOpen');
    const r = await readRound(s, 0);
    expect(r).toMatchObject({ lockedTotal: 1_500n * TOKEN, tallies: [1_500n * TOKEN, 0n, 0n, 0n] });
    // After the window no vote is accepted and everyone can withdraw; another voter cannot take someone else's stake.
    w.h.setTime(r.closesTs);
    expect(await w.h.fail([await voteIx(s, round, s.seller, 0, TOKEN)], s.seller)).toContain('NotVoting');
    expect(await w.h.fail([await withdrawIx(s, round, s.seller)], s.seller)).toBeTruthy();
    await w.h.send([await withdrawIx(s, round, s.buyer)], s.buyer);
    expect(await w.h.balanceOf(s.buyer.address, w.baseMint)).toBe(before);
  });

  it('fails without a quorum, without a strict majority, and a failed round can be followed by another, three at most', async () => {
    const s = await setup();
    const { w } = s;
    // Round 0: 100 of 5,000 locked is 2%, under the 20% quorum.
    const r0 = await startRound(s, 0);
    await w.h.send([r0.ix], w.creator);
    await w.h.send([await voteIx(s, r0.round, s.buyer, 0, 100n * TOKEN)], s.buyer);
    w.h.setTime((await readRound(s, 0)).closesTs);
    await w.h.send([finalizeIx(s, r0.round)], w.admin);
    await w.h.send([await withdrawIx(s, r0.round, s.buyer)], s.buyer);
    expect(await readRound(s, 0)).toMatchObject({ finalized: true, passed: false });
    expect(await w.h.fail([await publishIx(s, r0.round, w.admin)], w.admin)).toContain('NotPassed');
    expect(readCharter(s)).toMatchObject({ passed: false, active: false, rounds: 1 });
    // Round 1: 50/50 over quorum is a tie, and a tie has no winner.
    const r1 = await startRound(s, 1);
    await w.h.send([r1.ix], w.creator);
    await w.h.send([await voteIx(s, r1.round, s.buyer, 0, 1_000n * TOKEN)], s.buyer);
    await w.h.send([await voteIx(s, r1.round, s.seller, 1, 1_000n * TOKEN)], s.seller);
    w.h.setTime((await readRound(s, 1)).closesTs);
    await w.h.send([finalizeIx(s, r1.round)], w.admin);
    await w.h.send([await withdrawIx(s, r1.round, s.buyer)], s.buyer);
    await w.h.send([await withdrawIx(s, r1.round, s.seller)], s.seller);
    expect(await readRound(s, 1)).toMatchObject({ passed: false });
    // Round 2 is the last: an atom under half fails, an atom over passes (checked in the unit tests); here 1,000 against 1,001.
    const r2 = await startRound(s, 2);
    await w.h.send([r2.ix], w.creator);
    await w.h.send([await voteIx(s, r2.round, s.buyer, 0, 1_000n * TOKEN)], s.buyer);
    await w.h.send([await voteIx(s, r2.round, s.seller, 1, 1_000n * TOKEN + 1n)], s.seller);
    w.h.setTime((await readRound(s, 2)).closesTs);
    await w.h.send([finalizeIx(s, r2.round)], w.admin);
    expect(await readRound(s, 2)).toMatchObject({ passed: true, winner: 1 });
    // A passed charter takes no more rounds.
    expect(await w.h.fail([(await startRound(s, 3)).ix], w.creator)).toBeTruthy();
  });

  it('uses all three rounds up and then no more', async () => {
    const s = await setup();
    const { w } = s;
    for (let i = 0; i < 3; i++) {
      const r = await startRound(s, i);
      await w.h.send([r.ix], w.creator);
      w.h.setTime((await readRound(s, i)).closesTs);
      await w.h.send([finalizeIx(s, r.round)], w.admin);
      expect(await readRound(s, i)).toMatchObject({ passed: false });
    }
    expect(await w.h.fail([(await startRound(s, 3)).ix], w.creator)).toBeTruthy();
    expect(readCharter(s)).toMatchObject({ rounds: 3, passed: false });
  });

  it('asks the volume attester when the charter does: no figure or too little fails, enough passes', async () => {
    const s = await setup({ minVolume: 500n * TOKEN });
    const { w } = s;
    const stranger = await w.h.wallet();
    const run = async (index: number, volume: bigint | null, who: KeyPairSigner = s.attester) => {
      const r = await startRound(s, index);
      await w.h.send([r.ix], w.creator);
      await w.h.send([await voteIx(s, r.round, s.buyer, 0, 2_000n * TOKEN)], s.buyer);
      if (volume !== null) {
        const post = getPostVolumeInstruction({ attester: who, round: r.round, volumeQuote: volume });
        if (who === stranger) expect(await w.h.fail([post], who)).toContain('Unauthorized');
        else await w.h.send([post], who);
      }
      w.h.setTime((await readRound(s, index)).closesTs);
      await w.h.send([finalizeIx(s, r.round)], w.admin);
      await w.h.send([await withdrawIx(s, r.round, s.buyer)], s.buyer);
      return (await readRound(s, index)).passed;
    };
    expect(await run(0, null)).toBe(false);
    expect(await run(1, 499n * TOKEN)).toBe(false);
    expect(await run(2, 500n * TOKEN)).toBe(true);
    // A stranger's figure is refused (checked on a round that is still open).
    const t = await setup({ minVolume: 500n * TOKEN });
    const open = await startRound(t, 0);
    await t.w.h.send([open.ix], t.w.creator);
    const stranger2 = await t.w.h.wallet();
    expect(await t.w.h.fail([getPostVolumeInstruction({ attester: stranger2, round: open.round, volumeQuote: 10_000n * TOKEN })], stranger2)).toContain('Unauthorized');
  });
});
