// A treasury world for the extension tests (ADR-0470 to 0474): an ownership coin with four holders and
// a team, a funded treasury, a SAS credential and schema for attestations, and one builder per
// instruction so tests read as the sequence of actions they check.
import { fileURLToPath } from 'node:url';
import { type Address, type Instruction, type KeyPairSigner, address, getProgramDerivedAddress } from '@solana/kit';
import { TOKEN_2022_PROGRAM_ADDRESS, getMintToInstruction } from '@solana-program/token-2022';
import { deriveAttestationPda, deriveCredentialPda, deriveSchemaPda, getCloseAttestationInstruction, getCreateAttestationInstruction, getCreateCredentialInstruction, getCreateSchemaInstruction } from 'sas-lib';
import {
  ProposalKind,
  TREASURY_PROGRAM_ADDRESS,
  findCoinVaultPda,
  findDistVaultPda,
  findGrantPda,
  findPositionPda,
  findProposalPda,
  findRoundRecordPda,
  findTreasuryPda,
  findVaultPda,
  findVoteRecordPda,
  getClaimDistributionInstructionAsync,
  getCreateGrantInstructionAsync,
  getCreateTreasuryInstruction,
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
  getReleaseMilestoneInstructionAsync,
  getReleaseTrancheInstructionAsync,
  getRequestDisclosureInstruction,
  getSpendInstruction,
  getStakeInstructionAsync,
  getSweepUnclaimedInstructionAsync,
  getTreasuryDecoder,
  getUnstakeInstructionAsync,
  getVoteInstructionAsync,
  getGrantDecoder,
  getPositionDecoder,
  getProposalDecoder,
  getRoundRecordDecoder,
  getTriggerLiquidationInstruction,
  getRecordLapseInstruction,
  getRedeemInstruction,
  decodeTreasuryExt,
  encodeRevenueAttestation,
  getGrantMilestoneNonce,
  getRevenueRoundNonce,
} from '@opening-cross/treasury-client';
import { Harness, T0 } from './harness.js';

export const SAS = address('22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG');
export const SAS_SO = fileURLToPath(new URL('../../fixtures/solana_attestation_service.so', import.meta.url));
export const TREASURY_SO = fileURLToPath(new URL('../../../target/deploy/treasury.so', import.meta.url));
/** The treasury binary deployed on devnet before the extension (sha256 ce6b2b61…, 274,184 bytes). */
export const TREASURY_V1_SO = fileURLToPath(new URL('../../fixtures/treasury_v1_devnet.so', import.meta.url));
export const DAY = 86_400n;
export const ZERO: Address = address('11111111111111111111111111111111');
export const TP = TOKEN_2022_PROGRAM_ADDRESS;
const ix = (x: unknown) => x as Instruction; // sas-lib targets kit 5; instructions are plain data

export type Wallet = KeyPairSigner;

export type ExtOverrides = Partial<{
  votePeriodSecs: bigint; timelockSecs: bigint; quorumBps: number; thresholdBps: number; maxProposalBps: number; proposerMinBps: number;
  minLockupSecs: bigint; navPeriodSecs: bigint; navCapBps: number; insiders: Address[]; revShareBps: number; roundSecs: bigint; revStart: bigint;
  payGraceSecs: bigint; streamSecs: bigint; trancheMinRevenue: bigint; trancheAmount: bigint; disclosurePeriodSecs: bigint; requestMinBps: number; assignRequired: boolean;
  windowSecs: bigint; recovery: Address;
}>;

export const roundNonce = getRevenueRoundNonce;
export const milestoneNonce = getGrantMilestoneNonce;
const le = (n: bigint, bytes: number) => encodeRevenueAttestation(n).slice(0, bytes);

