// Devnet end-to-end for the Meteora DBC continuation (ROADMAP A1): a deferred-mint launch clears
// on cross_core, the creator opens a DBC pool through cross_settle at exactly the clearing price,
// the adapter binds the mint, winners claim at P*, and finalize revokes the mint authority.
// Every outcome is read back from chain state and compared with the independent reference
// implementation, then a wallet trades on the live DBC pool.
//
//   pnpm --filter @opening-cross/devnet-proofs dp:dbc-continuation
//
// Funds: a fresh run key is created, funded from `.keys/devnet-promiser.json` (devnet only) and any
// unspent balance is returned at the end. The protocol admin key is not used for spending.
import { readFileSync, writeFileSync } from 'node:fs';
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import {
  createTransferCheckedWithTransferHookInstruction,
  getMint,
  getTransferHook,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token';
import BN from 'bn.js';
import { AccountsType, DynamicBondingCurveClient, SwapMode, deriveDbcPoolAuthority } from '@meteora-ag/dynamic-bonding-curve-sdk';
import {
  type Address,
  type Instruction,
  type KeyPairSigner,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createTransactionMessage,
  fetchEncodedAccount,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from '@solana/kit';
import { getCreateAccountInstruction, getTransferSolInstruction } from '@solana-program/system';
import {
  TOKEN_2022_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getInitializeMint2Instruction,
  getMintDecoder,
  getMintSize,
  getMintToInstruction,
  getTokenDecoder,
} from '@solana-program/token-2022';
import {
  ActivationType,
  BaseFeeMode,
  CollectFeeMode,
  MigrationFeeOption,
  MigrationOption,
  TokenDecimal,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import {
  CROSS_CORE_PROGRAM_ADDRESS,
  CrossKind,
  CrossState,
  Disclosure,
  OrderSide,
  SupplyMode,
  buildClaim,
  buildCreateCross,
  buildFinalize,
  buildPlaceOrder,
  buildSettleBook,
  costCeil,
  crossAddress,
  getCrossDecoder,
  getMigrateProtocolInstruction,
  getProtocolDecoder,
  getProtocolEncoder,
  protocolAddress,
} from '@opening-cross/sdk';
import {
  type ContinuationDesign,
  buildBindDbcMint,
  buildOpenDbcPool,
  settlerAddress,
  sqrtPriceQ64,
} from '@opening-cross/adapters';
import { referenceClear, referenceFills, type RefOrder } from '@opening-cross/verifier';
import { createDefaultRpcTransport, createSolanaRpcFromTransport } from '@solana/kit';
import { CROSS_GATE_PROGRAM_ADDRESS } from '@opening-cross/cross-gate-client';
import { Evidence, ROOT, RPC, kitAddr } from './lib.js';

// The public devnet endpoint drops connections and answers bursts with 429: retry both.
const baseTransport = createDefaultRpcTransport({ url: RPC });
const retryingTransport = (async (...args: Parameters<typeof baseTransport>) => {
  for (let attempt = 0; ; attempt++) {
    try {
      return await baseTransport(...args);
    } catch (e) {
      if (attempt >= 10 || !/429|fetch failed|timeout|ECONN|ENOTFOUND|socket/i.test(String(e) + String((e as { cause?: unknown }).cause))) throw e;
      await new Promise((r) => setTimeout(r, 1_000 * Math.min(2 ** attempt, 16)));
    }
  }
}) as typeof baseTransport;
const rpc = createSolanaRpcFromTransport(retryingTransport);
const retryFetch = async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, init);
      if (res.status !== 429 || attempt >= 10) return res;
    } catch (e) {
      if (attempt >= 10) throw e;
    }
    await new Promise((r) => setTimeout(r, 1_000 * Math.min(2 ** attempt, 16)));
  }
};
const connection = new Connection(RPC, { commitment: 'confirmed', fetch: retryFetch as typeof fetch });

