// The treasury builders of @opening-cross/treasury-client against the construction the LiteSVM suites run.
//
// `tests/core/src/treasury-world.ts` builds every instruction by hand from the generated client (45 tests run them against the real program binary). That
// construction is transcribed below as `reference`; each builder must produce the same instruction (program, accounts with roles, data), with the one
// addition the builders make for a wallet that may not yet hold a token account: an idempotent create of the associated account, ahead of the instruction.
// The program itself is NOT run here: LiteSVM needs Linux.
import { describe, expect, it } from 'vitest';
import { type Address, type Instruction, createNoopSigner, getAddressDecoder } from '@solana/kit';
import { TOKEN_2022_PROGRAM_ADDRESS, findAssociatedTokenPda } from '@solana-program/token-2022';
import {
  ProposalKind,
  type TreasuryContext,
  associatedTokenAddress,
  buildClaimDistribution,
  buildCreateGrant,
  buildDepositDistribution,
  buildExecuteProposal,
  buildExpireGrant,
  buildInitExt,
  buildMarkMissed,
  buildNavRedeem,
  buildPayRound,
  buildPostDisclosure,
  buildPropose,
  buildReclaimVote,
  buildRecordAssignment,
  buildRecordAttested,
  buildRecordLapse,
  buildRedeem,
  buildReleaseMilestone,
  buildReleaseTranche,
  buildRequestDisclosure,
  buildSpend,
  buildStake,
  buildSweepUnclaimed,
  buildTriggerLiquidation,
  buildUnstake,
  buildVote,
  checkExtParams,
  decodeTreasuryExt,
  findGrantPda,
  findProposalPda,
  findVaultPda,
  findVoteRecordPda,
  flagshipExtParams,
  getClaimDistributionInstructionAsync,
  getCreateGrantInstructionAsync,
  getDepositDistributionInstructionAsync,
  getExecuteProposalInstructionAsync,
  getExpireGrantInstructionAsync,
  getInitExtInstructionAsync,
  getMarkMissedInstructionAsync,
  getNavRedeemInstructionAsync,
  getPayRoundInstructionAsync,
  getPostDisclosureInstruction,
  getProposeInstructionAsync,
  getReclaimVoteInstructionAsync,
  getRecordAssignmentInstruction,
  getRecordAttestedInstruction,
  getRecordLapseInstruction,
  getRedeemInstruction,
  getReleaseMilestoneInstructionAsync,
  getReleaseTrancheInstructionAsync,
  getRequestDisclosureInstruction,
  getSpendInstruction,
  getStakeInstructionAsync,
  getSweepUnclaimedInstructionAsync,
  getTreasuryExtEncoder,
  getTriggerLiquidationInstruction,
  getUnstakeInstructionAsync,
  getVoteInstructionAsync,
  TREASURY_EXT_MAGIC,
  TREASURY_EXT_OFFSET,
  claimableOf,
  accumulatorAt,
  navPayout,
  proposalPasses,
  proposalCap,
  streamRelease,
} from '@opening-cross/treasury-client';

