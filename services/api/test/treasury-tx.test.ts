// The treasury extension over HTTP, with accounts injected in memory: what each builder refuses before a transaction exists, the transactions
// it builds (decoded back to instructions), and the reads. The program is not run here (its LiteSVM suites need Linux); the instructions are
// the ones the generated client encodes, and `tests/core/test/sdk-treasury-builders.test.ts` compares them with the ones the suites build.
import Fastify from 'fastify';
import { beforeAll, describe, expect, it } from 'vitest';
import { type Address, type Instruction, decompileTransactionMessage, generateKeyPairSigner, getCompiledTransactionMessageDecoder, getTransactionDecoder, none, some } from '@solana/kit';
import { AccountState, TOKEN_2022_PROGRAM_ADDRESS, getMintEncoder, getTokenEncoder } from '@solana-program/token-2022';
import {
  ProposalKind,
  TREASURY_EXT_MAGIC,
  TREASURY_EXT_OFFSET,
  TREASURY_PROGRAM_ADDRESS,
  TreasuryState,
  associatedTokenAddress,
  findTreasuryPda,
  findVaultPda,
  getGrantEncoder,
  getPositionEncoder,
  getProposalEncoder,
  getRoundRecordEncoder,
  getTreasuryEncoder,
  getTreasuryExtEncoder,
  getVoteRecordEncoder,
  grantAddress,
  positionAddress,
  proposalAddress,
  roundRecordAddress,
  voteRecordAddress,
  flagshipExtParams,
  type TreasuryExt,
} from '@opening-cross/treasury-client';
import { SPL_TOKEN_PROGRAM_ADDRESS } from '@opening-cross/token-safety';
import { RequestError } from '../src/tx.js';
import { registerTreasuryTx } from '../src/routes/treasury-tx.js';

const NOW = 1_800_000_000;
const DAY = 86_400n;
const ZERO = '11111111111111111111111111111111' as Address;
const BLOCKHASH = '4NCYB3kRT8sCNodPNuCZo8VkwveZSHhg7R7mrRBFM1Uy' as never;
const key = async () => (await generateKeyPairSigner()).address;

type Account = { data: Uint8Array; owner: Address };

const mintBytes = (supply: bigint) => new Uint8Array(getMintEncoder().encode({ mintAuthority: none(), supply, decimals: 6, isInitialized: true, freezeAuthority: none(), extensions: none() } as never).slice(0, 82));
const tokenBytes = (mint: Address, owner: Address, amount: bigint) => {
  const out = new Uint8Array(165);
  out.set(getTokenEncoder().encode({ mint, owner, amount, delegate: none(), state: AccountState.Initialized, isNative: none(), delegatedAmount: 0n, closeAuthority: none(), extensions: none() } as never).slice(0, 165));
  return out;
};