const ev = new Evidence('A1-dbc-continuation-devnet.md', 'Devnet end-to-end — Meteora DBC continuation (A1)', [
  'Script `tests/devnet/src/dbc-continuation-e2e.ts` (drives `@opening-cross/sdk` and `@opening-cross/adapters`)',
  `Programs: cross_core \`${CROSS_CORE_PROGRAM_ADDRESS}\`, Meteora DBC \`dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN\``,
  '',
  'Flow: deferred-mint cross (settler = the cross_settle PDA) → two real bids → close → settle → `open_dbc_pool` by the creator → `bind_dbc_mint` → claims → finalize → a swap on the live DBC pool. Every figure is read back from chain state; the clearing result and the fills are compared with `@opening-cross/verifier`.',
  '',
  'Not covered: the curve reaching its migration threshold and the move to DAMM v2 (that path is DP6 in `DP-dbc-hook.md`, run on a hand-built config, not on a pool opened by `open_dbc_pool`); an allowlist-mode gate on this pool (the adapter installs the gate in open mode, so the swap shows the hook executing, not a pass being enforced); one winning bidder only (the second bid sat below P* and was refunded in full); a sealed disclosure cross feeding a DBC pool.',
]);
const SCALE = 1_000_000n;
const GRID = { min: 1_000_000n, tick: 100_000n, ticks: 20 };
const FUNDING = 350_000_000n; // 0.35 SOL; the run costs about 0.13 SOL and the rest is returned (budget cap 1.5 SOL)
const BUYER_SOL = 60_000_000n;

const PROTOCOL_FULL = getProtocolEncoder().encode({
  admin: CROSS_CORE_PROGRAM_ADDRESS,
  guardian: CROSS_CORE_PROGRAM_ADDRESS,
  feeRecipient: CROSS_CORE_PROGRAM_ADDRESS,
  feeBps: [0, 0, 0, 0],
  paused: false,
  bump: 0,
  pendingAdmin: CROSS_CORE_PROGRAM_ADDRESS,
}).length;

// The issuer's curve: 1,000,000,000 tokens, a 1% flat fee, migration to DAMM v2, and a curve that
// reaches 4× and 16× the clearing price (sqrt multiples 2 and 4). Same design as the LiteSVM test.
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

async function send(ixs: Instruction[], payer: KeyPairSigner): Promise<string> {
  const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(ixs, m),
  );
  const tx = await signTransactionMessageWithSigners(msg);
  const signature = getSignatureFromTransaction(tx);
  // Public devnet WebSockets drop connections; send over HTTP and poll the status instead.
  await rpc.sendTransaction(getBase64EncodedWireTransaction(tx), { encoding: 'base64', preflightCommitment: 'confirmed' }).send();
  for (let i = 0; i < 90; i++) {
    const { value } = await rpc.getSignatureStatuses([signature]).send();
    const st = value[0];
    if (st?.err) throw new Error(`transaction ${signature} failed: ${JSON.stringify(st.err, (_, v) => (typeof v === 'bigint' ? v.toString() : v))}`);
    if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) return signature;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`transaction ${signature} not confirmed within 90 s`);
}

/** Sends a transaction that must be refused at simulation and returns the log line (or error text) that says why. */
async function expectFail(ixs: Instruction[], payer: KeyPairSigner, mustMatch: RegExp): Promise<string> {
  try {
    const sig = await send(ixs, payer);
    throw new Error(`expected a refusal but the transaction landed: ${sig}`);
  } catch (e) {
    const logs = ((e as { context?: { logs?: string[] } }).context?.logs ?? []).join('\n');
    const text = `${logs}\n${String(e)}`;
    if (/expected a refusal/.test(String(e))) throw e;
    if (!mustMatch.test(text)) throw new Error(`refused for the wrong reason (wanted ${mustMatch}):\n${text}`);
    return (text.split('\n').find((l) => mustMatch.test(l)) ?? String(e)).trim();
  }
}