async function build(opts: { extend?: boolean; baseline?: boolean; ext?: ExtOverrides; vault?: bigint; insiders?: ('alice' | 'bob' | 'carol')[]; revenueSchemaIsOneByte?: boolean } = {}) {
  const h = new Harness();
  if (opts.baseline) h.svm.addProgramFromFile(TREASURY_PROGRAM_ADDRESS, TREASURY_V1_SO);
  h.svm.addProgramFromFile(SAS, SAS_SO);
  const admin = await h.wallet();
  const team = await h.wallet(50n);
  const [alice, bob, carol, dave] = [await h.wallet(), await h.wallet(), await h.wallet(), await h.wallet()];
  const attester = await h.wallet();
  const company = await h.wallet(50n);
  const recovery = await h.wallet();

  const quote = await h.mint(admin, 6);
  const coin = await h.mint(admin, 6);
  // 1,000 coins: team 200, alice 400, bob 300, carol 100; the mint authority is then revoked.
  const holders = { team, alice, bob, carol };
  const balances: [Wallet, bigint][] = [[team, 200_000_000n], [alice, 400_000_000n], [bob, 300_000_000n], [carol, 100_000_000n]];
  for (const [w, n] of balances) await h.fund(coin, admin, w.address, n);
  await h.setMintAuthority(coin, admin, null);
  for (const w of [team, alice, bob, carol, dave, company, recovery]) await h.ata(w.address, quote, admin);
  await h.ata(dave.address, coin, admin);
  await h.fund(quote, admin, company.address, 1_000_000_000_000n);

  // One SAS credential and schema serve every attestation kind the treasury reads.
  const [credential] = await deriveCredentialPda({ authority: attester.address, name: 'oc-attest' });
  const [schema] = await deriveSchemaPda({ credential, name: 'oc-data', version: 1 });
  // Revenue attestations carry one u64 (SAS layout code 3): the round's revenue in quote atoms.
  const [revSchema] = await deriveSchemaPda({ credential, name: 'oc-revenue', version: 1 });
  // Counsel's attestation that the IP and assets were assigned to the holder-governed entity.
  const [assignSchema] = await deriveSchemaPda({ credential, name: 'oc-assignment', version: 1 });
  await h.send([ix(getCreateCredentialInstruction({ payer: attester, credential, authority: attester, name: 'oc-attest', signers: [attester.address] } as never))], attester);
  await h.send([ix(getCreateSchemaInstruction({ payer: attester, authority: attester, credential, schema, name: 'oc-data', description: 'treasury test data', layout: new Uint8Array([0]), fieldNames: ['data'] } as never))], attester);

  await h.send([ix(getCreateSchemaInstruction({ payer: attester, authority: attester, credential, schema: revSchema, name: 'oc-revenue', description: 'attested revenue of a round', layout: new Uint8Array([3]), fieldNames: ['revenue'] } as never))], attester);

  await h.send([ix(getCreateSchemaInstruction({ payer: attester, authority: attester, credential, schema: assignSchema, name: 'oc-assignment', description: 'IP and asset assignment recorded', layout: new Uint8Array([0]), fieldNames: ['assigned'] } as never))], attester);

  const [treasury] = await findTreasuryPda({ coinMint: coin });
  const [vault] = await findVaultPda({ treasury });
  const [coinVault] = await findCoinVaultPda({ treasury });
  const [distVault] = await findDistVaultPda({ treasury });
  const ata = async (w: Address, mint: Address) => h.ata(w, mint, admin);
  const coinOf = (w: Wallet) => ata(w.address, coin);
  const quoteOf = (w: Wallet) => ata(w.address, quote);

  const attest = async (nonce: Address, data: Uint8Array, expiry: bigint, sch: Address = schema) => {
    const [attestation] = await deriveAttestationPda({ credential, schema: sch, nonce });
    await h.send([ix(getCreateAttestationInstruction({ payer: attester, authority: attester, credential, schema: sch, attestation, nonce, data, expiry } as never))], attester);
    return attestation;
  };
  /** An attestation of a round's revenue (a little-endian u64). */
  const attestRevenue = async (round: bigint, revenue: bigint, expiry = 0n) => attest(await roundNonce(treasury, round), le(revenue, 8), expiry, revSchema);
  const attestationAddress = async (nonce: Address, sch: Address = schema) => (await deriveAttestationPda({ credential, schema: sch, nonce }))[0];
  const closeAttestation = async (nonce: Address, sch: Address = schema) => {
    const [attestation] = await deriveAttestationPda({ credential, schema: sch, nonce });
    await h.send([ix(getCloseAttestationInstruction({ payer: attester, authority: attester, credential, attestation } as never))], attester);
  };

  const create = getCreateTreasuryInstruction({
    authority: team, coinMint: coin, quoteMint: quote, treasury, vault, quoteTokenProgram: TP,
    allowance: 1_000_000_000n, periodSecs: 30n * DAY, graceSecs: 7n * DAY, credential, schema,
  });
  await h.send([create], team);
  const fundVault = async (amount: bigint) => h.send([getMintToInstruction({ mint: quote, token: vault, mintAuthority: admin, amount }, { programAddress: TP })], admin);
  await fundVault(opts.vault ?? 10_000_000_000n);

  const ext = (o: ExtOverrides = {}) => ({
    votePeriodSecs: 3n * DAY, timelockSecs: DAY, quorumBps: 2_000, thresholdBps: 5_000, maxProposalBps: 5_000, proposerMinBps: 100,
    minLockupSecs: 90n * DAY, navPeriodSecs: 7n * DAY, navCapBps: 1_000, streamSecs: 0n, insiders: [team.address, ...(opts.insiders ?? []).map((n) => ({ alice, bob, carol })[n].address), ZERO, ZERO, ZERO].slice(0, 4),
    revShareBps: 1_000, revCredential: credential, revSchema: opts.revenueSchemaIsOneByte ? schema : revSchema, roundSecs: 7n * DAY, revStart: T0, payGraceSecs: 3n * DAY,
    trancheMinRevenue: 1_000_000_000n, trancheAmount: 500_000_000n, disclosurePeriodSecs: 14n * DAY, requestMinBps: 100,
    assignRequired: false, assignCredential: credential, assignSchema, windowSecs: 180n * DAY, recovery: recovery.address,
    ...o,
  });
  const initExt = (o: ExtOverrides = {}, signer: Wallet = team) =>
    getInitExtInstructionAsync({ authority: signer, treasury, coinMint: coin, quoteMint: quote, coinTokenProgram: TP, quoteTokenProgram: TP, ...ext(o) });
  if (opts.extend) await h.send([await initExt(opts.ext)], team);

  const raw = () => (h.svm.getAccount(treasury) as { data: Uint8Array }).data;
  const state = () => getTreasuryDecoder().decode(raw());
  const extState = () => decodeTreasuryExt(raw());

  const b = {
    propose: async (who: Wallet, id: bigint, kind: ProposalKind, amount = 0n, destination: Address = ZERO, descHash = new Uint8Array(32)) =>
      getProposeInstructionAsync({ proposer: who, treasury, coinMint: coin, proposerCoin: await coinOf(who), id, kind, amount, destination, descHash }),
    vote: async (who: Wallet, id: bigint, support: boolean, amount: bigint) => {
      const [proposal] = await findProposalPda({ treasury, id });
      return getVoteInstructionAsync({ voter: who, treasury, proposal, coinMint: coin, voterCoin: await coinOf(who), coinTokenProgram: TP, support, amount });
    },
    reclaim: async (who: Wallet, id: bigint) => {
      const [proposal] = await findProposalPda({ treasury, id });
      const [voteRecord] = await findVoteRecordPda({ proposal, voter: who.address });
      return getReclaimVoteInstructionAsync({ voter: who, treasury, proposal, voteRecord, coinMint: coin, voterCoin: await coinOf(who), coinTokenProgram: TP });
    },
    execute: async (who: Wallet, id: bigint, destination: Address) => {
      const [proposal] = await findProposalPda({ treasury, id });
      return getExecuteProposalInstructionAsync({ executor: who, treasury, proposal, coinMint: coin, quoteMint: quote, vault, destination, quoteTokenProgram: TP });
    },
    navRedeem: async (who: Wallet, amount: bigint) =>
      getNavRedeemInstructionAsync({ holder: who, treasury, coinMint: coin, quoteMint: quote, holderCoin: await coinOf(who), holderQuote: await quoteOf(who), vault, coinTokenProgram: TP, quoteTokenProgram: TP, amount }),
    stake: async (who: Wallet, amount: bigint) =>
      getStakeInstructionAsync({ owner: who, treasury, coinMint: coin, ownerCoin: await coinOf(who), coinTokenProgram: TP, amount }),
    unstake: async (who: Wallet, amount: bigint) =>
      getUnstakeInstructionAsync({ owner: who, treasury, coinMint: coin, ownerCoin: await coinOf(who), coinTokenProgram: TP, amount }),
    deposit: async (who: Wallet, amount: bigint) =>
      getDepositDistributionInstructionAsync({ depositor: who, treasury, quoteMint: quote, depositorQuote: await quoteOf(who), quoteTokenProgram: TP, amount }),
    claim: async (who: Wallet) =>
      getClaimDistributionInstructionAsync({ owner: who, treasury, quoteMint: quote, ownerQuote: await quoteOf(who), quoteTokenProgram: TP }),
    payRound: async (who: Wallet, round: bigint, attestation?: Address) =>
      getPayRoundInstructionAsync({ payer: who, treasury, quoteMint: quote, payerQuote: await quoteOf(who), attestation: attestation ?? (await attestationAddress(await roundNonce(treasury, round), revSchema)), quoteTokenProgram: TP, round }),
    markMissed: async (who: Wallet, round: bigint) =>
      getMarkMissedInstructionAsync({ caller: who, treasury, coinMint: coin, round }),
    tranche: async (who: Wallet, round: bigint, destination: Address) =>
      getReleaseTrancheInstructionAsync({ authority: who, treasury, quoteMint: quote, vault, destination, quoteTokenProgram: TP, round }),
    createGrant: async (who: Wallet, id: bigint, p: { beneficiary: Address; total: bigint; lockupEnd: bigint; expiryTs: bigint; milestones: { bps: number; requiresAttestation: boolean }[] }) => {
      const ms = p.milestones.map((m) => ({ ...m, released: false }));
      while (ms.length < 4) ms.push({ bps: 0, requiresAttestation: false, released: false });
      return getCreateGrantInstructionAsync({
        authority: who, treasury, coinMint: coin, authorityCoin: await coinOf(who), coinTokenProgram: TP, id,
        beneficiary: p.beneficiary, total: p.total, lockupEnd: p.lockupEnd, expiryTs: p.expiryTs, milestones: ms, milestoneCount: p.milestones.length, credential, schema,
      } as never);
    },
    releaseMilestone: async (who: Wallet, grant: Address, index: number, beneficiary: Wallet, attestation: Address = ZERO) =>
      getReleaseMilestoneInstructionAsync({ cranker: who, treasury, grant, coinMint: coin, beneficiaryCoin: await coinOf(beneficiary), attestation, coinTokenProgram: TP, index }),
    expireGrant: async (who: Wallet, grant: Address) =>
      getExpireGrantInstructionAsync({ cranker: who, treasury, grant, coinMint: coin, coinTokenProgram: TP }),
    postDisclosure: async (who: Wallet, hash: Uint8Array) => getPostDisclosureInstruction({ authority: who, treasury, hash }),
    requestDisclosure: async (who: Wallet) => getRequestDisclosureInstruction({ holder: who, treasury, coinMint: coin, holderCoin: await coinOf(who) }),
    recordAssignment: async (attestation: Address) => getRecordAssignmentInstruction({ treasury, attestation }),
    sweep: async (recoveryQuote: Address) => getSweepUnclaimedInstructionAsync({ treasury, quoteMint: quote, recoveryQuote, quoteTokenProgram: TP }),
    spend: async (who: Wallet, amount: bigint, attestation: Address, destination?: Address) =>
      getSpendInstruction({ authority: who, treasury, attestation, quoteMint: quote, vault, destination: destination ?? (await quoteOf(team)), quoteTokenProgram: TP, amount }),
    liquidate: () => getTriggerLiquidationInstruction({ treasury, coinMint: coin, vault }),
    lapse: (attestation: Address) => getRecordLapseInstruction({ treasury, attestation }),
    redeem: async (who: Wallet, amount: bigint) =>
      getRedeemInstruction({ holder: who, treasury, coinMint: coin, quoteMint: quote, holderCoin: await coinOf(who), holderQuote: await quoteOf(who), vault, coinTokenProgram: TP, quoteTokenProgram: TP, amount }),
  };

  const dec = {
    proposal: async (id: bigint) => { const [p] = await findProposalPda({ treasury, id }); return getProposalDecoder().decode((h.svm.getAccount(p) as { data: Uint8Array }).data); },
    position: async (w: Wallet) => { const [p] = await findPositionPda({ treasury, owner: w.address }); return getPositionDecoder().decode((h.svm.getAccount(p) as { data: Uint8Array }).data); },
    round: async (r: bigint) => { const [p] = await findRoundRecordPda({ treasury, round: r }); return getRoundRecordDecoder().decode((h.svm.getAccount(p) as { data: Uint8Array }).data); },
    grant: async (id: bigint) => { const [p] = await findGrantPda({ treasury, id }); return getGrantDecoder().decode((h.svm.getAccount(p) as { data: Uint8Array }).data); },
    grantAddress: async (id: bigint) => (await findGrantPda({ treasury, id }))[0],
  };

  return {
    h, admin, team, alice, bob, carol, dave, attester, company, recovery, holders, quote, coin, treasury, vault, coinVault, distVault,
    credential, schema, revSchema, assignSchema, attest, attestRevenue, attestationAddress, closeAttestation, create, initExt, ext, fundVault, b, dec, state, extState, raw,
    coinOf, quoteOf, ata,
    coinBal: (w: Wallet) => h.balanceOf(w.address, coin),
    quoteBal: (w: Wallet) => h.balanceOf(w.address, quote),
    /** Total quote the vaults hold. */
    vaults: () => ({ vault: h.balance(vault), dist: h.balance(distVault), coins: h.balance(coinVault) }),
    withProgram: (path: string) => h.svm.addProgramFromFile(TREASURY_PROGRAM_ADDRESS, path),
    pda: async (seeds: Uint8Array[]) => (await getProgramDerivedAddress({ programAddress: TREASURY_PROGRAM_ADDRESS, seeds }))[0],
  };
}


