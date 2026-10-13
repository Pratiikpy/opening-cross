// A local API and cluster for the holder browser runs. It serves the REAL routes of services/api (buildServer: the cross reads, the rules
// and treasury transaction builders of W3A, the holder routes) over accounts the programs would have written, held in memory, and a small
// JSON-RPC endpoint that records every transaction the browser wallet signs and sends. Nothing is stubbed on the API side: a transaction the
// page asks for is built by the same code that serves it in production, and the run decodes it afterwards (instructions, arguments and
// accounts) from `GET /__sent`.
//
// What it is not: a cluster. The programs are not run (the extended programs are not deployed, H27, and LiteSVM needs Linux), so state does
// not advance after a transaction: each scenario is a fixed set of accounts, and the run asserts the transaction the wallet signed.
//
//   cd services/api && PORT=8481 RPC_PORT=8482 npx tsx test/holder-w3c-harness.ts
//
// Endpoints on RPC_PORT (JSON-RPC at /, plus):  GET /__fixtures  addresses and times   GET /__sent  decoded transactions   DELETE /__sent
//                                                POST /__release {crossCore, treasury}  switches the deployed release the API reports
import { readFileSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import {
  type Address,
  type Instruction,
  decompileTransactionMessage,
  generateKeyPairSigner,
  getAddressDecoder,
  getAddressEncoder,
  getBase58Decoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  none,
  some,
} from '@solana/kit';
import { AccountState, TOKEN_2022_PROGRAM_ADDRESS, getMintEncoder, getTokenEncoder } from '@solana-program/token-2022';
import * as core from '@opening-cross/sdk';
import * as treasuryClient from '@opening-cross/treasury-client';
import { CROSS_GATE_PROGRAM_ADDRESS, Mode, findConfigPda, getGateConfigEncoder, getPassEncoder } from '@opening-cross/cross-gate-client';
import { SPL_TOKEN_PROGRAM_ADDRESS } from '@opening-cross/token-safety';
import { registerHolderPrograms } from '../src/routes/holder-programs.ts';
import { buildServer } from '../src/server.ts';
import { walletSecret, WALLET_LABELS } from '../../../apps/web/e2e/holder-keys.mjs';

const {
  AUX_END_BASE,
  CROSS_BODY_LEN,
  CROSS_CORE_PROGRAM_ADDRESS,
  CROSS_DISCRIMINATOR,
  CROSS_EXT_LEN,
  CrossKind,
  CrossState,
  Disclosure,
  OrderSide,
  SupplyMode,
  ata,
  bookAddress,
  challengeAddress,
  classBookAddress,
  completeRules,
  crossAddress,
  gatePassAddress,
  getChallengeEncoder,
  getCrossEncoder,
  getCrossExtEncoder,
  getLevelsEncoder,
  getLockupEncoder,
  getOrderEncoder,
  lockVaultAddress,
  lockupAddress,
  orderAddress,
  shardAddress,
} = core as unknown as Record<string, any>;
const {
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
} = treasuryClient as unknown as Record<string, any>;

const PORT = Number(process.env.PORT ?? 8481);
const RPC_PORT = Number(process.env.RPC_PORT ?? 8482);
const T0 = Math.floor(Date.now() / 1000);
const DAY = 86_400;
const ZERO = '11111111111111111111111111111111' as Address;
const BLOCKHASH = '4NCYB3kRT8sCNodPNuCZo8VkwveZSHhg7R7mrRBFM1Uy' as never;
const key = async (): Promise<Address> => (await generateKeyPairSigner()).address;

type Account = { data: Uint8Array; owner: Address };
const accounts = new Map<string, Account>();
const put = (a: string, data: Uint8Array, owner: Address) => void accounts.set(a, { data, owner });

// ------------------------------------------------------------------------------------------------ wallets and tokens
const wallets: Record<string, Address> = {};
for (const label of WALLET_LABELS) wallets[label] = getAddressDecoder().decode(Uint8Array.from(walletSecret(label).slice(32)));

const mintBytes = (authority: Address | null, supply = 0n) => new Uint8Array(getMintEncoder().encode({ mintAuthority: authority ? some(authority) : none(), supply, decimals: 6, isInitialized: true, freezeAuthority: none(), extensions: none() } as never).slice(0, 82));
const tokenBytes = (mint: Address, owner: Address, amount: bigint) => {
  const out = new Uint8Array(165);
  out.set(getTokenEncoder().encode({ mint, owner, amount, delegate: none(), state: AccountState.Initialized, isNative: none(), delegatedAmount: 0n, closeAuthority: none(), extensions: none() } as never).slice(0, 165));
  return out;
};
async function hold(owner: Address, mint: Address, amount: bigint, program: Address) {
  put(await ata(owner, mint, program), tokenBytes(mint, owner, amount), program);
}

const creator = await key();
const integrator = await key();
const feeRecipient = await key();
const baseMint = await key();
const quoteMint = await key();
const gateMint = await key();
const priorityGateMint = await key();
put(baseMint, mintBytes(creator), TOKEN_2022_PROGRAM_ADDRESS);
put(quoteMint, mintBytes(creator, 10_000_000_000_000n), SPL_TOKEN_PROGRAM_ADDRESS);
// A gate (cross_gate config) for the cross's pass, and one for the priority class. Passes are issued below.
for (const mint of [gateMint, priorityGateMint]) {
  const [address, bump] = await findConfigPda({ mint });
  put(address, new Uint8Array(getGateConfigEncoder().encode({ mint, authority: creator, mode: Mode.Allowlist, bump, sas: none(), allowlistRoot: none() })), CROSS_GATE_PROGRAM_ADDRESS);
}
const issuePass = async (mint: Address, owner: Address) => put(await gatePassAddress(mint, owner), new Uint8Array(getPassEncoder().encode({ mint, owner, bump: 255 })), CROSS_GATE_PROGRAM_ADDRESS);
for (const w of ['pass', 'limit', 'lock', 'claim', 'pushed', 'refund', 'priority']) await issuePass(gateMint, wallets[w]!);
await issuePass(priorityGateMint, wallets.priority!);
// Every wallet holds 1,000 quote.
for (const w of WALLET_LABELS) await hold(wallets[w]!, quoteMint, 1_000_000_000n, SPL_TOKEN_PROGRAM_ADDRESS);

// ------------------------------------------------------------------------------------------------ crosses
const extWith = (over: Record<string, unknown> = {}) => {
  const base = completeRules({});
  return {
    version: 1,
    rulesSet: true,
    createdSlot: 10n,
    flags: 0,
    guards: { ...base.guards, haltSource: null },
    ending: base.ending,
    draw: { epoch: 0, pendingSlot: 0n, pendingPurpose: 0, seed: new Uint8Array(32), seedEpoch: 0, seedReady: false, endBucket: 255, extPending: false, extensionUsed: false, auxMerged: 0n },
    identity: base.identity,
    alloc: { ...base.alloc, priorityGate: null },
    neutrality: { insiders: Array.from({ length: 8 }, () => ZERO), insiderCount: 0, insiderCliffSecs: 0, insiderVestSecs: 0, bondQuote: 0n, challengeSecs: 0 },
    neutralState: { bondHeld: 0n, slashed: 0n, openChallenges: 0, challenges: 0 },
    clearing: { classQty: [0n, 0n, 0n], tickets: 0, rho: 0, clearedTs: 0n, insiderUb: 0n },
    referral: base.referral,
    oracleSet: { extraFeeds: [new Uint8Array(32), new Uint8Array(32)], extraCount: 0, quorum: 0, maxSpreadBps: 0, offHoursWidenBps: 0 },
    ...over,
  };
};
const insiders = (list: Address[]) => [...list, ...Array.from({ length: 8 - list.length }, () => ZERO)];

type CrossSpec = { id: bigint; open: number; close: number; state?: number; ext?: ReturnType<typeof extWith> | null; gate?: Address | null; clearing?: { price: bigint; matched: bigint } | null; noPrintReason?: number | null; ordersTotal?: number; ordersOpen?: number };
const crosses: Record<string, Address> = {};
const crossRows: { address: Address; spec: CrossSpec }[] = [];
async function putCross(name: string, spec: CrossSpec) {
  const address = await crossAddress(creator, spec.id);
  const body = getCrossEncoder().encode({
    creator,
    crossId: spec.id,
    kind: CrossKind.Launch,
    supplyMode: SupplyMode.Mint,
    disclosure: Disclosure.Open,
    state: spec.state ?? CrossState.Live,
    baseMint,
    quoteMint,
    baseTokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    quoteTokenProgram: SPL_TOKEN_PROGRAM_ADDRESS,
    baseDecimals: 6,
    quoteDecimals: 6,
    proceedsTo: creator,
    minPrice: 1_000_000n,
    tick: 100_000n,
    ticks: 20,
    priceScale: 1_000_000n,
    openTs: BigInt(spec.open),
    closeTs: BigInt(spec.close),
    revealEndTs: BigInt(spec.close),
    referencePrice: none(),
    minMatched: 0n,
    maxImbalanceBps: none(),
    protocolFeeBps: 30,
    integratorFeeBps: 20,
    integrator,
    feeRecipient,
    gateMint: spec.gate ? some(spec.gate) : none(),
    shards: 2,
    maxOrders: 64,
    dustBond: 0n,
    ordersTotal: spec.ordersTotal ?? 0,
    ordersOpen: spec.ordersOpen ?? 0,
    mergedMask: (spec.state ?? 0) === 0 ? 0 : 3,
    clearing: spec.clearing ? some({ price: spec.clearing.price, matched: spec.clearing.matched, demand: spec.clearing.matched, supply: spec.clearing.matched, rationed: 0, marginalQuantity: 0n, marginalRemaining: 0n, marginalOrders: 0 }) : none(),
    noPrintReason: spec.noPrintReason === undefined || spec.noPrintReason === null ? none() : some(spec.noPrintReason),
    buyerPaid: 0n,
    baseBought: 0n,
    baseSold: 0n,
    sellerPaid: 0n,
    feesAccrued: 0n,
    oracle: none(),
    calendar: none(),
    settler: none(),
    settleDeadlineTs: 0n,
    baseBound: true,
    bump: 255,
    quoteVaultBump: 255,
    baseVaultBump: 255,
    bookBump: 255,
  } as never);
  const data = new Uint8Array(CROSS_BODY_LEN + (spec.ext ? CROSS_EXT_LEN : 0));
  data.set(body);
  if (spec.ext) data.set(getCrossExtEncoder().encode(spec.ext), CROSS_BODY_LEN);
  put(address, data, CROSS_CORE_PROGRAM_ADDRESS);
  crosses[name] = address;
  crossRows.push({ address, spec });
  return address;
}

const levelsBytes = (cross: Address, buys: Record<number, bigint>, sells: Record<number, bigint>) => {
  const buy = new Array<bigint>(256).fill(0n);
  const sell = new Array<bigint>(256).fill(0n);
  const bo = new Array<number>(256).fill(0);
  const so = new Array<number>(256).fill(0);
  for (const [i, q] of Object.entries(buys)) [buy[Number(i)], bo[Number(i)]] = [q, 1];
  for (const [i, q] of Object.entries(sells)) [sell[Number(i)], so[Number(i)]] = [q, 1];
  return new Uint8Array(getLevelsEncoder().encode({ cross, buy, sell, buyOrders: bo, sellOrders: so, index: 0, pad: new Uint8Array(7) }));
};
async function putBook(cross: Address, buys: Record<number, bigint>, sells: Record<number, bigint>, shards = 2) {
  put(await bookAddress(cross), levelsBytes(cross, {}, {}), CROSS_CORE_PROGRAM_ADDRESS);
  put(await shardAddress(cross, 0), levelsBytes(cross, buys, sells), CROSS_CORE_PROGRAM_ADDRESS);
  for (let i = 1; i < shards; i++) put(await shardAddress(cross, i), levelsBytes(cross, {}, {}), CROSS_CORE_PROGRAM_ADDRESS);
}

const E6 = 1_000_000n;
const rulesRich = extWith({
  guards: { ...completeRules({}).guards, minRaiseQuote: 5_000n * E6, maxMatched: 1_000n * E6, totalSupply: 10_000n * E6, minFloatBps: 1_000, maxFdvX100: 2_500, anchorPrice: 1_500_000n, moveBps: 2_000, gridEstimate: 0n, haltSource: null },
  identity: { capQuote: 100n * E6, maxOrders: 1 },
  alloc: { ...completeRules({}).alloc, reserveBps: [3_000, 2_000, 1_000], smallCapQuote: 5n * E6, lotteryUnit: 0n, minLockSecs: 30 * DAY, lockVestSecs: 60 * DAY, earlyUntilTs: BigInt(T0 + DAY), priorityGate: priorityGateMint, class1CliffSecs: 0, class1VestSecs: 0 },
  neutrality: { insiders: insiders([wallets.insider!]), insiderCount: 1, insiderCliffSecs: 7 * DAY, insiderVestSecs: 90 * DAY, bondQuote: 100n * E6, challengeSecs: 3 * DAY },
  referral: { referrer: wallets.stranger!, shareBps: 2_500 },
});
const ENDING = (endingSecs: number, buckets: number, cancelCutoffSecs: number) => ({ endingSecs, buckets, cancelCutoffSecs, randomEnd: true, extensionMinSecs: 0, extensionMaxSecs: 0 });

// X1: open, gated, every kind of rule except an ending period.
await putCross('classes', { id: 1n, open: T0 - 3600, close: T0 + 3 * DAY, gate: gateMint, ext: rulesRich, ordersTotal: 1, ordersOpen: 1 });
await putBook(crosses.classes!, { 6: 30n * E6 }, { 4: 100n * E6 });
// The wallet 'limit' already has its one live order in X1.
const limitOrder = await orderAddress(crosses.classes!, wallets.limit!, 0n);
put(limitOrder, new Uint8Array(getOrderEncoder().encode({ cross: crosses.classes!, owner: wallets.limit!, nonce: 0n, index: 0, side: OrderSide.Buy, state: 1, commitment: new Uint8Array(32), price: 1_600_000n, quantity: 10n * E6, escrow: 16n * E6, bump: 255 })), CROSS_CORE_PROGRAM_ADDRESS);
// A plain cross with no rules (the first release shape), to show that the same page says so.
await putCross('plain', { id: 2n, open: T0 - 3600, close: T0 + 3 * DAY, ext: null });
await putBook(crosses.plain!, {}, {});
// X2: in the third of eight ending windows, cancellation already closed; the book gives a price and a direction.
await putCross('ending', { id: 3n, open: T0 - 3 * 3600, close: T0 + 3000, gate: null, ext: extWith({ ending: ENDING(4000, 8, 300), alloc: { ...completeRules({}).alloc, priorityGate: null } }) });
await putBook(crosses.ending!, { 6: 30n * E6 }, { 4: 100n * E6 });
// X2b: the ending period has not started and cancellation is open.
await putCross('before-ending', { id: 4n, open: T0 - 3600, close: T0 + 3000, ext: extWith({ ending: ENDING(1000, 4, 500), alloc: { ...completeRules({}).alloc, priorityGate: null } }) });
await putBook(crosses['before-ending']!, {}, {});
// X3: the call closed two minutes ago, its rules draw the last counted window, no draw has begun.
await putCross('draw', { id: 5n, open: T0 - 3600, close: T0 - 120, ext: extWith({ ending: ENDING(600, 2, 0) }) });
await putBook(crosses.draw!, { 6: 30n * E6 }, { 4: 100n * E6 });
// X3b: the draw has begun (its slot is recorded), so the next step is to finish it.
await putCross('draw-begun', { id: 6n, open: T0 - 3600, close: T0 - 120, ext: extWith({ ending: ENDING(600, 2, 0), draw: { epoch: 0, pendingSlot: 1_000n, pendingPurpose: 1, seed: new Uint8Array(32), seedEpoch: 0, seedReady: false, endBucket: 255, extPending: false, extensionUsed: false, auxMerged: 0n } }) });
await putBook(crosses['draw-begun']!, {}, {});
// X4: cleared, with a bond, a challenge window still open, one open challenge, and a locked fill with something vested.
const clearedExt = extWith({
  neutrality: { insiders: insiders([wallets.insider!]), insiderCount: 1, insiderCliffSecs: 7 * DAY, insiderVestSecs: 90 * DAY, bondQuote: 100n * E6, challengeSecs: 3 * DAY },
  neutralState: { bondHeld: 100n * E6, slashed: 0n, openChallenges: 1, challenges: 1 },
  clearing: { classQty: [0n, 0n, 0n], tickets: 0, rho: 0, clearedTs: BigInt(T0 - 3600), insiderUb: 0n },
  alloc: { ...completeRules({}).alloc, priorityGate: null, minLockSecs: 30 * DAY, reserveBps: [0, 1_000, 0] },
});
await putCross('cleared', { id: 7n, open: T0 - 5 * DAY, close: T0 - 4 * DAY, state: CrossState.Cleared, ext: clearedExt, clearing: { price: 1_400_000n, matched: 80n * E6 } });
await putBook(crosses.cleared!, {}, {});
// The wallet 'lock' holds a locked fill: 100 tokens, a 1 day cliff that has passed and a 4 day vesting that is half through.
const lockStart = T0 - 3 * DAY;
put(await lockupAddress(crosses.cleared!, wallets.lock!, 0n), new Uint8Array(getLockupEncoder().encode({ cross: crosses.cleared!, owner: wallets.lock!, nonce: 0n, amount: 100n * E6, released: 0n, startTs: BigInt(lockStart), cliffSecs: DAY, vestSecs: 4 * DAY, bump: 255 })), CROSS_CORE_PROGRAM_ADDRESS);
put(await challengeAddress(crosses.cleared!, 0), new Uint8Array(getChallengeEncoder().encode({ cross: crosses.cleared!, id: 0, challenger: wallets.stranger!, subject: wallets.nopass!, evidence: new Uint8Array(32).fill(7), deposit: 10_000_000n, filedTs: BigInt(T0 - 20 * DAY), status: 0, slashed: 0n, bump: 255 })), CROSS_CORE_PROGRAM_ADDRESS);
// The wallet 'claim' has an unclaimed order in the cleared cross, priced out (a refund only).
const claimOrder = await orderAddress(crosses.cleared!, wallets.claim!, 0n);
put(claimOrder, new Uint8Array(getOrderEncoder().encode({ cross: crosses.cleared!, owner: wallets.claim!, nonce: 0n, index: 1, side: OrderSide.Buy, state: 1, commitment: new Uint8Array(32), price: 1_100_000n, quantity: 10n * E6, escrow: 11n * E6, bump: 255 })), CROSS_CORE_PROGRAM_ADDRESS);
// X5: did not print (the amount raised was below the minimum); 'refund' has an unclaimed order, 'pushed' had its refund pushed (no account left).
await putCross('noprint', { id: 8n, open: T0 - 5 * DAY, close: T0 - 4 * DAY, state: CrossState.NoPrint, ext: rulesRich, noPrintReason: 6, gate: gateMint });
await putBook(crosses.noprint!, {}, {});
const refundOrder = await orderAddress(crosses.noprint!, wallets.refund!, 0n);
put(refundOrder, new Uint8Array(getOrderEncoder().encode({ cross: crosses.noprint!, owner: wallets.refund!, nonce: 0n, index: 0, side: OrderSide.Buy, state: 1, commitment: new Uint8Array(32), price: 1_500_000n, quantity: 10n * E6, escrow: 15n * E6, bump: 255 })), CROSS_CORE_PROGRAM_ADDRESS);
const pushedOrder = await orderAddress(crosses.noprint!, wallets.pushed!, 0n);

// ------------------------------------------------------------------------------------------------ treasuries
const credential = await key();
const schema = await key();
const recovery = await key();
const coins: Record<string, Address> = {};
const treasuries: Record<string, Address> = {};
const extTail = (over: Record<string, unknown> = {}) => ({
  magic: TREASURY_EXT_MAGIC,
  coinVaultBump: 255,
  distVaultBump: 255,
  votePeriodSecs: 3n * BigInt(DAY),
  timelockSecs: BigInt(DAY),
  quorumBps: 2_000,
  thresholdBps: 5_000,
  maxProposalBps: 5_000,
  proposerMinBps: 100,
  proposalCount: 0n,
  votesLocked: 0n,
  totalStaked: 0n,
  grantsUnreleased: 0n,
  grantCount: 0n,
  minLockupSecs: 90n * BigInt(DAY),
  navOpen: false,
  navPeriodSecs: 7n * BigInt(DAY),
  navCapBps: 1_000,
  navPeriodStart: 0n,
  navPeriodSupply: 0n,
  navBurned: 0n,
  insiders: [wallets.team!, ZERO, ZERO, ZERO],
  accPerStake: 0n,
  streamSecs: 0n,
  streamAmount: 0n,
  streamEnd: 0n,
  streamLast: 0n,
  revShareBps: 1_000,
  revCredential: credential,
  revSchema: schema,
  roundSecs: 7n * BigInt(DAY),
  revStart: BigInt(T0 - 20 * DAY),
  payGraceSecs: 3n * BigInt(DAY),
  missedRounds: 0,
  trancheMinRevenue: 0n,
  trancheAmount: 0n,
  disclosurePeriodSecs: 14n * BigInt(DAY),
  lastDisclosureTs: 0n,
  lastDisclosureHash: new Uint8Array(32),
  disclosures: 0,
  openRequestTs: 0n,
  requestMinBps: 100,
  assignRequired: false,
  assigned: false,
  assignCredential: credential,
  assignSchema: schema,
  windowSecs: 180n * BigInt(DAY),
  recovery,
  windStart: 0n,
  swept: false,
  ...over,
});
async function putTreasury(name: string, o: { ext?: Record<string, unknown> | null; state?: number } = {}) {
  const coinMint = await key();
  coins[name] = coinMint;
  put(coinMint, mintBytes(null, 1_000_000_000n), TOKEN_2022_PROGRAM_ADDRESS);
  const [address] = await findTreasuryPda({ coinMint });
  const body = getTreasuryEncoder().encode({ authority: wallets.team!, coinMint, quoteMint, quoteDecimals: 6, allowance: 1_000_000_000n, periodSecs: 30n * BigInt(DAY), periodStart: 0n, spentInPeriod: 0n, credential, schema, graceSecs: 7n * BigInt(DAY), lapsedSince: none(), state: o.state ?? TreasuryState.Active, snapshotVault: 10_000_000_000n, snapshotSupply: 1_000_000_000n, bump: 255, vaultBump: 255 });
  const tail = o.ext === undefined || o.ext === null ? null : getTreasuryExtEncoder().encode(extTail(o.ext));
  const data = new Uint8Array(tail ? TREASURY_EXT_OFFSET + tail.length : body.length);
  data.set(body);
  if (tail) data.set(tail, TREASURY_EXT_OFFSET);
  put(address, data, TREASURY_PROGRAM_ADDRESS);
  const [vault] = await findVaultPda({ treasury: address });
  put(vault, tokenBytes(quoteMint, address, 10_000_000_000n), SPL_TOKEN_PROGRAM_ADDRESS);
  treasuries[name] = address;
  for (const [w, amount] of [['team', 200_000_000n], ['holder', 400_000_000n], ['small', 3_000_000n], ['beneficiary', 10_000_000n], ['stranger', 0n]] as const) {
    await hold(wallets[w]!, coinMint, amount, TOKEN_2022_PROGRAM_ADDRESS);
  }
  return address;
}
// An extended treasury: three proposals (one executable, one open for voting, one failed), a staked position, a grant for 'beneficiary', rounds, disclosure on.
const tExt = await putTreasury('extended', { ext: { proposalCount: 3n, grantCount: 1n, totalStaked: 100_000_000n, accPerStake: (5n * 1_000_000_000n) / 100n } });
for (const [id, over] of [
  [0n, {}],
  [1n, { voteEndTs: BigInt(T0 + DAY), executableTs: BigInt(T0 + 2 * DAY), expiresTs: BigInt(T0 + 16 * DAY), yes: 0n }],
  [2n, { yes: 100_000_000n, no: 300_000_000n }],
] as const) {
  put(
    await proposalAddress(tExt, id),
    new Uint8Array(
      getProposalEncoder().encode({ treasury: tExt, id, proposer: wallets.holder!, kind: ProposalKind.Spend, amount: 1_000_000n, destination: await associatedTokenAddress(wallets.team!, quoteMint, SPL_TOKEN_PROGRAM_ADDRESS), descHash: new Uint8Array(32), createdTs: BigInt(T0 - 6 * DAY), voteEndTs: BigInt(T0 - 3 * DAY), executableTs: BigInt(T0 - 2 * DAY), expiresTs: BigInt(T0 + 12 * DAY), yes: 400_000_000n, no: 0n, executed: false, bump: 255, ...over }),
    ),
    TREASURY_PROGRAM_ADDRESS,
  );
}
put(await voteRecordAddress(tExt, 2n, wallets.holder!), new Uint8Array(getVoteRecordEncoder().encode({ proposal: await proposalAddress(tExt, 2n), voter: wallets.holder!, yes: 100_000_000n, no: 0n, bump: 255 })), TREASURY_PROGRAM_ADDRESS);
put(await positionAddress(tExt, wallets.holder!), new Uint8Array(getPositionEncoder().encode({ treasury: tExt, owner: wallets.holder!, amount: 100_000_000n, debt: 0n, pending: 7n, bump: 255 })), TREASURY_PROGRAM_ADDRESS);
put(
  await grantAddress(tExt, 0n),
  new Uint8Array(
    getGrantEncoder().encode({
      treasury: tExt,
      id: 0n,
      beneficiary: wallets.beneficiary!,
      total: 100_000_000n,
      released: 0n,
      lockupEnd: BigInt(T0 - DAY),
      expiryTs: BigInt(T0 + 400 * DAY),
      milestones: [{ bps: 2_500, requiresAttestation: false, released: false }, { bps: 5_000, requiresAttestation: true, released: false }, ...Array.from({ length: 2 }, () => ({ bps: 0, requiresAttestation: false, released: false }))],
      milestoneCount: 2,
      credential,
      schema,
      burned: false,
      bump: 255,
    }),
  ),
  TREASURY_PROGRAM_ADDRESS,
);
put(await roundRecordAddress(tExt, 0n), new Uint8Array(getRoundRecordEncoder().encode({ treasury: tExt, round: 0n, revenue: 5_000_000_000n, due: 500_000_000n, missed: false, trancheReleased: false, bump: 255 })), TREASURY_PROGRAM_ADDRESS);
// A treasury whose NAV window is open, with a declared insider ('team').
await putTreasury('nav', { ext: { navOpen: true, navPeriodStart: BigInt(T0 - 3600), navPeriodSupply: 1_000_000_000n, navBurned: 10_000_000n } });
// A treasury that was never extended (the first release shape), and one that is liquidating.
await putTreasury('plain', { ext: null });
await putTreasury('open-request', { ext: { openRequestTs: BigInt(T0 - 3600) } });

// ------------------------------------------------------------------------------------------------ the deployed release (what GET /v1/programs reports)
const LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111' as Address;
const DATA_CORE = await key();
const DATA_TREASURY = await key();
const lddw = (discs: Uint8Array[]) => {
  const out = new Uint8Array(4096 + discs.length * 64);
  out.fill(0x07, 0, 4096);
  discs.forEach((d, n) => {
    const at = 4096 + n * 64;
    out[at] = 0x18;
    out[at + 1] = 0x01;
    out.set(d.subarray(0, 4), at + 4);
    out.set(d.subarray(4, 8), at + 12);
  });
  return out;
};
const programData = (body: Uint8Array, slot: bigint) => {
  const out = new Uint8Array(45 + body.length);
  new DataView(out.buffer).setUint32(0, 3, true);
  new DataView(out.buffer).setBigUint64(4, slot, true);
  out.set(body, 45);
  return out;
};
const programAccount = (data: Address) => {
  const out = new Uint8Array(36);
  new DataView(out.buffer).setUint32(0, 2, true);
  out.set(getAddressEncoder().encode(data), 4);
  return out;
};
const D = (name: string) => (core as Record<string, any>)[name] as Uint8Array;
const T = (name: string) => (treasuryClient as Record<string, any>)[name] as Uint8Array;
function setRelease(r: { crossCore: 'first' | 'extended'; treasury: 'first' | 'extended' }) {
  const coreDiscs = [D('CREATE_CROSS_DISCRIMINATOR'), ...(r.crossCore === 'extended' ? [D('SET_RULES_DISCRIMINATOR'), D('COMMIT_ORDER_EXT_DISCRIMINATOR'), D('DRAW_BEGIN_DISCRIMINATOR')] : [])];
  const treasuryDiscs = [T('SPEND_DISCRIMINATOR'), ...(r.treasury === 'extended' ? [T('INIT_EXT_DISCRIMINATOR'), T('VOTE_DISCRIMINATOR'), T('NAV_REDEEM_DISCRIMINATOR'), T('STAKE_DISCRIMINATOR')] : [])];
  put(CROSS_CORE_PROGRAM_ADDRESS, programAccount(DATA_CORE), LOADER);
  put(DATA_CORE, programData(lddw(coreDiscs), 777n), LOADER);
  put(TREASURY_PROGRAM_ADDRESS, programAccount(DATA_TREASURY), LOADER);
  put(DATA_TREASURY, programData(lddw(treasuryDiscs), 888n), LOADER);
  release = r;
}
let release = { crossCore: 'extended' as 'first' | 'extended', treasury: 'extended' as 'first' | 'extended' };
setRelease(release);

// ------------------------------------------------------------------------------------------------ the API
const pg = new PGlite();
const migrations = fileURLToPath(new URL('../../indexer/migrations/', import.meta.url));
for (const f of readdirSync(migrations).filter((n) => n.endsWith('.sql')).sort()) await pg.exec(readFileSync(`${migrations}${f}`, 'utf8'));
const q = (text: string, params: unknown[] = []) => pg.query(text, params as never[]);

for (const { address, spec } of crossRows) {
  await q(
    `INSERT INTO crosses (address, creator, kind, supply_mode, disclosure, base_mint, quote_mint, open_ts, close_ts, reveal_end_ts, protocol_fee_bps, integrator_fee_bps, state, clearing_price, matched, orders_committed, created_slot, updated_slot)
     VALUES ($1, $2, 0, 1, 1, $3, $4, $5, $6, $6, 30, 20, $7, $8, $9, $10, 1, 1) ON CONFLICT DO NOTHING`,
    [address, creator, baseMint, quoteMint, spec.open, spec.close, ['Live', 'Cleared', 'NoPrint', 'Finalized'][spec.state ?? 0], spec.clearing ? String(spec.clearing.price) : null, spec.clearing ? String(spec.clearing.matched) : null, spec.ordersTotal ?? 0],
  );
}
let slot = 100;
async function orderRow(cross: Address, address: Address, owner: Address, idx: number, side: 'buy' | 'sell', escrow: bigint, price: bigint, quantity: bigint, status: string, extra: { fill?: bigint; quoteOut?: bigint; baseOut?: bigint; fee?: bigint } = {}) {
  await q(
    `INSERT INTO orders (cross_address, idx, address, owner, side, escrow, sealed, price, quantity, status, fill, quote_out, base_out, fee, created_slot, updated_slot, nonce)
     VALUES ($1, $2, $3, $4, $5, $6, false, $7, $8, $9, $10, $11, $12, $13, $14, $14, 0)`,
    [cross, idx, address, owner, side === 'buy' ? 0 : 1, String(escrow), String(price), String(quantity), status, extra.fill === undefined ? null : String(extra.fill), extra.quoteOut === undefined ? null : String(extra.quoteOut), extra.baseOut === undefined ? null : String(extra.baseOut), extra.fee === undefined ? null : String(extra.fee), slot++],
  );
}
await orderRow(crosses.classes!, limitOrder, wallets.limit!, 0, 'buy', 16n * E6, 1_600_000n, 10n * E6, 'revealed');
await orderRow(crosses.cleared!, claimOrder, wallets.claim!, 1, 'buy', 11n * E6, 1_100_000n, 10n * E6, 'revealed');
await orderRow(crosses.noprint!, refundOrder, wallets.refund!, 0, 'buy', 15n * E6, 1_500_000n, 10n * E6, 'revealed');
// 'pushed': a keeper pushed this refund, so the order account is gone from chain while the index still says revealed.
await orderRow(crosses.noprint!, pushedOrder, wallets.pushed!, 1, 'buy', 12n * E6, 1_200_000n, 10n * E6, 'revealed');
// 'lock': the order whose claim created the lockup (claimed, filled in full), plus the index's record of the lock.
const lockOrder = await orderAddress(crosses.cleared!, wallets.lock!, 0n);
await orderRow(crosses.cleared!, lockOrder, wallets.lock!, 2, 'buy', 150n * E6, 1_500_000n, 100n * E6, 'claimed', { fill: 100n * E6, quoteOut: 10n * E6, baseOut: 0n });
await q(`INSERT INTO cross_locks (cross_address, owner, order_address, nonce, amount, start_ts, cliff_secs, vest_secs, released, created_slot, signature, seq) VALUES ($1, $2, $3, 0, $4, $5, $6, $7, 0, 1, 'lock-sig', 0)`, [crosses.cleared, wallets.lock, lockOrder, String(100n * E6), lockStart, DAY, 4 * DAY]);
await q(`INSERT INTO cross_challenges (cross_address, id, challenger, subject, evidence, status, slash, filed_slot, resolved_slot) VALUES ($1, 0, $2, $3, $4, 'Open', NULL, 1, NULL)`, [crosses.cleared, wallets.stranger, wallets.nopass, '07'.repeat(32)]);
for (const [name, t] of Object.entries(treasuries)) {
  await q(`INSERT INTO treasuries (address, coin_mint, authority, allowance, period_secs, created_signature, created_slot, updated_slot, created_at, state) VALUES ($1, $2, $3, 1000000000, $4, $5, 1, 1, $6, 'Active')`, [t, coins[name], wallets.team, 30 * DAY, `created-${name}`, T0 - 30 * DAY]);
}

const sent: { signature: string; names: string[]; instructions: unknown[]; feePayer: string; signedBy: string[] }[] = [];

const app = await buildServer({
  db: { query: (text: string, params?: unknown[]) => pg.query(text, params as never[]) } as never,
  network: 'devnet',
  account: async (a: Address) => accounts.get(a) ?? null,
  lifetime: async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 100n }),
  clock: () => Math.floor(Date.now() / 1000),
  w2a: false,
} as never);
registerHolderPrograms(app, { account: async (a) => accounts.get(a) ?? null, network: 'devnet', ttlMs: 0 });
await app.ready();
await app.listen({ port: PORT, host: '127.0.0.1' });