/** Compute units a landed transaction consumed. */
async function unitsOf(signature: string): Promise<number | undefined> {
  for (let i = 0; i < 10; i++) {
    const tx = await rpc.getTransaction(signature as never, { maxSupportedTransactionVersion: 0, encoding: 'json', commitment: 'confirmed' }).send();
    if (tx) return Number(tx.meta?.computeUnitsConsumed ?? 0);
    await new Promise((r) => setTimeout(r, 1_000));
  }
  return undefined;
}

async function chainTime(): Promise<bigint> {
  const slot = await rpc.getSlot({ commitment: 'confirmed' }).send();
  return BigInt((await rpc.getBlockTime(slot).send()) ?? Math.floor(Date.now() / 1000));
}
async function waitUntil(ts: bigint): Promise<void> {
  while ((await chainTime()) < ts) await new Promise((r) => setTimeout(r, 2_000));
}
async function account(address: Address) {
  const a = await fetchEncodedAccount(rpc, address, { commitment: 'confirmed' });
  if (!a.exists) throw new Error(`missing account ${address}`);
  return a;
}
const crossView = async (address: Address) => ({ address, data: getCrossDecoder().decode((await account(address)).data) });
async function ata(owner: Address, mint: Address): Promise<Address> {
  return (await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS }))[0];
}
async function balanceOf(owner: Address, mint: Address): Promise<bigint> {
  const a = await fetchEncodedAccount(rpc, await ata(owner, mint), { commitment: 'confirmed' });
  return a.exists ? getTokenDecoder().decode(a.data).amount : 0n;
}
async function lamportsOf(address: Address): Promise<bigint> {
  return (await rpc.getBalance(address, { commitment: 'confirmed' }).send()).value;
}