const addr = (n: number) => getAddressDecoder().decode(new Uint8Array(32).fill(n + 120)) as Address;
const [TREASURY, COIN, QUOTE, TEAM, ALICE, BOB, DEST, ATTEST, CRED, SCHEMA, RECOVERY, GRANT_BENEFICIARY] = Array.from({ length: 12 }, (_, i) => addr(i)) as [Address, Address, Address, Address, Address, Address, Address, Address, Address, Address, Address, Address];
const TP = TOKEN_2022_PROGRAM_ADDRESS;
const ctx: TreasuryContext = { treasury: TREASURY, coinMint: COIN, quoteMint: QUOTE, coinTokenProgram: TP, quoteTokenProgram: TP };
const signer = (a: Address) => createNoopSigner(a);
const plain = (ix: Instruction) => ({ program: ix.programAddress, accounts: (ix.accounts ?? []).map((a) => `${a.address}:${a.role}`), data: Buffer.from(ix.data ?? new Uint8Array()).toString('hex') });
const same = (a: Instruction, b: Instruction) => expect(plain(a)).toEqual(plain(b));
const ata = async (owner: Address, mint: Address) => (await findAssociatedTokenPda({ owner, mint, tokenProgram: TP }))[0];
const coinOf = (w: Address) => ata(w, COIN);
const quoteOf = (w: Address) => ata(w, QUOTE);
/** The builders create the wallet's token account (idempotent) ahead of an instruction that pays it. */
const ensured = async (ixs: Instruction[], owner: Address, mint: Address) => {
  expect(ixs).toHaveLength(2);
  expect(ixs[0]!.programAddress).toBe('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
  expect(ixs[0]!.data).toEqual(new Uint8Array([1]));
  expect(ixs[0]!.accounts!.map((a) => a.address)).toEqual([expect.any(String), await ata(owner, mint), owner, mint, '11111111111111111111111111111111', TP]);
  return ixs[1]!;
};
const hash = new Uint8Array(32).fill(5);

describe('the treasury builders produce the instructions the LiteSVM suites run', () => {
  it('derives associated token accounts exactly as the token program does', async () => {
    for (const w of [TEAM, ALICE, BOB]) expect(await associatedTokenAddress(w, COIN, TP)).toBe(await ata(w, COIN));
  });

  it('init_ext', async () => {
    const params = {
      votePeriodSecs: 259_200n, timelockSecs: 86_400n, quorumBps: 2_000, thresholdBps: 5_000, maxProposalBps: 5_000, proposerMinBps: 100, minLockupSecs: 7_776_000n, navPeriodSecs: 604_800n, navCapBps: 1_000,
      insiders: [TEAM, addr(30), addr(31), addr(32)], streamSecs: 0n, revShareBps: 1_000, revCredential: CRED, revSchema: SCHEMA, roundSecs: 604_800n, revStart: 1_900_000_000n, payGraceSecs: 259_200n, trancheMinRevenue: 1n, trancheAmount: 1n,
      disclosurePeriodSecs: 1_209_600n, requestMinBps: 100, assignRequired: false, assignCredential: CRED, assignSchema: SCHEMA, windowSecs: 15_552_000n, recovery: RECOVERY,
    };
    same(await buildInitExt(ctx, signer(TEAM), params), await getInitExtInstructionAsync({ authority: signer(TEAM), treasury: TREASURY, coinMint: COIN, quoteMint: QUOTE, coinTokenProgram: TP, quoteTokenProgram: TP, ...params }));
  });

  it('holder votes', async () => {
    same(await buildPropose(ctx, signer(ALICE), { id: 3n, kind: ProposalKind.Spend, amount: 7n, destination: DEST, descHash: hash }), await getProposeInstructionAsync({ proposer: signer(ALICE), treasury: TREASURY, coinMint: COIN, proposerCoin: await coinOf(ALICE), id: 3n, kind: ProposalKind.Spend, amount: 7n, destination: DEST, descHash: hash }));
    const [proposal] = await findProposalPda({ treasury: TREASURY, id: 3n });
    same(await buildVote(ctx, signer(BOB), 3n, true, 9n), await getVoteInstructionAsync({ voter: signer(BOB), treasury: TREASURY, proposal, coinMint: COIN, voterCoin: await coinOf(BOB), coinTokenProgram: TP, support: true, amount: 9n }));
    const [voteRecord] = await findVoteRecordPda({ proposal, voter: BOB });
    same(await buildReclaimVote(ctx, signer(BOB), 3n), await getReclaimVoteInstructionAsync({ voter: signer(BOB), treasury: TREASURY, proposal, voteRecord, coinMint: COIN, voterCoin: await coinOf(BOB), coinTokenProgram: TP }));
    same(await buildExecuteProposal(ctx, signer(BOB), 3n, DEST), await getExecuteProposalInstructionAsync({ executor: signer(BOB), treasury: TREASURY, proposal, coinMint: COIN, quoteMint: QUOTE, destination: DEST, quoteTokenProgram: TP }));
    same(await ensured(await buildNavRedeem(ctx, signer(ALICE), 11n), ALICE, QUOTE), await getNavRedeemInstructionAsync({ holder: signer(ALICE), treasury: TREASURY, coinMint: COIN, quoteMint: QUOTE, holderCoin: await coinOf(ALICE), holderQuote: await quoteOf(ALICE), coinTokenProgram: TP, quoteTokenProgram: TP, amount: 11n }));
  });

  it('distributions and revenue rounds', async () => {
    same(await buildStake(ctx, signer(ALICE), 5n), await getStakeInstructionAsync({ owner: signer(ALICE), treasury: TREASURY, coinMint: COIN, ownerCoin: await coinOf(ALICE), coinTokenProgram: TP, amount: 5n }));
    same(await buildUnstake(ctx, signer(ALICE), 5n), await getUnstakeInstructionAsync({ owner: signer(ALICE), treasury: TREASURY, coinMint: COIN, ownerCoin: await coinOf(ALICE), coinTokenProgram: TP, amount: 5n }));
    same(await buildDepositDistribution(ctx, signer(BOB), 6n), await getDepositDistributionInstructionAsync({ depositor: signer(BOB), treasury: TREASURY, quoteMint: QUOTE, depositorQuote: await quoteOf(BOB), quoteTokenProgram: TP, amount: 6n }));
    same(await ensured(await buildClaimDistribution(ctx, signer(ALICE)), ALICE, QUOTE), await getClaimDistributionInstructionAsync({ owner: signer(ALICE), treasury: TREASURY, quoteMint: QUOTE, ownerQuote: await quoteOf(ALICE), quoteTokenProgram: TP }));
    same(await buildPayRound(ctx, signer(BOB), 2n, ATTEST), await getPayRoundInstructionAsync({ payer: signer(BOB), treasury: TREASURY, quoteMint: QUOTE, payerQuote: await quoteOf(BOB), attestation: ATTEST, quoteTokenProgram: TP, round: 2n }));
    same(await buildMarkMissed(ctx, signer(BOB), 2n), await getMarkMissedInstructionAsync({ caller: signer(BOB), treasury: TREASURY, coinMint: COIN, round: 2n }));
    same(await buildReleaseTranche(ctx, signer(TEAM), 2n, DEST), await getReleaseTrancheInstructionAsync({ authority: signer(TEAM), treasury: TREASURY, quoteMint: QUOTE, vault: (await findVaultPda({ treasury: TREASURY }))[0], destination: DEST, quoteTokenProgram: TP, round: 2n }));
  });

  it('team grants', async () => {
    const milestones = [{ bps: 2_500, requiresAttestation: false }, { bps: 5_000, requiresAttestation: true }];
    const padded = [...milestones.map((m) => ({ ...m, released: false })), { bps: 0, requiresAttestation: false, released: false }, { bps: 0, requiresAttestation: false, released: false }];
    same(
      await buildCreateGrant(ctx, signer(TEAM), { id: 0n, beneficiary: GRANT_BENEFICIARY, total: 100n, lockupEnd: 1_900_000_000n, expiryTs: 2_000_000_000n, milestones, credential: CRED, schema: SCHEMA }),
      await getCreateGrantInstructionAsync({ authority: signer(TEAM), treasury: TREASURY, coinMint: COIN, authorityCoin: await coinOf(TEAM), coinTokenProgram: TP, id: 0n, beneficiary: GRANT_BENEFICIARY, total: 100n, lockupEnd: 1_900_000_000n, expiryTs: 2_000_000_000n, milestones: padded, milestoneCount: 2, credential: CRED, schema: SCHEMA } as never),
    );
    const [grant] = await findGrantPda({ treasury: TREASURY, id: 0n });
    same(await ensured(await buildReleaseMilestone(ctx, signer(BOB), 0n, 1, GRANT_BENEFICIARY, ATTEST), GRANT_BENEFICIARY, COIN), await getReleaseMilestoneInstructionAsync({ cranker: signer(BOB), treasury: TREASURY, grant, coinMint: COIN, beneficiaryCoin: await coinOf(GRANT_BENEFICIARY), attestation: ATTEST, coinTokenProgram: TP, index: 1 }));
    same(await buildExpireGrant(ctx, signer(BOB), 0n), await getExpireGrantInstructionAsync({ cranker: signer(BOB), treasury: TREASURY, grant, coinMint: COIN, coinTokenProgram: TP }));
    await expect(buildCreateGrant(ctx, signer(TEAM), { id: 0n, beneficiary: BOB, total: 1n, lockupEnd: 1n, expiryTs: 2n, milestones: [], credential: CRED, schema: SCHEMA })).rejects.toThrow(/one to four milestones/);
  });

  it('disclosure, assignment, wind-down and the first release\'s instructions', async () => {
    same(buildPostDisclosure(ctx, signer(TEAM), hash), getPostDisclosureInstruction({ authority: signer(TEAM), treasury: TREASURY, hash }));
    same(await buildRequestDisclosure(ctx, signer(ALICE)), getRequestDisclosureInstruction({ holder: signer(ALICE), treasury: TREASURY, coinMint: COIN, holderCoin: await coinOf(ALICE) }));
    same(buildRecordAssignment(ctx, ATTEST), getRecordAssignmentInstruction({ treasury: TREASURY, attestation: ATTEST }));
    same(await buildSweepUnclaimed(ctx, DEST), await getSweepUnclaimedInstructionAsync({ treasury: TREASURY, quoteMint: QUOTE, recoveryQuote: DEST, quoteTokenProgram: TP }));
    const [vault] = await findVaultPda({ treasury: TREASURY });
    same(await buildSpend(ctx, signer(TEAM), 12n, ATTEST, DEST), getSpendInstruction({ authority: signer(TEAM), treasury: TREASURY, attestation: ATTEST, quoteMint: QUOTE, vault, destination: DEST, quoteTokenProgram: TP, amount: 12n }));
    same(buildRecordAttested(ctx, ATTEST), getRecordAttestedInstruction({ treasury: TREASURY, attestation: ATTEST }));
    same(buildRecordLapse(ctx, ATTEST), getRecordLapseInstruction({ treasury: TREASURY, attestation: ATTEST }));
    same(await buildTriggerLiquidation(ctx), getTriggerLiquidationInstruction({ treasury: TREASURY, coinMint: COIN, vault }));
    same(await ensured(await buildRedeem(ctx, signer(ALICE), 4n), ALICE, QUOTE), getRedeemInstruction({ holder: signer(ALICE), treasury: TREASURY, coinMint: COIN, quoteMint: QUOTE, holderCoin: await coinOf(ALICE), holderQuote: await quoteOf(ALICE), vault, coinTokenProgram: TP, quoteTokenProgram: TP, amount: 4n }));
  });
});

describe('the extension tail and the arithmetic', () => {
  const tail = (over: object = {}) => ({
    magic: TREASURY_EXT_MAGIC, coinVaultBump: 1, distVaultBump: 2, votePeriodSecs: 3n, timelockSecs: 4n, quorumBps: 2_000, thresholdBps: 5_000, maxProposalBps: 5_000, proposerMinBps: 100, proposalCount: 6n, votesLocked: 7n, totalStaked: 1_000n,
    grantsUnreleased: 8n, grantCount: 9n, minLockupSecs: 10n, navOpen: true, navPeriodSecs: 11n, navCapBps: 1_000, navPeriodStart: 12n, navPeriodSupply: 13n, navBurned: 14n, insiders: [TEAM, ALICE, BOB, DEST], accPerStake: 15n * 10n ** 9n,
    streamSecs: 16n, streamAmount: 600n, streamEnd: 100n, streamLast: 0n, revShareBps: 17, revCredential: CRED, revSchema: SCHEMA, roundSecs: 18n, revStart: 19n, payGraceSecs: 20n, missedRounds: 21, trancheMinRevenue: 22n, trancheAmount: 23n,
    disclosurePeriodSecs: 24n, lastDisclosureTs: 25n, lastDisclosureHash: hash, disclosures: 26, openRequestTs: 27n, requestMinBps: 28, assignRequired: true, assigned: false, assignCredential: CRED, assignSchema: SCHEMA, windowSecs: 29n, recovery: RECOVERY,
    windStart: 30n, swept: false, ...over,
  });

  it('encodes and decodes the tail it reads at the offset the program writes it', () => {
    const t = tail();
    const data = new Uint8Array(TREASURY_EXT_OFFSET + getTreasuryExtEncoder().encode(t).length);
    data.set(getTreasuryExtEncoder().encode(t), TREASURY_EXT_OFFSET);
    expect(decodeTreasuryExt(data)).toEqual(t);
    expect(decodeTreasuryExt(new Uint8Array(TREASURY_EXT_OFFSET))).toBeNull();
    expect(decodeTreasuryExt(data.slice(0, TREASURY_EXT_OFFSET + 2))).toBeNull();
  });

  it('claimable follows the accumulator and a stream that has not finished: the figures of the Rust unit tests', () => {
    // programs/treasury/src/math.rs: stream_releases_pro_rata_in_time
    expect([streamRelease(1_000n, 0n, 100n, 0n), streamRelease(1_000n, 0n, 100n, 25n), streamRelease(1_000n, 25n, 100n, 50n), streamRelease(1_000n, 0n, 100n, 100n), streamRelease(1_000n, 0n, 100n, 5_000n)]).toEqual([0n, 250n, 333n, 1_000n, 1_000n]);
    const e = { accPerStake: 0n, totalStaked: 1_000n, streamAmount: 600n, streamLast: 0n, streamEnd: 100n };
    // half the stream (300) shared over 1,000 staked coins: 0.3 per coin; a staker of 100 has earned 30, of which 10 were settled earlier
    expect(accumulatorAt(e, 50n)).toBe(300_000_000n);
    expect(claimableOf({ amount: 100n, debt: 0n, pending: 10n }, e, 50n)).toBe(40n);
    expect(claimableOf({ amount: 100n, debt: 30n, pending: 0n }, e, 50n)).toBe(0n);
    // nobody staked: nothing is released
    expect(accumulatorAt({ ...e, totalStaked: 0n }, 50n)).toBe(0n);
  });

  it('NAV never dilutes and a vote passes only with a quorum and a strict majority', () => {
    expect(navPayout(10_000n, 100n, 1_000n)).toBe(1_000n);
    expect(navPayout(10_000n, 1n, 3n)).toBe(3_333n);
    expect(navPayout(10_000n, 5n, 4n)).toBeNull();
    for (const [vault, amount, supply] of [[10_001n, 7n, 13n], [999n, 3n, 10n], [1n, 1n, 2n]] as const) {
      const paid = navPayout(vault, amount, supply)!;
      // vault_after * supply_before >= vault_before * supply_after
      expect((vault - paid) * supply >= vault * (supply - amount)).toBe(true);
    }
    expect(proposalPasses(400n, 100n, 1_000n, 2_000, 5_000)).toBe(true);
    expect(proposalPasses(200n, 200n, 1_000n, 2_000, 5_000)).toBe(false); // a tie
    expect(proposalPasses(100n, 0n, 1_000n, 2_000, 5_000)).toBe(false); // no quorum
    expect(proposalCap(10_000n, 5_000)).toBe(5_000n);
  });

  it('checks the terms the program checks, and calls its own advice advice', () => {
    const flagship = flagshipExtParams({ revenueCredential: CRED, revenueSchema: SCHEMA, assignmentCredential: CRED, assignmentSchema: SCHEMA, revenueShareBps: 1_000, revenueStart: 2_000n, recovery: RECOVERY });
    expect(checkExtParams(flagship, 1_000n)).toEqual([]);
    expect(checkExtParams(flagship, 3_000n).map((i) => i.code)).toEqual(['REV_START_PAST']);
    const weak = { ...flagship, votePeriodSecs: 3_600n, quorumBps: 500, windowSecs: 100n, recovery: addr(99) };
    expect(checkExtParams({ ...weak, recovery: '11111111111111111111111111111111' as Address }, 1_000n).map((i) => i.code)).toEqual(expect.arrayContaining(['VOTE_PERIOD', 'QUORUM', 'WINDOW', 'RECOVERY']));
    const orphan = checkExtParams({ ...flagship, assignCredential: '11111111111111111111111111111111' as Address }, 1_000n);
    expect(orphan).toEqual([expect.objectContaining({ code: 'ASSIGNMENT', severity: 'advice' })]);
  });
});
