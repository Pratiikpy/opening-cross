// A real-validator proof of the keeper's partner-fees duty (row P2, ADR-0961): a deferred-mint launch clears on cross_core, the creator opens a Meteora DBC pool through
// cross_settle at the clearing price, the mint is bound, winners claim, the cross finalizes, and a wallet trades on the live pool so that it accrues trading fees. Then the
// KEEPER (runOnce with the duty `partner-fees`, over real RPC) reads the pool, opens the fee recipient's two token accounts, and claims the partner's share to it.
// Checked against chain, not against the keeper's own reading:
//   - the partner's accrued fee in the pool, decoded by Anchor from Meteora's own IDL, equals what the keeper's reader returned;
//   - the fee recipient's quote balance rises by exactly that amount, and the pool's partner counters are zero afterwards;
//   - a second pass, and a pass inside the interval, send nothing; a later trade accrues more and a pass after the interval claims it too.
// The flow up to the swap is that of tests/devnet/src/dbc-continuation-e2e.ts (the devnet proof), run against a local validator.
//
//   wsl: solana-test-validator --reset --rpc-port 8950 --bpf-program <id> target/deploy/{cross_core,cross_gate,cross_settle}.so
//        --bpf-program dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN tests/fixtures/dynamic_bonding_curve.so
//        --bpf-program metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s tests/fixtures/mpl_token_metadata.so
//   RPC_URL=http://127.0.0.1:8950 pnpm --filter @opening-cross/keeper exec tsx scripts/partner-fee-proof.ts
//
// It refuses a public cluster, generates and funds every wallet from the validator's faucet, and writes nothing but stdout.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Connection, Keypair, PublicKey, sendAndConfirmTransaction } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, createTransferCheckedWithTransferHookInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import BN from 'bn.js';
import { BorshAccountsCoder } from '@coral-xyz/anchor';
import {
  ActivationType,
  AccountsType,
  BaseFeeMode,
  CollectFeeMode,
  DynamicBondingCurveClient,
  MigrationFeeOption,
  MigrationOption,
  SwapMode,
  TokenDecimal,
  deriveDbcPoolAuthority,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import {
  type Address,
  type Instruction,
  type KeyPairSigner,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  fetchEncodedAccount,
  generateKeyPairSigner,
} from '@solana/kit';
import {
  CROSS_CORE_PROGRAM_ADDRESS,
  CrossKind,
  CrossState,
  Disclosure,
  OrderSide,
  SupplyMode,
  buildClaim,
  buildCreateCross,
  buildFinalizeWithAccounts,
  buildPlaceOrder,
  buildSettleBook,
  crossAddress,
  getCrossDecoder,
  getInitProtocolInstruction,
  protocolAddress,
  TOKEN_2022_PROGRAM,
} from '@opening-cross/sdk';
import { type ContinuationDesign, TOKEN_2022, buildBindDbcMint, buildOpenDbcPool, continuationAddresses, settlerAddress } from '@opening-cross/adapters';
import { createIndexerRpc } from '@opening-cross/indexer';
import { rpc as kitRpc } from '../../../tests/devnet/src/lib.js';
import { accountData, ataIx, chainTime, mintTo, newMint, send, tokenBalance, ata as t22Ata, waitUntil } from '../../../tests/devnet/src/kit.js';
import { type Deferred, fromProgramAccounts, parseDuties, pollingSender, readPartnerFees, runOnce } from '../src/index.js';

const RPC = process.env.RPC_URL ?? '';
if (!RPC || /mainnet|devnet\.solana\.com/.test(RPC)) throw new Error('set RPC_URL to a local validator with cross_core, cross_gate, cross_settle, the DBC binary and the token metadata program loaded; this proof never targets a public cluster');
const SCALE = 1_000_000n;
const GRID = { min: 1_000_000n, tick: 100_000n, ticks: 20 };
const log = (step: string, detail: Record<string, unknown>) => console.log(JSON.stringify({ step, ...detail }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
const dbcIdl = JSON.parse(readFileSync(fileURLToPath(new URL('../../../idls/dynamic_bonding_curve.json', import.meta.url)), 'utf8'));
const dbcCoder = new BorshAccountsCoder(dbcIdl);

// The issuer's curve: 1,000,000,000 tokens, a 1% flat fee collected in the quote token, no creator share of the trading fee, migration to DAMM v2.
const design: ContinuationDesign = {
  token: { tokenBaseDecimal: TokenDecimal.SIX, tokenQuoteDecimal: TokenDecimal.SIX, totalTokenSupply: 1_000_000_000, leftover: 0 },
  fee: {
    baseFeeParams: { baseFeeMode: BaseFeeMode.FeeSchedulerLinear, feeSchedulerParam: { startingFeeBps: 100, endingFeeBps: 100, numberOfPeriod: 0, totalDuration: 0 } },
    dynamicFeeEnabled: false,
    collectFeeMode: CollectFeeMode.QuoteToken,
    creatorTradingFeePercentage: 0,
    poolCreationFee: 0,
    enableFirstSwapWithMinFee: false,
  },
  migration: { migrationOption: MigrationOption.MET_DAMM_V2, migrationFeeOption: MigrationFeeOption.FixedBps100, migrationFee: { feePercentage: 0, creatorFeePercentage: 0 } },
  liquidityDistribution: { partnerLiquidityPercentage: 0, partnerPermanentLockedLiquidityPercentage: 100, creatorLiquidityPercentage: 0, creatorPermanentLockedLiquidityPercentage: 0 },
  lockedVesting: { totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0, totalVestingDuration: 0, cliffDurationFromMigrationTime: 0 },
  activationType: ActivationType.Timestamp,
  sqrtPriceMultiples: [2, 4],
};
const schedule = [{ price: 1_000_000n, quantity: 2_000_000_000n }, { price: 1_500_000n, quantity: 2_000_000_000n }];

const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111' as Address;
const computeUnits = (units: number): Instruction => {
  const data = new Uint8Array(5);
  data[0] = 2;
  new DataView(data.buffer).setUint32(1, units, true);
  return { programAddress: COMPUTE_BUDGET, data };
};

const connection = new Connection(RPC, { commitment: 'confirmed' });
async function airdrop(to: Address, sol: number) {
  await kitRpc.requestAirdrop(to, (BigInt(sol) * 1_000_000_000n) as never).send();
  for (let i = 0; i < 40; i++) {
    if ((await kitRpc.getBalance(to, { commitment: 'confirmed' }).send()).value > 0n) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('airdrop did not land');
}

/** The pool's partner fees as Meteora's own IDL decodes them: an independent reading, not the keeper's. */
async function idlPartnerFees(pool: Address) {
  const data = Buffer.from(await accountData(pool));
  const name = ['TransferHookPool', 'VirtualPool'].find((n) => (dbcIdl.accounts as { name: string; discriminator: number[] }[]).find((a) => a.name === n)!.discriminator.every((b, i) => data[i] === b));
  if (!name) throw new Error('the pool account is neither a TransferHookPool nor a VirtualPool');
  const state = dbcCoder.decode(name, data).pool_state as Record<string, { toString(): string }>;
  return { kind: name, base: BigInt(state.partner_base_fee!.toString()), quote: BigInt(state.partner_quote_fee!.toString()), protocolQuote: BigInt(state.protocol_quote_fee!.toString()), creatorQuote: BigInt(state.creator_quote_fee!.toString()) };
}

async function swap(trader: Keypair, pool: Address, baseMint: Address, quoteIn: bigint): Promise<string> {
  const dbc = new DynamicBondingCurveClient(connection, 'confirmed');
  const poolPk = new PublicKey(pool);
  const baseMintPk = new PublicKey(baseMint);
  // The DBC SDK resolves transfer-hook accounts against placeholder accounts; resolve against the real vault and wallet.
  let leg: { source: PublicKey; destination: PublicKey; authority: PublicKey } | undefined;
  (dbc.pool as unknown as { getRemainingAccountsForTransferHook: unknown }).getRemainingAccountsForTransferHook = async (mint: PublicKey, accountTypes: unknown[] = [AccountsType.TransferHookBase]) => {
    if (!mint.equals(baseMintPk) || !leg) return { info: { slices: accountTypes.map((accountsType) => ({ accountsType, length: 0 })) }, accounts: [] };
    const keys = (await createTransferCheckedWithTransferHookInstruction(connection, leg.source, mint, leg.destination, leg.authority, 0n, 6, [], 'confirmed', TOKEN_2022_PROGRAM_ID)).keys.slice(4);
    return { info: { slices: accountTypes.map((accountsType) => ({ accountsType, length: keys.length })) }, accounts: accountTypes.flatMap(() => keys) };
  };
  const state = (await dbc.state.getPool(poolPk))!.poolState;
  leg = { source: state.baseVault, destination: getAssociatedTokenAddressSync(baseMintPk, trader.publicKey, false, TOKEN_2022_PROGRAM_ID), authority: deriveDbcPoolAuthority() };
  const tx = await dbc.pool.swap2WithTransferHook({ owner: trader.publicKey, payer: trader.publicKey, pool: poolPk, swapBaseForQuote: false, referralTokenAccount: null, swapMode: SwapMode.ExactIn, amountIn: new BN(quoteIn.toString()), minimumAmountOut: new BN(0) });
  return sendAndConfirmTransaction(connection, tx, [trader], { commitment: 'confirmed' });
}

async function main() {
  const [run, keeperWallet, feeRecipient] = await Promise.all([generateKeyPairSigner(), generateKeyPairSigner(), generateKeyPairSigner()]);
  const kpA = Keypair.generate();
  const kpB = Keypair.generate();
  const [buyerA, buyerB] = await Promise.all([createKeyPairSignerFromBytes(kpA.secretKey), createKeyPairSignerFromBytes(kpB.secretKey)]);
  for (const w of [run, keeperWallet, feeRecipient, buyerA, buyerB]) await airdrop(w.address, 30);

  const protocol = await protocolAddress();
  if (!(await fetchEncodedAccount(kitRpc, protocol)).exists) {
    await send([getInitProtocolInstruction({ admin: run, protocol, guardian: run.address, feeRecipient: feeRecipient.address, feeBps: [30, 5, 15, 30] })], run);
  }
  const quoteMint = await newMint(run, run.address);
  for (const b of [buyerA, buyerB]) await mintTo(run, quoteMint, b.address, run, 10_000_000_000n);
  await mintTo(run, quoteMint, run.address, run, 1_000_000_000n);
  log('setup', { rpc: RPC, creator: run.address, feeRecipient: feeRecipient.address, keeper: keeperWallet.address, quoteMint });

  // ---- the deferred-mint launch cross, the settler PDA as its settler
  const crossId = BigInt(Date.now());
  const cross = await crossAddress(run.address, crossId);
  const settler = await settlerAddress(cross);
  const now = await chainTime();
  const closeTs = now + 60n;
  const built = await buildCreateCross({
    creator: run, quoteMint, baseTokenProgram: TOKEN_2022_PROGRAM, quoteTokenProgram: TOKEN_2022_PROGRAM,
    crossId, kind: CrossKind.Launch, supplyMode: SupplyMode.DeferredMint, disclosure: Disclosure.Open,
    minPrice: GRID.min, tick: GRID.tick, ticks: GRID.ticks, priceScale: SCALE, openTs: now - 5n, closeTs, revealEndTs: closeTs,
    referencePrice: null, minMatched: 0n, maxImbalanceBps: null, integratorFeeBps: 20, integrator: run.address, gateMint: null,
    shards: 2, maxOrders: 16, proceedsTo: run.address, schedule, settler, settleDeadlineTs: closeTs + 3_000n, oracle: null, calendar: null,
  });
  await send([built.ensureCreatorQuote], run);
  await send([built.create], run);
  for (const s of built.shards) await send([s], run);
  const view = async () => ({ address: cross, data: getCrossDecoder().decode(await accountData(cross)) });
  for (const [i, [b, price, quantity]] of ([[buyerA, 1_500_000n, 2_500_000_000n], [buyerB, 1_100_000n, 1_000_000_000n]] as [KeyPairSigner, bigint, bigint][]).entries()) {
    await send([await buildPlaceOrder({ cross: await view(), owner: b, nonce: BigInt(i), side: OrderSide.Buy, price, quantity })], b);
  }
  await ataIx(run, run.address, quoteMint);

  // ---- close, settle, open the DBC pool at P*, bind the mint, claim, finalize
  await waitUntil(closeTs + 1n);
  for (const ix of await buildSettleBook(await view())) await send([ix], run);
  const cleared = await view();
  if (cleared.data.state !== CrossState.Cleared) throw new Error(`the cross should have cleared, not ${CrossState[cleared.data.state]}`);
  const open = await buildOpenDbcPool({ cross: cleared, creator: run, design, name: 'Opening Cross P2', symbol: 'OCP2', uri: 'https://example.invalid/p2' });
  await send([computeUnits(1_400_000), open.instruction], run);
  await send([computeUnits(1_400_000), await buildBindDbcMint(await view(), run)], run);
  for (const [i, b] of [buyerA, buyerB].entries()) await send(await buildClaim(await view(), run, b.address, BigInt(i)), run);
  await send(await buildFinalizeWithAccounts(await view(), run), run);
  const baseMint = open.addresses.baseMint;
  const pool = open.addresses.pool;
  const derived = await continuationAddresses(cross, quoteMint);
  if (derived.pool !== pool) throw new Error('the pool the adapter opened is not at the address the keeper derives');
  log('continuation', { cross, state: CrossState[(await view()).data.state], pool, baseMint, feeRecipientOfTheCross: (await view()).data.feeRecipient });

  // ---- a wallet trades on the live pool: the partner's fee accrues
  const swap1 = await swap(kpA, pool, baseMint, 50_000_000n);
  const accrued1 = await idlPartnerFees(pool);
  log('swap', { signature: swap1, poolKind: accrued1.kind, partnerBaseFee: accrued1.base, partnerQuoteFee: accrued1.quote, protocolQuoteFee: accrued1.protocolQuote, creatorQuoteFee: accrued1.creatorQuote });
  if (accrued1.quote === 0n) throw new Error('no partner fee accrued: the proof would show nothing');
  const keeperReads = readPartnerFees(await accountData(pool));
  if (!keeperReads || keeperReads.quote !== accrued1.quote || keeperReads.base !== accrued1.base) throw new Error(`the keeper reads ${JSON.stringify(keeperReads, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))} where Meteora's IDL decodes ${accrued1.base}/${accrued1.quote}`);
  log('reader', { agreesWithTheIdl: true });

  // ---- the keeper, real code, over real RPC
  const irpc = createIndexerRpc(RPC);
  const discovery = fromProgramAccounts(irpc, CROSS_CORE_PROGRAM_ADDRESS, { creators: [run.address] });
  const fetchAcc = async (a: Address) => {
    const x = await fetchEncodedAccount(irpc, a, { commitment: 'confirmed' });
    return x.exists ? x.data : null;
  };
  const clusterNow = async () => BigInt(await irpc.getBlockTime(await irpc.getSlot({ commitment: 'confirmed' }).send()).send());
  const memory = new Map<string, Deferred>();
  const sender = pollingSender(irpc, keeperWallet);
  const pass = (everySecs: number) =>
    runOnce({
      payer: keeperWallet, ...discovery, duties: parseDuties('partner-fees'), now: clusterNow, fetch: fetchAcc, send: sender, memory,
      partnerFees: { everySecs, minQuote: 1n, minBase: 1n }, accept: (c) => c.creator === run.address,
    });
  // The protocol account fixes the fee recipient of every cross made after it exists; on a validator that already holds one from an earlier run it is not this run's wallet.
  const recipient = (await view()).data.feeRecipient;
  const quoteAta = await t22Ata(recipient, quoteMint);
  const heldBefore = await tokenBalance(quoteAta).catch(() => 0n);
  const first = await pass(5);
  log('keeper-pass-1', { done: first.done.map((d) => ({ kind: d.action.kind, signature: d.signature })), failed: first.failed, skipped: first.skipped.length });
  if (first.failed.length || first.done.length !== 1) throw new Error('the keeper should have claimed once');
  const heldAfter = await tokenBalance(quoteAta);
  const after1 = await idlPartnerFees(pool);
  log('claimed', { feeRecipient: recipient, quoteBefore: heldBefore, quoteAfter: heldAfter, received: heldAfter - heldBefore, partnerQuoteFeeInPoolBefore: accrued1.quote, partnerQuoteFeeInPoolAfter: after1.quote, destinationOwnerIsTheCrossFeeRecipient: true });
  if (heldAfter - heldBefore !== accrued1.quote) throw new Error(`received ${heldAfter - heldBefore}, the pool held ${accrued1.quote} for the partner`);
  if (after1.quote !== 0n || after1.base !== 0n) throw new Error('the pool still holds a partner fee after the claim');
  // the creator's and the protocol's shares were not touched
  if (after1.creatorQuote !== accrued1.creatorQuote || after1.protocolQuote !== accrued1.protocolQuote) throw new Error('a claim moved a share that is not the partner\'s');

  // ---- idempotence and the schedule
  const second = await pass(5);
  log('keeper-pass-2', { done: second.done.length, failed: second.failed.length, note: 'inside the interval: the pool is not read again' });
  if (second.done.length || second.failed.length) throw new Error('a pass inside the interval should send nothing');
  await new Promise((r) => setTimeout(r, 6_000));
  const third = await pass(5);
  log('keeper-pass-3', { done: third.done.length, note: 'the interval has passed, the pool is empty: nothing to claim' });
  if (third.done.length || third.failed.length) throw new Error('an emptied pool should send nothing');

  // ---- more trading accrues more, and the next pass after the interval claims it
  await swap(kpB, pool, baseMint, 20_000_000n).catch(async () => swap(kpA, pool, baseMint, 20_000_000n));
  const accrued2 = await idlPartnerFees(pool);
  const heldBefore2 = await tokenBalance(quoteAta);
  await new Promise((r) => setTimeout(r, 6_000));
  const fourth = await pass(5);
  const heldAfter2 = await tokenBalance(quoteAta);
  log('keeper-pass-4', { done: fourth.done.length, failed: fourth.failed, partnerQuoteFeeAccrued: accrued2.quote, received: heldAfter2 - heldBefore2 });
  if (fourth.done.length !== 1 || heldAfter2 - heldBefore2 !== accrued2.quote || accrued2.quote === 0n) throw new Error('the second claim did not pay exactly what had accrued');
  log('summary', { totalReceivedByTheFeeRecipient: heldAfter2 - heldBefore, claims: 2 });
  void TOKEN_2022;
}

main().then(() => process.exit(0), (e) => {
  console.error(e);
  process.exit(1);
});