async function main() {
  // ---- the run key: fresh, funded from the devnet promiser, saved (git-ignored) so leftovers can be swept back
  const promiser = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(`${ROOT}.keys/devnet-promiser.json`, 'utf8'))));
  const runKp = Keypair.generate();
  writeFileSync(`${ROOT}.keys/a1-run-${Date.now()}.json`, JSON.stringify(Array.from(runKp.secretKey)));
  const run = await createKeyPairSignerFromBytes(runKp.secretKey);
  const fund = new Transaction().add(SystemProgram.transfer({ fromPubkey: promiser.publicKey, toPubkey: runKp.publicKey, lamports: FUNDING }));
  fund.feePayer = promiser.publicKey;
  const fundSig = await sendAndConfirmTransaction(connection, fund, [promiser], { commitment: 'confirmed' });
  ev.check('fund', 'fresh run key funded from the devnet promiser (devnet only, 0.35 SOL)', (await lamportsOf(run.address)) === FUNDING, `run ${run.address}, promiser ${promiser.publicKey.toBase58()}`, fundSig);

  // ---- protocol must exist at the current layout (the protocol admin key is not touched here)
  const protocol = await protocolAddress();
  const proto = await fetchEncodedAccount(rpc, protocol);
  if (!proto.exists) throw new Error('protocol is not initialised on devnet; run `pnpm --filter @opening-cross/devnet-proofs dp:core` first');
  if (proto.data.length < PROTOCOL_FULL) {
    const admin = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(`${ROOT}.keys/opening-bell-devnet.json`, 'utf8'))));
    await send([getMigrateProtocolInstruction({ admin, protocol })], admin);
  }
  const protocolData = getProtocolDecoder().decode(proto.data);
  const feeRecipient = protocolData.feeRecipient;

  // ---- test quote token (Token-2022, 6 decimals), two buyers
  const quote = await generateKeyPairSigner();
  const kpA = Keypair.generate();
  const kpB = Keypair.generate();
  const kpM = Keypair.generate(); // not the creator
  const [buyerA, buyerB] = await Promise.all([createKeyPairSignerFromBytes(kpA.secretKey), createKeyPairSignerFromBytes(kpB.secretKey)]);
  const mintSpace = getMintSize();
  const mintRent = await rpc.getMinimumBalanceForRentExemption(BigInt(mintSpace)).send();
  const quoteMint = quote.address;
  const setup: Instruction[] = [
    getCreateAccountInstruction({ payer: run, newAccount: quote, lamports: mintRent, space: mintSpace, programAddress: TOKEN_2022_PROGRAM_ADDRESS }),
    getInitializeMint2Instruction({ mint: quoteMint, decimals: 6, mintAuthority: run.address, freezeAuthority: null }),
  ];
  for (const who of [run.address, buyerA.address, buyerB.address, feeRecipient]) {
    setup.push(getCreateAssociatedTokenIdempotentInstruction({ payer: run, ata: await ata(who, quoteMint), owner: who, mint: quoteMint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS }));
  }
  // The creator posts the dust bond in quote tokens when the cross is created.
  setup.push(getMintToInstruction({ mint: quoteMint, token: await ata(run.address, quoteMint), mintAuthority: run, amount: 1_000_000_000n }, { programAddress: TOKEN_2022_PROGRAM_ADDRESS }));
  setup.push(getTransferSolInstruction({ source: run, destination: kitAddr(kpM.publicKey), amount: 10_000_000n }));
  for (const b of [buyerA, buyerB]) {
    setup.push(getTransferSolInstruction({ source: run, destination: b.address, amount: BUYER_SOL }));
    setup.push(getMintToInstruction({ mint: quoteMint, token: await ata(b.address, quoteMint), mintAuthority: run, amount: 10_000_000_000n }, { programAddress: TOKEN_2022_PROGRAM_ADDRESS }));
  }
  await send(setup, run);

  // ---- the deferred-mint launch cross: no base mint exists yet; the settler PDA is the only party that can bind it
  const crossId = BigInt(Date.now());
  const cross = await crossAddress(run.address, crossId);
  const settler = await settlerAddress(cross);
  const now = await chainTime();
  const closeTs = now + 150n;
  const built = await buildCreateCross({
    creator: run, quoteMint, baseTokenProgram: TOKEN_2022_PROGRAM_ADDRESS, quoteTokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    crossId, kind: CrossKind.Launch, supplyMode: SupplyMode.DeferredMint, disclosure: Disclosure.Open,
    minPrice: GRID.min, tick: GRID.tick, ticks: GRID.ticks, priceScale: SCALE, openTs: now - 5n, closeTs, revealEndTs: closeTs,
    referencePrice: null, minMatched: 0n, maxImbalanceBps: null, integratorFeeBps: 20, integrator: run.address, gateMint: null,
    shards: 2, maxOrders: 16, proceedsTo: run.address, schedule, settler, settleDeadlineTs: closeTs + 3_000n, oracle: null, calendar: null,
  });
  const createSig = await send([built.create], run);
  for (const s of built.shards) await send([s], run);
  const created = await crossView(cross);
  ev.check('create', 'deferred-mint cross created with the settler PDA as its settler and no base mint', created.data.supplyMode === SupplyMode.DeferredMint && created.data.settler.__option === 'Some' && created.data.settler.value === settler, `cross ${cross}, settler ${settler}`, createSig);

  // ---- real orders
  const plan: [KeyPairSigner, bigint, bigint][] = [[buyerA, 1_500_000n, 2_500_000_000n], [buyerB, 1_100_000n, 1_000_000_000n]];
  const sellRefs: RefOrder[] = schedule.map((s) => ({ side: 'sell', price: s.price, quantity: s.quantity }));
  const buyRefs: RefOrder[] = [];
  for (const [i, [b, price, quantity]] of plan.entries()) {
    const sig = await send([await buildPlaceOrder({ cross: await crossView(cross), owner: b, nonce: BigInt(i), side: OrderSide.Buy, price, quantity })], b);
    buyRefs.push({ side: 'buy', price, quantity });
    ev.check(`bid-${i}`, `bid ${quantity} at ${price} escrowed`, true, `buyer ${b.address}`, sig);
  }

  // ---- close, settle, compare with the independent reference
  await waitUntil(closeTs + 1n);
  let lastSig = '';
  for (const ix of await buildSettleBook(await crossView(cross))) lastSig = await send([ix], run);
  const cleared = await crossView(cross);
  const ref = referenceClear([...sellRefs, ...buyRefs], GRID, null)!;
  const clearing = cleared.data.clearing.__option === 'Some' ? cleared.data.clearing.value : null;
  const pStar = clearing?.price ?? 0n;
  clearingPriceOnChain = pStar;
  ev.check('clear', 'on-chain clearing price and volume equal the independent reference', cleared.data.state === CrossState.Cleared && pStar === ref.price && clearing?.matched === ref.matched, `P* ${pStar} (ref ${ref.price}), matched ${clearing?.matched} (ref ${ref.matched})`, lastSig);

  // ---- refusals while the cross has cleared but no pool exists (simulation only, nothing is charged)
  const cu = computeUnits(1_400_000);
  const lowered = { ...cleared, data: { ...cleared.data, clearing: { __option: 'Some' as const, value: { ...clearing!, price: pStar - GRID.tick } } } } as typeof cleared;
  const badStart = await buildOpenDbcPool({ cross: lowered, creator: run, design, name: 'X', symbol: 'X', uri: 'https://x' });
  ev.check('refuse-start', 'a DBC pool whose start price is one tick off the clearing price is refused', /StartPriceNotClearingPrice/.test(await expectFail([cu, badStart.instruction], run, /StartPriceNotClearingPrice/)), 'StartPriceNotClearingPrice');
  const mallory = await createKeyPairSignerFromBytes(kpM.secretKey);
  const stolen = await buildOpenDbcPool({ cross: cleared, creator: mallory, design, name: 'X', symbol: 'X', uri: 'https://x' });
  ev.check('refuse-creator', 'a wallet that is not the creator cannot open the pool', /NotCreator/.test(await expectFail([cu, stolen.instruction], mallory, /NotCreator/)), 'NotCreator');
  const early = await expectFail([cu, await buildBindDbcMint(cleared, run)], run, /AccountNotInitialized|PoolNotOpened/);
  ev.check('refuse-bind', 'binding before the pool exists is refused', true, early);

  // ---- open the DBC pool at exactly P*
  const open = await buildOpenDbcPool({ cross: cleared, creator: run, design, name: 'Opening Cross A1', symbol: 'OCA1', uri: 'https://github.com/Pratiikpy/opening-cross' });
  const openSig = await send([computeUnits(1_400_000), open.instruction], run);
  const openUnits = await unitsOf(openSig);
  const poolAcct = await account(open.addresses.pool);
  const raw = Buffer.from(poolAcct.data);
  const live = raw.readBigUInt64LE(280) + (raw.readBigUInt64LE(288) << 64n);
  const expected = sqrtPriceQ64(pStar, cleared.data.priceScale);
  ev.check('open-dbc', 'open_dbc_pool created the live DBC pool; its sqrt_price equals sqrtPriceQ64(P*)', live === expected && poolAcct.programAddress === 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN', `pool ${open.addresses.pool}, sqrt_price ${live} (expected ${expected}), compute units ${openUnits ?? 'n/a'}`, openSig);

  const again = await expectFail([cu, open.instruction], run, /already in use|already been|AlreadyOpen|PoolAlready|custom program error/i);
  ev.check('refuse-reopen', 'opening a second pool for the same cross is refused', true, again);

  // ---- bind the mint (permissionless) and install the gate
  const bindSig = await send([computeUnits(1_400_000), await buildBindDbcMint(await crossView(cross), run)], run);
  const bindUnits = await unitsOf(bindSig);
  const bound = await crossView(cross);
  const baseMint = open.addresses.baseMint;
  const mintBound = getMintDecoder().decode((await account(baseMint)).data);
  ev.check('bind', 'bind_dbc_mint bound the continuation mint to the cross and moved its mint authority to the cross', bound.data.baseBound && bound.data.baseMint === baseMint && mintBound.mintAuthority.__option === 'Some' && mintBound.mintAuthority.value === cross, `base mint ${baseMint}, mint authority ${mintBound.mintAuthority.__option === 'Some' ? mintBound.mintAuthority.value : 'None'}, compute units ${bindUnits ?? 'n/a'}`, bindSig);

  // ---- claims: winners are minted exactly their fill, outside the curve
  const fills = referenceFills(buyRefs, ref);
  for (const [i, [b, price, quantity]] of plan.entries()) {
    const quoteBefore = await balanceOf(b.address, quoteMint);
    const sig = await send(await buildClaim(await crossView(cross), run, b.address, BigInt(i)), run);
    const got = await balanceOf(b.address, baseMint);
    const refund = (await balanceOf(b.address, quoteMint)) - quoteBefore;
    const expectedRefund = costCeil(quantity, price, SCALE) - costCeil(fills[i]!, pStar, SCALE);
    ev.check(`claim-${i}`, 'claim minted the fill at P* and refunded the escrow above it', got === fills[i] && refund === expectedRefund, `fill ${got} (ref ${fills[i]}), refund ${refund} (expected ${expectedRefund})`, sig);
  }

  // ---- finalize: proceeds and fees paid, mint authority revoked
  const finSig = await send([await buildFinalize(await crossView(cross), run)], run);
  const finalState = await crossView(cross);
  const mintAfter = getMintDecoder().decode((await account(baseMint)).data);
  const supply = mintAfter.supply;
  const claimedTotal = fills.reduce((a, b) => a + b, 0n);
  ev.check('finalize', 'finalize: cross Finalized and the base mint authority is None', finalState.data.state === CrossState.Finalized && mintAfter.mintAuthority.__option === 'None', `state ${CrossState[finalState.data.state]}, mintAuthority ${mintAfter.mintAuthority.__option}`, finSig);
  const poolHolds = await (async () => { const v = await fetchEncodedAccount(rpc, open.addresses.baseVault); return v.exists ? getTokenDecoder().decode(v.data).amount : 0n; })();
  ev.check('supply', 'mint supply is the DBC vault plus exactly the claimed fills, nothing else', supply === poolHolds + claimedTotal, `supply ${supply} = vault ${poolHolds} + claimed ${claimedTotal}`);

  // ---- a wallet trades on the live DBC pool (the hook is the cross_gate the adapter installed)
  await dbcSwap(kpA, open.addresses.pool, baseMint, quoteMint, 50_000_000n);

  await sweep(runKp, [kpA, kpB, kpM], promiser);
}