describe('treasury extension over HTTP', () => {
  const accounts = new Map<string, Account>();
  let app: ReturnType<typeof Fastify>;
  let team: Address, alice: Address, bob: Address, stranger: Address, coin: Address, quote: Address, credential: Address, schema: Address, recovery: Address, attester: Address;
  let plain: Address, extended: Address, liquidating: Address;

  const post = async (url: string, payload: unknown) => {
    const r = await app.inject({ method: 'POST', url, payload: payload as never });
    return { status: r.statusCode, body: JSON.parse(r.body) };
  };
  const get = async (url: string) => {
    const r = await app.inject({ method: 'GET', url });
    return { status: r.statusCode, body: JSON.parse(r.body) };
  };
  const instructionsOf = (tx: string): Instruction[] => {
    const decoded = getTransactionDecoder().decode(Uint8Array.from(Buffer.from(tx, 'base64')));
    return decompileTransactionMessage(getCompiledTransactionMessageDecoder().decode(decoded.messageBytes)).instructions as Instruction[];
  };
  const treasuryProgram = (ix: Instruction) => ix.programAddress === TREASURY_PROGRAM_ADDRESS;

  const extTail = (over: Partial<TreasuryExt> = {}): TreasuryExt => ({
    magic: TREASURY_EXT_MAGIC,
    coinVaultBump: 255,
    distVaultBump: 255,
    votePeriodSecs: 3n * DAY,
    timelockSecs: DAY,
    quorumBps: 2_000,
    thresholdBps: 5_000,
    maxProposalBps: 5_000,
    proposerMinBps: 100,
    proposalCount: 0n,
    votesLocked: 0n,
    totalStaked: 0n,
    grantsUnreleased: 0n,
    grantCount: 0n,
    minLockupSecs: 90n * DAY,
    navOpen: false,
    navPeriodSecs: 7n * DAY,
    navCapBps: 1_000,
    navPeriodStart: 0n,
    navPeriodSupply: 0n,
    navBurned: 0n,
    insiders: [team, ZERO, ZERO, ZERO],
    accPerStake: 0n,
    streamSecs: 0n,
    streamAmount: 0n,
    streamEnd: 0n,
    streamLast: 0n,
    revShareBps: 1_000,
    revCredential: credential,
    revSchema: schema,
    roundSecs: 7n * DAY,
    revStart: BigInt(NOW - 20 * 86_400),
    payGraceSecs: 3n * DAY,
    missedRounds: 0,
    trancheMinRevenue: 0n,
    trancheAmount: 0n,
    disclosurePeriodSecs: 14n * DAY,
    lastDisclosureTs: 0n,
    lastDisclosureHash: new Uint8Array(32),
    disclosures: 0,
    openRequestTs: 0n,
    requestMinBps: 100,
    assignRequired: false,
    assigned: false,
    assignCredential: credential,
    assignSchema: schema,
    windowSecs: 180n * DAY,
    recovery,
    windStart: 0n,
    swept: false,
    ...over,
  });

  async function putTreasury(coinMint: Address, o: { ext?: Partial<TreasuryExt> | null; state?: TreasuryState; vault?: bigint } = {}): Promise<Address> {
    const [address] = await findTreasuryPda({ coinMint });
    const body = getTreasuryEncoder().encode({ authority: team, coinMint, quoteMint: quote, quoteDecimals: 6, allowance: 1_000_000_000n, periodSecs: 30n * DAY, periodStart: 0n, spentInPeriod: 0n, credential, schema, graceSecs: 7n * DAY, lapsedSince: o.state === TreasuryState.Liquidating ? some(BigInt(NOW - 10 * 86_400)) : none(), state: o.state ?? TreasuryState.Active, snapshotVault: 10_000_000_000n, snapshotSupply: 1_000_000_000n, bump: 255, vaultBump: 255 });
    const tail = o.ext === null || o.ext === undefined ? null : getTreasuryExtEncoder().encode(extTail(o.ext));
    const data = new Uint8Array(tail ? TREASURY_EXT_OFFSET + tail.length : body.length);
    data.set(body);
    if (tail) data.set(tail, TREASURY_EXT_OFFSET);
    accounts.set(address, { owner: TREASURY_PROGRAM_ADDRESS, data });
    const [vault] = await findVaultPda({ treasury: address });
    accounts.set(vault, { owner: TOKEN_2022_PROGRAM_ADDRESS, data: tokenBytes(quote, address, o.vault ?? 10_000_000_000n) });
    return address;
  }
  const hold = async (owner: Address, mint: Address, amount: bigint, program = TOKEN_2022_PROGRAM_ADDRESS) => {
    accounts.set(await associatedTokenAddress(owner, mint, program), { owner: program, data: tokenBytes(mint, owner, amount) });
  };

  beforeAll(async () => {
    [team, alice, bob, stranger, coin, quote, credential, schema, recovery, attester] = await Promise.all(Array.from({ length: 10 }, key));
    accounts.set(coin, { owner: TOKEN_2022_PROGRAM_ADDRESS, data: mintBytes(1_000_000_000n) });
    accounts.set(quote, { owner: SPL_TOKEN_PROGRAM_ADDRESS, data: mintBytes(10_000_000_000_000n) });
    await hold(team, coin, 200_000_000n);
    await hold(alice, coin, 400_000_000n);
    await hold(bob, coin, 300_000_000n);
    await hold(stranger, coin, 0n);
    await hold(alice, quote, 5_000_000_000n, SPL_TOKEN_PROGRAM_ADDRESS);
    plain = await putTreasury(coin);
    app = Fastify({ logger: false });
    app.setErrorHandler((err, _req, reply) => {
      if (err instanceof RequestError) return reply.code(err.status).type('application/json').send(JSON.stringify({ error: err.message, ...err.detail }, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)));
      return reply.code(500).send({ error: String(err) });
    });
    registerTreasuryTx(app, { db: { query: async () => ({ rows: [] }) } as never, account: async (a) => accounts.get(a) ?? null, lifetime: async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 100n }), clock: () => NOW });
    void attester;
  });

  describe('a treasury that was never extended', () => {
    it('refuses every extension instruction with a reason that says what to do', async () => {
      for (const [path, body] of [
        ['stake', { owner: alice, amount: '1' }],
        ['vote', { voter: alice, id: '0', support: true, amount: '1' }],
        ['claim-distribution', { owner: alice }],
        ['request-disclosure', { holder: alice }],
        ['nav-redeem', { holder: alice, amount: '1' }],
      ] as const) {
        const r = await post(`/v1/treasuries/${plain}/tx/${path}`, body);
        expect(r.status, path).toBe(422);
        expect(r.body.reason, path).toBe('NOT_EXTENDED');
        expect(r.body.error).toMatch(/init-ext/);
      }
      const ext = await get(`/v1/treasuries/${plain}/ext`);
      expect(ext.body).toMatchObject({ extended: false });
    });

    it('init-ext refuses terms the program would refuse, and builds the instruction for terms it accepts', async () => {
      const weak = await post(`/v1/treasuries/${plain}/tx/init-ext`, { authority: team, params: { votePeriodSecs: 3600, timelockSecs: 60, quorumBps: 500, thresholdBps: 5000, maxProposalBps: 5000, windowSecs: 100 } });
      expect(weak.status).toBe(422);
      expect(weak.body.reason).toBe('TERMS_INVALID');
      expect(weak.body.issues.map((i: { code: string }) => i.code)).toEqual(expect.arrayContaining(['VOTE_PERIOD', 'TIMELOCK', 'QUORUM', 'WINDOW', 'RECOVERY']));
      const wrongSigner = await post(`/v1/treasuries/${plain}/tx/init-ext`, { authority: alice, params: {} });
      expect(wrongSigner.body.reason).toBe('NOT_THE_AUTHORITY');
      const ok = await post(`/v1/treasuries/${plain}/tx/init-ext`, { authority: team, params: { votePeriodSecs: String(3n * DAY), timelockSecs: String(DAY), quorumBps: 2000, thresholdBps: 5000, maxProposalBps: 5000, proposerMinBps: 100, minLockupSecs: String(90n * DAY), navPeriodSecs: String(7n * DAY), navCapBps: 1000, insiders: [team], windowSecs: String(180n * DAY), recovery } });
      expect(ok.status).toBe(200);
      const [ix] = instructionsOf(ok.body.transaction);
      expect(treasuryProgram(ix!)).toBe(true);
      expect(ok.body.signers).toEqual([team]);
    });

    it('init-ext takes the flagship preset as written, and refuses a revenue clock in the past', async () => {
      const flagship = { authority: team, preset: 'flagship', revenueCredential: credential, revenueSchema: schema, assignmentCredential: credential, assignmentSchema: schema, revenueShareBps: 1000, revenueStart: String(NOW + 86_400), recovery };
      expect((await post(`/v1/treasuries/${plain}/tx/init-ext`, flagship)).status).toBe(200);
      const past = await post(`/v1/treasuries/${plain}/tx/init-ext`, { ...flagship, revenueStart: String(NOW - 5) });
      expect(past.status).toBe(422);
      expect(past.body.issues[0].code).toBe('REV_START_PAST');
      void flagshipExtParams;
    });
  });

  describe('an extended treasury', () => {
    beforeAll(async () => {
      const coin2 = await key();
      accounts.set(coin2, { owner: TOKEN_2022_PROGRAM_ADDRESS, data: mintBytes(1_000_000_000n) });
      await Promise.all([hold(team, coin2, 200_000_000n), hold(alice, coin2, 400_000_000n), hold(bob, coin2, 300_000_000n)]);
      await hold(alice, quote, 5_000_000_000n, SPL_TOKEN_PROGRAM_ADDRESS);
      extended = await putTreasury(coin2, { ext: { proposalCount: 3n, grantCount: 1n, totalStaked: 100_000_000n, accPerStake: 5n * 1_000_000_000n / 100n } });
      // proposals: 0 passed and executable, 1 still voting, 2 failed
      const coin2Ctx = { treasury: extended };
      const mk = async (id: bigint, over: Record<string, unknown>) => {
        accounts.set(await proposalAddress(coin2Ctx.treasury, id), {
          owner: TREASURY_PROGRAM_ADDRESS,
          data: new Uint8Array(getProposalEncoder().encode({ treasury: extended, id, proposer: alice, kind: ProposalKind.Spend, amount: 1_000_000n, destination: await associatedTokenAddress(bob, quote, SPL_TOKEN_PROGRAM_ADDRESS), descHash: new Uint8Array(32), createdTs: BigInt(NOW - 6 * 86_400), voteEndTs: BigInt(NOW - 3 * 86_400), executableTs: BigInt(NOW - 2 * 86_400), expiresTs: BigInt(NOW + 12 * 86_400), yes: 400_000_000n, no: 0n, executed: false, bump: 255, ...over } as never)),
        });
      };
      await mk(0n, {});
      await mk(1n, { voteEndTs: BigInt(NOW + 86_400), executableTs: BigInt(NOW + 2 * 86_400), expiresTs: BigInt(NOW + 16 * 86_400), yes: 0n });
      await mk(2n, { yes: 100_000_000n, no: 300_000_000n });
      accounts.set(await voteRecordAddress(extended, 0n, alice), { owner: TREASURY_PROGRAM_ADDRESS, data: new Uint8Array(getVoteRecordEncoder().encode({ proposal: await proposalAddress(extended, 0n), voter: alice, yes: 400_000_000n, no: 0n, bump: 255 })) });
      accounts.set(await positionAddress(extended, alice), { owner: TREASURY_PROGRAM_ADDRESS, data: new Uint8Array(getPositionEncoder().encode({ treasury: extended, owner: alice, amount: 100_000_000n, debt: 0n, pending: 7n, bump: 255 })) });
      accounts.set(await grantAddress(extended, 0n), {
        owner: TREASURY_PROGRAM_ADDRESS,
        data: new Uint8Array(getGrantEncoder().encode({ treasury: extended, id: 0n, beneficiary: bob, total: 100_000_000n, released: 0n, lockupEnd: BigInt(NOW + 30 * 86_400), expiryTs: BigInt(NOW + 400 * 86_400), milestones: [{ bps: 2_500, requiresAttestation: false, released: false }, { bps: 5_000, requiresAttestation: true, released: false }, { bps: 0, requiresAttestation: false, released: false }, { bps: 0, requiresAttestation: false, released: false }], milestoneCount: 2, credential, schema, burned: false, bump: 255 })),
      });
      accounts.set(await roundRecordAddress(extended, 0n), { owner: TREASURY_PROGRAM_ADDRESS, data: new Uint8Array(getRoundRecordEncoder().encode({ treasury: extended, round: 0n, revenue: 5_000_000_000n, due: 500_000_000n, missed: false, trancheReleased: false, bump: 255 })) });
      const coin5 = await key();
      accounts.set(coin5, { owner: TOKEN_2022_PROGRAM_ADDRESS, data: mintBytes(1_000_000_000n) });
      liquidating = await putTreasury(coin5, { ext: {}, state: TreasuryState.Liquidating });
    });

    it('propose takes the next id, checks the holding and the cap, and refuses a stranger', async () => {
      const ok = await post(`/v1/treasuries/${extended}/tx/propose`, { proposer: alice, kind: 'spend', amount: '1000000', destination: await associatedTokenAddress(bob, quote, SPL_TOKEN_PROGRAM_ADDRESS) });
      expect(ok.status).toBe(200);
      expect(ok.body.id).toBe('3');
      expect(ok.body.proposal).toBe(await proposalAddress(extended, 3n));
      const over = await post(`/v1/treasuries/${extended}/tx/propose`, { proposer: alice, kind: 'spend', amount: '6000000000', destination: bob });
      expect(over.status).toBe(422);
      expect(over.body.reason).toBe('OVER_PROPOSAL_CAP');
      expect(over.body.cap).toBe('5000000000');
      const nobody = await post(`/v1/treasuries/${extended}/tx/propose`, { proposer: stranger, kind: 'spend', amount: '1', destination: bob });
      expect(nobody.body.reason).toBe('NOT_A_HOLDER');
      expect((await post(`/v1/treasuries/${extended}/tx/propose`, { proposer: alice, kind: 'open-nav', amount: '5' })).status).toBe(400);
      expect((await post(`/v1/treasuries/${extended}/tx/propose`, { proposer: alice, kind: 'open-nav' })).status).toBe(200);
      expect((await post(`/v1/treasuries/${extended}/tx/propose`, { proposer: alice, kind: 'burn' })).status).toBe(400);
    });

    it('vote refuses a closed vote and more coins than the wallet holds; reclaim waits for the vote to end', async () => {
      const closed = await post(`/v1/treasuries/${extended}/tx/vote`, { voter: alice, id: '0', support: true, amount: '1' });
      expect(closed.body.reason).toBe('VOTING_CLOSED');
      const tooMuch = await post(`/v1/treasuries/${extended}/tx/vote`, { voter: alice, id: '1', support: true, amount: '900000000' });
      expect(tooMuch.body.reason).toBe('INSUFFICIENT_COINS');
      const ok = await post(`/v1/treasuries/${extended}/tx/vote`, { voter: alice, id: '1', support: true, amount: '100000000' });
      expect(ok.status).toBe(200);
      expect(ok.body.voteEndsAt).toBe(String(NOW + 86_400));
      expect((await post(`/v1/treasuries/${extended}/tx/vote`, { voter: alice, id: '9', support: true, amount: '1' })).body.reason).toBe('NO_PROPOSAL');
      expect((await post(`/v1/treasuries/${extended}/tx/reclaim-vote`, { voter: alice, id: '1' })).body.reason).toBe('VOTING_OPEN');
      expect((await post(`/v1/treasuries/${extended}/tx/reclaim-vote`, { voter: bob, id: '0' })).body.reason).toBe('NO_VOTE');
      expect((await post(`/v1/treasuries/${extended}/tx/reclaim-vote`, { voter: alice, id: '0' })).status).toBe(200);
    });

    it('execute-proposal runs only a proposal that passed and waited', async () => {
      const ok = await post(`/v1/treasuries/${extended}/tx/execute-proposal`, { executor: stranger, id: '0' });
      expect(ok.status).toBe(200);
      expect(ok.body.kind).toBe('spend');
      expect((await post(`/v1/treasuries/${extended}/tx/execute-proposal`, { executor: stranger, id: '1' })).body.status).toBe('voting');
      expect((await post(`/v1/treasuries/${extended}/tx/execute-proposal`, { executor: stranger, id: '2' })).body.status).toBe('failed');
    });

    it('nav-redeem needs an open window, excludes insiders, and reports the payout', async () => {
      expect((await post(`/v1/treasuries/${extended}/tx/nav-redeem`, { holder: alice, amount: '1000000' })).body.reason).toBe('NAV_CLOSED');
      const coin3 = await key();
      accounts.set(coin3, { owner: TOKEN_2022_PROGRAM_ADDRESS, data: mintBytes(1_000_000_000n) });
      await Promise.all([hold(team, coin3, 200_000_000n), hold(alice, coin3, 400_000_000n)]);
      const open = await putTreasury(coin3, { ext: { navOpen: true } });
      const r = await post(`/v1/treasuries/${open}/tx/nav-redeem`, { holder: alice, amount: '100000000' });
      expect(r.status).toBe(200);
      // 100 of 1,000 coins against a 10,000 vault: floor(10,000,000,000 * 100,000,000 / 1,000,000,000)
      expect(r.body.payout).toBe('1000000000');
      expect((await post(`/v1/treasuries/${open}/tx/nav-redeem`, { holder: team, amount: '1' })).body.reason).toBe('INSIDER_EXCLUDED');
      expect((await post(`/v1/treasuries/${open}/tx/nav-redeem`, { holder: alice, amount: '0' })).status).toBe(400);
      expect((await post(`/v1/treasuries/${open}/tx/nav-redeem`, { holder: alice, amount: '500000000' })).body.reason).toBe('INSUFFICIENT_COINS');
    });

    it('stake, unstake and claim check balances and say what is claimable', async () => {
      expect((await post(`/v1/treasuries/${extended}/tx/stake`, { owner: alice, amount: '400000000' })).status).toBe(200);
      expect((await post(`/v1/treasuries/${extended}/tx/stake`, { owner: alice, amount: '400000001' })).body.reason).toBe('INSUFFICIENT_COINS');
      expect((await post(`/v1/treasuries/${extended}/tx/unstake`, { owner: alice, amount: '100000001' })).body.reason).toBe('INSUFFICIENT_STAKE');
      expect((await post(`/v1/treasuries/${extended}/tx/unstake`, { owner: alice, amount: '100000000' })).status).toBe(200);
      // pending 7 + floor(100,000,000 * 0.05) = 5,000,007
      const claim = await post(`/v1/treasuries/${extended}/tx/claim-distribution`, { owner: alice });
      expect(claim.status).toBe(200);
      expect(claim.body.claimable).toBe('5000007');
      expect((await post(`/v1/treasuries/${extended}/tx/claim-distribution`, { owner: bob })).body.reason).toBe('NO_POSITION');
      expect((await post(`/v1/treasuries/${extended}/tx/deposit-distribution`, { depositor: alice, amount: '1000' })).status).toBe(200);
      expect((await post(`/v1/treasuries/${extended}/tx/deposit-distribution`, { depositor: bob, amount: '1000' })).body.reason).toBe('INSUFFICIENT_QUOTE');
    });

    it('revenue rounds: pay needs the attester\'s attestation, a late round can be marked missed', async () => {
      const pay = await post(`/v1/treasuries/${extended}/tx/pay-round`, { payer: alice, round: '0' });
      expect(pay.status).toBe(422);
      expect(pay.body.reason).toBe('NOT_ATTESTED');
      expect(pay.body.attestation).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
      // revStart is 20 days ago, rounds are 7 days with 3 days of grace: round 0 ended 13 days ago, round 2 ends 1 day from now
      expect((await post(`/v1/treasuries/${extended}/tx/mark-missed`, { caller: stranger, round: '0' })).status).toBe(200);
      expect((await post(`/v1/treasuries/${extended}/tx/mark-missed`, { caller: stranger, round: '2' })).body.reason).toBe('ROUND_NOT_LATE');
    });

    it('grants: lockup minimum, milestone sum, and a milestone that needs its attestation', async () => {
      const g = (over: Record<string, unknown> = {}) => ({ authority: team, beneficiary: bob, total: '50000000', lockupEnd: String(NOW + 100 * 86_400), expiryTs: String(NOW + 400 * 86_400), milestones: [{ bps: 2_500, requiresAttestation: false }, { bps: 5_000, requiresAttestation: true }], credential, schema, ...over });
      const ok = await post(`/v1/treasuries/${extended}/tx/create-grant`, g());
      expect(ok.status).toBe(200);
      expect(ok.body.id).toBe('1');
      expect((await post(`/v1/treasuries/${extended}/tx/create-grant`, g({ lockupEnd: String(NOW + 10 * 86_400) }))).body.reason).toBe('LOCKUP_TOO_SHORT');
      expect((await post(`/v1/treasuries/${extended}/tx/create-grant`, g({ milestones: [{ bps: 6_000 }, { bps: 6_000 }] }))).body.reason).toBe('MILESTONES_OVER_100');
      expect((await post(`/v1/treasuries/${extended}/tx/create-grant`, g({ authority: alice }))).body.reason).toBe('NOT_THE_AUTHORITY');
      expect((await post(`/v1/treasuries/${extended}/tx/create-grant`, g({ total: '900000000' }))).body.reason).toBe('INSUFFICIENT_COINS');
      const grant = await grantAddress(extended, 0n);
      expect((await post(`/v1/treasuries/${extended}/tx/release-milestone`, { cranker: stranger, grant, index: 0 })).body.reason).toBe('LOCKED');
      expect((await post(`/v1/treasuries/${extended}/tx/expire-grant`, { cranker: stranger, grant })).body.reason).toBe('NOT_EXPIRED');
    });

    it('the deployed instructions: liquidation and redemption', async () => {
      expect((await post(`/v1/treasuries/${extended}/tx/trigger-liquidation`, { payer: stranger })).body.reason).toBe('NOT_LAPSED');
      expect((await post(`/v1/treasuries/${extended}/tx/redeem`, { holder: alice, amount: '1' })).body.reason).toBe('NOT_LIQUIDATING');
      const coin4 = await key();
      accounts.set(coin4, { owner: TOKEN_2022_PROGRAM_ADDRESS, data: mintBytes(1_000_000_000n) });
      await hold(alice, coin4, 400_000_000n);
      const liq = await putTreasury(coin4, { state: TreasuryState.Liquidating });
      const r = await post(`/v1/treasuries/${liq}/tx/redeem`, { holder: alice, amount: '400000000' });
      expect(r.status).toBe(200);
      // snapshot 10,000,000,000 / 1,000,000,000 coins
      expect(r.body.payout).toBe('4000000000');
      expect((await post(`/v1/treasuries/${liquidating}/tx/stake`, { owner: alice, amount: '1' })).body.reason).toBe('LIQUIDATING');
    });

    it('redemption is closed once the leftover has been swept to the recovery account (the program refuses with WoundDown)', async () => {
      const coin5 = await key();
      accounts.set(coin5, { owner: TOKEN_2022_PROGRAM_ADDRESS, data: mintBytes(1_000_000_000n) });
      await hold(alice, coin5, 400_000_000n);
      const swept = await putTreasury(coin5, { state: TreasuryState.Liquidating, ext: { windStart: BigInt(NOW - 200 * 86_400), swept: true } });
      const r = await post(`/v1/treasuries/${swept}/tx/redeem`, { holder: alice, amount: '400000000' });
      expect(r.status).toBe(409);
      expect(r.body).toMatchObject({ reason: 'WOUND_DOWN', recovery });
      expect((await post(`/v1/treasuries/${swept}/tx/sweep-unclaimed`, { payer: stranger })).body.reason).toBe('ALREADY_SWEPT');
      // inside the window the same treasury still redeems, and the sweep is refused with the second it opens
      const coin6 = await key();
      accounts.set(coin6, { owner: TOKEN_2022_PROGRAM_ADDRESS, data: mintBytes(1_000_000_000n) });
      await hold(alice, coin6, 400_000_000n);
      const inside = await putTreasury(coin6, { state: TreasuryState.Liquidating, ext: { windStart: BigInt(NOW - 10 * 86_400), swept: false } });
      expect((await post(`/v1/treasuries/${inside}/tx/redeem`, { holder: alice, amount: '400000000' })).status).toBe(200);
      const early = await post(`/v1/treasuries/${inside}/tx/sweep-unclaimed`, { payer: stranger });
      expect(early.body).toMatchObject({ reason: 'WINDOW_OPEN', opensAt: String(NOW - 10 * 86_400 + 180 * 86_400) });
    });

    it('reads: terms and state, proposals with a status, a staker\'s position, grants, rounds', async () => {
      const ext = await get(`/v1/treasuries/${extended}/ext`);
      expect(ext.body.extended).toBe(true);
      expect(ext.body.terms.governance).toMatchObject({ quorumBps: 2000, maxProposalBps: 5000 });
      expect(ext.body.live).toMatchObject({ proposals: '3', grants: '1', totalStaked: '100000000', currentRound: '2' });
      const proposals = await get(`/v1/treasuries/${extended}/proposals`);
      expect(proposals.body.proposals.map((p: { id: string; status: string }) => [p.id, p.status])).toEqual([['2', 'failed'], ['1', 'voting'], ['0', 'executable']]);
      const one = await get(`/v1/treasuries/${extended}/proposals/0?voter=${alice}`);
      expect(one.body.vote).toMatchObject({ voter: alice, yes: '400000000' });
      expect((await get(`/v1/treasuries/${extended}/proposals/77`)).status).toBe(404);
      const pos = await get(`/v1/treasuries/${extended}/positions/${alice}`);
      expect(pos.body).toMatchObject({ staked: '100000000', claimable: '5000007', held: '400000000' });
      const grants = await get(`/v1/treasuries/${extended}/grants`);
      expect(grants.body.grants[0]).toMatchObject({ status: 'locked', total: '100000000' });
      expect(grants.body.grants[0].milestones.map((m: { amount: string }) => m.amount)).toEqual(['25000000', '50000000']);
      const rounds = await get(`/v1/treasuries/${extended}/rounds`);
      expect(rounds.body.rounds.map((r: { round: string; status: string }) => [r.round, r.status])).toEqual([['2', 'open'], ['1', 'late'], ['0', 'paid']]);
      expect((await get(`/v1/treasuries/${extended}/events?limit=0`)).status).toBe(400);
      expect((await get(`/v1/treasuries/${extended}/events?name=Voted`)).body.events).toEqual([]);
      expect((await get(`/v1/treasuries/${await key()}/ext`)).status).toBe(404);
    });
  });
});