type Ix = Promise<Instruction>;
type Ext = NonNullable<ReturnType<typeof decodeTreasuryExt>>;
type Row = Record<string, any>; // decoded accounts: the generated decoders' shapes, read field by field in tests

export interface TW {
  h: Harness;
  admin: Wallet; team: Wallet; alice: Wallet; bob: Wallet; carol: Wallet; dave: Wallet; attester: Wallet; company: Wallet; recovery: Wallet;
  quote: Address; coin: Address; treasury: Address; vault: Address; coinVault: Address; distVault: Address;
  credential: Address; schema: Address; revSchema: Address; assignSchema: Address;
  attest(nonce: Address, data: Uint8Array, expiry: bigint, sch?: Address): Promise<Address>;
  attestRevenue(round: bigint, revenue: bigint, expiry?: bigint): Promise<Address>;
  attestationAddress(nonce: Address, sch?: Address): Promise<Address>;
  closeAttestation(nonce: Address, sch?: Address): Promise<void>;
  create: Instruction;
  initExt(o?: ExtOverrides, signer?: Wallet): Ix;
  ext(o?: ExtOverrides): Row;
  fundVault(amount: bigint): Promise<bigint>;
  state(): Row;
  extState(): Ext | null;
  raw(): Uint8Array;
  coinOf(w: Wallet): Promise<Address>;
  quoteOf(w: Wallet): Promise<Address>;
  ata(w: Address, mint: Address): Promise<Address>;
  coinBal(w: Wallet): Promise<bigint>;
  quoteBal(w: Wallet): Promise<bigint>;
  vaults(): { vault: bigint; dist: bigint; coins: bigint };
  withProgram(path: string): void;
  b: {
    propose(who: Wallet, id: bigint, kind: ProposalKind, amount?: bigint, destination?: Address, descHash?: Uint8Array): Ix;
    vote(who: Wallet, id: bigint, support: boolean, amount: bigint): Ix;
    reclaim(who: Wallet, id: bigint): Ix;
    execute(who: Wallet, id: bigint, destination: Address): Ix;
    navRedeem(who: Wallet, amount: bigint): Ix;
    stake(who: Wallet, amount: bigint): Ix;
    unstake(who: Wallet, amount: bigint): Ix;
    deposit(who: Wallet, amount: bigint): Ix;
    claim(who: Wallet): Ix;
    payRound(who: Wallet, round: bigint, attestation?: Address): Ix;
    markMissed(who: Wallet, round: bigint): Ix;
    tranche(who: Wallet, round: bigint, destination: Address): Ix;
    createGrant(who: Wallet, id: bigint, p: { beneficiary: Address; total: bigint; lockupEnd: bigint; expiryTs: bigint; milestones: { bps: number; requiresAttestation: boolean }[] }): Ix;
    releaseMilestone(who: Wallet, grant: Address, index: number, beneficiary: Wallet, attestation?: Address): Ix;
    expireGrant(who: Wallet, grant: Address): Ix;
    postDisclosure(who: Wallet, hash: Uint8Array): Promise<Instruction>;
    requestDisclosure(who: Wallet): Promise<Instruction>;
    recordAssignment(attestation: Address): Promise<Instruction>;
    sweep(recoveryQuote: Address): Ix;
    spend(who: Wallet, amount: bigint, attestation: Address, destination?: Address): Promise<Instruction>;
    liquidate(): Instruction;
    lapse(attestation: Address): Instruction;
    redeem(who: Wallet, amount: bigint): Ix;
  };
  dec: {
    proposal(id: bigint): Promise<Row>;
    position(w: Wallet): Promise<Row>;
    round(r: bigint): Promise<Row>;
    grant(id: bigint): Promise<Row>;
    grantAddress(id: bigint): Promise<Address>;
  };
}

export const treasuryWorld = build as unknown as (opts?: { extend?: boolean; baseline?: boolean; ext?: ExtOverrides; vault?: bigint; insiders?: ('alice' | 'bob' | 'carol')[]; revenueSchemaIsOneByte?: boolean }) => Promise<TW>;