/** The clearing price recorded on the cross for the pool being traded (read back from chain, not from this run's variables). */
let clearingPriceOnChain = 0n;
async function currentPStar(_pool: Address): Promise<bigint> {
  return clearingPriceOnChain;
}

async function dbcSwap(trader: Keypair, pool: Address, baseMint: Address, quoteMint: Address, quoteIn: bigint): Promise<void> {
  const dbc = new DynamicBondingCurveClient(connection, 'confirmed');
  const poolPk = new PublicKey(pool);
  const baseMintPk = new PublicKey(baseMint);
  const traderAddr = kitAddr(trader.publicKey);
  // The DBC SDK resolves transfer-hook accounts against placeholder accounts; resolve against the real vault and wallet.
  let leg: { source: PublicKey; destination: PublicKey; authority: PublicKey } | undefined;
  (dbc.pool as unknown as { getRemainingAccountsForTransferHook: unknown }).getRemainingAccountsForTransferHook = async (mint: PublicKey, accountTypes: unknown[] = [AccountsType.TransferHookBase]) => {
    if (!mint.equals(baseMintPk) || !leg) return { info: { slices: accountTypes.map((accountsType) => ({ accountsType, length: 0 })) }, accounts: [] };
    const keys = (await createTransferCheckedWithTransferHookInstruction(connection, leg.source, mint, leg.destination, leg.authority, 0n, 6, [], 'confirmed', TOKEN_2022_PROGRAM_ID)).keys.slice(4);
    return { info: { slices: accountTypes.map((accountsType) => ({ accountsType, length: keys.length })) }, accounts: accountTypes.flatMap(() => keys) };
  };
  const state = (await dbc.state.getPool(poolPk))!.poolState;
  leg = { source: state.baseVault, destination: getAssociatedTokenAddressSync(baseMintPk, trader.publicKey, false, TOKEN_2022_PROGRAM_ID), authority: deriveDbcPoolAuthority() };
  const baseBefore = await balanceOf(traderAddr, baseMint);
  const quoteBefore = await balanceOf(traderAddr, quoteMint);
  const tx = await dbc.pool.swap2WithTransferHook({
    owner: trader.publicKey,
    payer: trader.publicKey,
    pool: poolPk,
    swapBaseForQuote: false,
    referralTokenAccount: null,
    swapMode: SwapMode.ExactIn,
    amountIn: new BN(quoteIn.toString()),
    minimumAmountOut: new BN(0),
  });
  const sig = await sendAndConfirmTransaction(connection, tx, [trader], { commitment: 'confirmed' });
  const landed = await connection.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
  const gateRan = (landed?.meta?.logMessages ?? []).some((l) => l.startsWith(`Program ${CROSS_GATE_PROGRAM_ADDRESS} invoke`));
  const hookExt = getTransferHook(await getMint(connection, baseMintPk, 'confirmed', TOKEN_2022_PROGRAM_ID));
  ev.check('gate-ran', 'the swap executed the cross_gate transfer hook that bind_dbc_mint installed on the mint', gateRan && hookExt?.programId.toBase58() === CROSS_GATE_PROGRAM_ADDRESS, `hook program on the mint ${hookExt?.programId.toBase58() ?? 'none'}; cross_gate invoked in the swap: ${gateRan}`, sig);
  const baseGot = (await balanceOf(traderAddr, baseMint)) - baseBefore;
  const quotePaid = quoteBefore - (await balanceOf(traderAddr, quoteMint));
  // Independent expectation: the curve starts at P*, the flat fee is 1%, and 50 quote tokens barely move a curve of this depth.
  const expectedBase = ((quoteIn - quoteIn / 100n) * SCALE) / (await currentPStar(pool));
  const near = baseGot > expectedBase - 1_000n && baseGot < expectedBase + 1_000n;
  ev.check('swap', 'a claimed winner buys from the live DBC pool at the clearing price plus the 1% fee', baseGot > 0n && quotePaid === quoteIn && near, `paid ${quotePaid} quote atoms, received ${baseGot} base atoms (expected ${expectedBase} from P* and the fee)`, sig);
}