// ------------------------------------------------------------------------------------------------ the cluster: records what the wallet signs
const decoders = new Map<string, { name: string; decode: (b: Uint8Array) => unknown; program: string }>();
for (const [mod, program] of [[core, CROSS_CORE_PROGRAM_ADDRESS], [treasuryClient, TREASURY_PROGRAM_ADDRESS]] as const) {
  for (const [exportName, value] of Object.entries(mod as Record<string, unknown>)) {
    const m = /^(.+)_DISCRIMINATOR$/.exec(exportName);
    if (!m || !(value instanceof Uint8Array) || value.length !== 8) continue;
    const pascal = m[1]!.toLowerCase().replace(/(^|_)([a-z])/g, (_x, _y, c: string) => c.toUpperCase());
    const getter = (mod as Record<string, unknown>)[`get${pascal}InstructionDataDecoder`] as undefined | (() => { decode: (b: Uint8Array) => unknown });
    if (getter) decoders.set(`${program}:${Buffer.from(value).toString('hex')}`, { name: m[1]!.toLowerCase(), decode: (b) => getter().decode(b), program });
  }
}
const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x instanceof Uint8Array ? Buffer.from(x).toString('hex') : x));

function record(wire: Uint8Array) {
  const tx = getTransactionDecoder().decode(wire);
  const message = decompileTransactionMessage(getCompiledTransactionMessageDecoder().decode(tx.messageBytes));
  const signature = getBase58Decoder().decode(Object.values(tx.signatures)[0] as Uint8Array);
  const instructions = (message.instructions as Instruction[]).map((ix) => {
    const data = ix.data ?? new Uint8Array(0);
    const hit = decoders.get(`${ix.programAddress}:${Buffer.from(data.subarray(0, 8)).toString('hex')}`);
    return {
      program: ix.programAddress,
      name: hit?.name ?? null,
      args: hit ? (() => { try { return JSON.parse(json(hit.decode(data))); } catch { return null; } })() : null,
      accounts: (ix.accounts ?? []).map((a) => a.address),
    };
  });
  const signedBy = Object.entries(tx.signatures).filter(([, s]) => s && (s as Uint8Array).some((b) => b !== 0)).map(([k]) => k);
  sent.push({ signature, names: instructions.filter((i) => i.name).map((i) => i.name as string), instructions, feePayer: Object.keys(tx.signatures)[0]!, signedBy });
  return signature;
}