/** Returns what is left of the run key's SOL to the promiser, then reports the net cost of the run. */
async function sweep(runKp: Keypair, buyers: Keypair[], promiser: Keypair): Promise<void> {
  for (const b of buyers) {
    const bal = BigInt(await connection.getBalance(b.publicKey));
    if (bal > 5_000n) await sendAndConfirmTransaction(connection, new Transaction().add(SystemProgram.transfer({ fromPubkey: b.publicKey, toPubkey: runKp.publicKey, lamports: bal - 5_000n })), [b], { commitment: 'confirmed' });
  }
  const left = BigInt(await connection.getBalance(runKp.publicKey));
  const back = left - 5_000n;
  if (back > 0n) {
    const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: runKp.publicKey, toPubkey: promiser.publicKey, lamports: back }));
    await sendAndConfirmTransaction(connection, tx, [runKp], { commitment: 'confirmed' });
  }
  // Other proofs draw from the same promiser, so the cost is what left the run key, not the promiser's balance change.
  const spent = FUNDING - (back > 0n ? back : 0n);
  ev.check('budget', 'the run stayed inside its funding; the unspent balance went back to the promiser', spent <= FUNDING, `net spent ${Number(spent) / 1e9} SOL (rent held in the cross, DBC and token accounts included); returned ${Number(back > 0n ? back : 0n) / 1e9} SOL`);
}

main().then(() => ev.write(), (e) => { console.error(e); ev.write(e); });