const rpc = createServer((req, res) => {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
  if (req.method === 'OPTIONS') return void res.writeHead(204, cors).end();
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    const reply = (status: number, v: unknown) => res.writeHead(status, { ...cors, 'content-type': 'application/json' }).end(json(v));
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/__fixtures') return reply(200, { t0: T0, wallets, crosses, treasuries, coins, mints: { baseMint, quoteMint, gateMint, priorityGateMint }, orders: { limitOrder, claimOrder, refundOrder, pushedOrder, lockOrder }, release, pdas: { classBook: null } });
    if (path === '/__sent' && req.method === 'DELETE') {
      sent.length = 0;
      return reply(200, { ok: true });
    }
    if (path === '/__sent') return reply(200, sent);
    if (path === '/__release' && req.method === 'POST') {
      const r = JSON.parse(body) as typeof release;
      setRelease({ crossCore: r.crossCore === 'first' ? 'first' : 'extended', treasury: r.treasury === 'first' ? 'first' : 'extended' });
      return reply(200, release);
    }
    if (path === '/__addresses') {
      void (async () => {
        const c = crosses;
        reply(200, {
          classBook: await classBookAddress(c.classes),
          lockVault: await lockVaultAddress(c.classes),
          endingShards: Object.fromEntries(await Promise.all([...Array(8).keys()].map(async (b) => [b, await shardAddress(c.ending, AUX_END_BASE + b)]))),
          lockup: await lockupAddress(c.cleared, wallets.lock, 0n),
          challenge0: await challengeAddress(c.cleared, 0),
          challenge1: await challengeAddress(c.cleared, 1),
          positionHolder: await positionAddress(treasuries.extended, wallets.holder),
          proposal1: await proposalAddress(treasuries.extended, 1n),
          proposal2: await proposalAddress(treasuries.extended, 2n),
          grant0: await grantAddress(treasuries.extended, 0n),
        });
      })();
      return;
    }
    let call: { id: unknown; method: string; params: unknown[] };
    try {
      call = JSON.parse(body);
    } catch {
      return reply(400, { error: 'not JSON' });
    }
    const ok = (result: unknown) => reply(200, { jsonrpc: '2.0', id: call.id, result });
    if (call.method === 'sendTransaction') {
      try {
        return ok(record(Uint8Array.from(Buffer.from(String(call.params[0]), 'base64'))));
      } catch (e) {
        return reply(200, { jsonrpc: '2.0', id: call.id, error: { code: -32002, message: `the harness could not decode this transaction: ${String(e)}` } });
      }
    }
    if (call.method === 'getSignatureStatuses') {
      const sigs = (call.params[0] as string[]) ?? [];
      return ok({ context: { slot: 1 }, value: sigs.map((s) => (sent.some((t) => t.signature === s) ? { slot: 1, confirmations: null, err: null, confirmationStatus: 'confirmed' } : null)) });
    }
    if (call.method === 'getBalance') return ok({ context: { slot: 1 }, value: 2_000_000_000 });
    return reply(200, { jsonrpc: '2.0', id: call.id, error: { code: -32601, message: `the harness cluster does not implement ${call.method}` } });
  });
});
rpc.listen(RPC_PORT, '127.0.0.1', () => console.log(JSON.stringify({ api: `http://127.0.0.1:${PORT}`, rpc: `http://127.0.0.1:${RPC_PORT}`, t0: T0 })));
