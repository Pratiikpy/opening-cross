// Shared helpers for the cross_settle adapter tests (fork S, ADR-0480 to 0499): launch a deferred-mint cross onto a
// real Meteora DBC pool inside LiteSVM, trade on it through the real binary, and read Meteora's own accounts.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import BN from 'bn.js';
import { AnchorProvider, BorshAccountsCoder, Program, Wallet } from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { AccountRole, type Address, type Instruction, type KeyPairSigner, address, createKeyPairSignerFromBytes, lamports } from '@solana/kit';
import { getCreateAccountInstruction } from '@solana-program/system';
import { getSetComputeUnitLimitInstruction } from '@solana-program/compute-budget';
import {
  TOKEN_2022_PROGRAM_ADDRESS,
  getInitializeMint2Instruction,
  getInitializePausableConfigInstruction,
  getInitializePermanentDelegateInstruction,
  getMintSize,
} from '@solana-program/token-2022';
import {
  ActivationType,
  BaseFeeMode,
  CollectFeeMode,
  DAMM_V2_MIGRATION_FEE_ADDRESS,
  DammV2DynamicFeeMode,
  MigratedCollectFeeMode,
  MigrationFeeOption,
  MigrationOption,
  TokenDecimal,
  deriveDammV2EventAuthority,
  deriveDammV2MigrationMetadataAddress,
  deriveDammV2PoolAddress,
  deriveDammV2PoolAuthority,
  deriveDammV2TokenVaultAddress,
  derivePositionAddress,
  derivePositionNftAccount,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import { type CrossView, OrderSide, SupplyMode, ata, buildClaim, crossAddress } from '@opening-cross/sdk';
import { CROSS_GATE_PROGRAM_ADDRESS } from '@opening-cross/cross-gate-client';
import {
  type ContinuationDesign,
  DBC_PROGRAM_ADDRESS,
  buildBindDbcMint,
  buildOpenDbcPool,
  buildSeedDammV2,
  DAMM_V2_PROGRAM_ADDRESS,
  continuationAddresses,
  dbcEventAuthority,
  gateConfigAddress,
  gateHookMetasAddress,
  settlerAddress,
} from '@opening-cross/adapters';
import { World } from './world.js';
import { fromLegacy } from './harness.js';

export const CU = getSetComputeUnitLimitInstruction({ units: 1_400_000 });
export const dbcIdl = JSON.parse(readFileSync(fileURLToPath(new URL('../../../idls/dynamic_bonding_curve.json', import.meta.url)), 'utf8'));
export const dbcCoder = new BorshAccountsCoder(dbcIdl);
const program = new Program(dbcIdl, new AnchorProvider(new Connection('http://127.0.0.1:1'), new Wallet(Keypair.generate()), {}));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const dbcMethods = program.methods as any;
const T22 = new PublicKey(TOKEN_2022_PROGRAM_ADDRESS);
const pk = (a: Address | string) => new PublicKey(a);

/** The issuer's curve design used across the settle tests: a flat 1% fee, a quote-fee pool, 40% of fees to the creator. */
export function defaultDesign(over: Partial<ContinuationDesign['fee']> = {}): ContinuationDesign {
  return {
    token: { tokenBaseDecimal: TokenDecimal.SIX, tokenQuoteDecimal: TokenDecimal.SIX, totalTokenSupply: 1_000_000_000, leftover: 0 },
    fee: {
      baseFeeParams: { baseFeeMode: BaseFeeMode.FeeSchedulerLinear, feeSchedulerParam: { startingFeeBps: 100, endingFeeBps: 100, numberOfPeriod: 0, totalDuration: 0 } },
      dynamicFeeEnabled: false,
      collectFeeMode: CollectFeeMode.QuoteToken,
      creatorTradingFeePercentage: 40,
      poolCreationFee: 0,
      enableFirstSwapWithMinFee: false,
      ...over,
    },
    migration: { migrationOption: MigrationOption.MET_DAMM_V2, migrationFeeOption: MigrationFeeOption.FixedBps100, migrationFee: { feePercentage: 0, creatorFeePercentage: 0 } },
    liquidityDistribution: { partnerLiquidityPercentage: 0, partnerPermanentLockedLiquidityPercentage: 100, creatorLiquidityPercentage: 0, creatorPermanentLockedLiquidityPercentage: 0 },
    lockedVesting: { totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0, totalVestingDuration: 0, cliffDurationFromMigrationTime: 0 },
    activationType: ActivationType.Timestamp,
    sqrtPriceMultiples: [2, 4],
  };
}

/**
 * The locked, compounding design (ADR-0482): the migrated DAMM v2 pool collects fees in the compounding mode, 40% of the liquidity is
 * locked for good (30% by the protocol-owned partner position, 10% by the issuer) and the other 60% vests to the issuer in four steps.
 */
export function lockedDesign(): ContinuationDesign {
  const d = defaultDesign();
  // Compounding liquidity takes a protocol fee out of the migration amounts, so the supply needs a small margin (found by DBC's own check).
  d.token.leftover = 5_000_000;
  d.migration = {
    migrationOption: MigrationOption.MET_DAMM_V2,
    migrationFeeOption: MigrationFeeOption.Customizable,
    migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
    migratedPoolFee: { collectFeeMode: MigratedCollectFeeMode.Compounding, dynamicFee: DammV2DynamicFeeMode.Disabled, poolFeeBps: 100, compoundingFeeBps: 5000 },
  };
  d.liquidityDistribution = {
    partnerLiquidityPercentage: 0,
    partnerPermanentLockedLiquidityPercentage: 30,
    creatorLiquidityPercentage: 0,
    creatorPermanentLockedLiquidityPercentage: 10,
    creatorLiquidityVestingInfoParams: { vestingPercentage: 60, bpsPerPeriod: 2500, numberOfPeriods: 4, cliffDurationFromMigrationTime: 0, totalDuration: 4 * 86_400 },
  };
  return d;
}

export const DEFAULT_SCHEDULE = [
  { price: 1_000_000n, quantity: 2_000_000_000n },
  { price: 1_500_000n, quantity: 2_000_000_000n },
];

export type Launched = {
  w: World;
  cross: CrossView;
  design: ContinuationDesign;
  addresses: Awaited<ReturnType<typeof continuationAddresses>>;
  baseMint: Address;
  winner: KeyPairSigner;
  pStar: bigint;
};

/** A deferred-mint cross that cleared at P*, opened onto a real DBC pool and bound, with one winning bidder holding base tokens. */
export async function launchDbc(w: World, design: ContinuationDesign = defaultDesign(), bindToo = true, locked = false): Promise<Launched> {
  const crossAddr = await crossAddress(w.creator.address, 1n);
  const settler = await settlerAddress(crossAddr);
  const cross = await w.newCross({ supplyMode: SupplyMode.DeferredMint, schedule: DEFAULT_SCHEDULE, settler, settleDeadlineTs: 1_800_001_000n });
  const winner = await w.trader(10_000_000_000n);
  const orders = [await w.place(cross, winner, OrderSide.Buy, 1_500_000n, 2_500_000_000n)];
  const settled = await w.settle(cross);
  const pStar = settled.data.clearing.__option === 'Some' ? settled.data.clearing.value.price : 0n;
  const open = await buildOpenDbcPool({ cross: settled, creator: w.creator, design, name: 'Proof Launch', symbol: 'PRF', uri: 'https://github.com/Pratiikpy/opening-cross', locked });
  await w.h.send([CU, open.instruction], w.creator);
  if (bindToo) {
    await w.h.send([CU, await buildBindDbcMint(w.view(cross.address), w.admin)], w.admin);
    for (const o of orders) await w.h.send(await buildClaim(w.view(cross.address), w.admin, o.owner.address, o.nonce), w.admin);
  }
  return { w, cross: w.view(cross.address), design, addresses: open.addresses, baseMint: open.addresses.baseMint, winner, pStar };
}

/** DBC's transfer-hook accounts for a base-token leg: gate config, the receiver's pass, the sender's lock, the hook program and its meta list. */
export async function hookAccounts(baseMint: Address, sourceOwner: Address, destinationOwner: Address) {
  const gate = pk(CROSS_GATE_PROGRAM_ADDRESS);
  const mint = pk(baseMint);
  const pda = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, gate)[0];
  return [
    pk(await gateConfigAddress(baseMint)),
    pda([Buffer.from('pass'), mint.toBuffer(), pk(destinationOwner).toBuffer()]),
    pda([Buffer.from('lock'), mint.toBuffer(), pk(sourceOwner).toBuffer()]),
    gate,
    pk(await gateHookMetasAddress(baseMint)),
  ].map((pubkey) => ({ pubkey, isSigner: false, isWritable: false }));
}

/** The slice description DBC wants for `n` hook accounts on the base leg. */
export const hookInfo = (n: number) => ({ slices: n === 0 ? [] : [{ accountsType: { transferHookBase: {} }, length: n }] });

/** Buys base from the live DBC pool with `quoteIn` quote atoms (exact in). */
export async function dbcBuy(l: Launched, trader: KeyPairSigner, quoteIn: bigint, swapMode = 0): Promise<Instruction> {
  const { w } = l;
  const a = l.addresses;
  await w.h.ata(trader.address, l.baseMint, w.admin);
  const extras = await hookAccounts(l.baseMint, a.poolAuthority, trader.address);
  const ix = await dbcMethods
    .swap2WithTransferHook({ amount0: new BN(quoteIn.toString()), amount1: new BN(0), swapMode }, hookInfo(extras.length))
    .accounts({
      poolAuthority: pk(a.poolAuthority),
      config: pk(a.config),
      pool: pk(a.pool),
      inputTokenAccount: pk(await ata(trader.address, w.quoteMint, TOKEN_2022_PROGRAM_ADDRESS)),
      outputTokenAccount: pk(await ata(trader.address, l.baseMint, TOKEN_2022_PROGRAM_ADDRESS)),
      baseVault: pk(a.baseVault),
      quoteVault: pk(a.quoteVault),
      baseMint: pk(l.baseMint),
      quoteMint: pk(w.quoteMint),
      payer: pk(trader.address),
      tokenBaseProgram: T22,
      tokenQuoteProgram: T22,
      referralTokenAccount: pk(DBC_PROGRAM_ADDRESS),
      eventAuthority: pk(await dbcEventAuthority()),
      program: pk(DBC_PROGRAM_ADDRESS),
    } as never)
    .remainingAccounts(extras)
    .instruction();
  return fromLegacy(ix, { [trader.address]: trader });
}

/** Reads a DBC transfer-hook pool's state with DBC's own IDL. */
export function readPool(w: World, pool: Address) {
  const acct = w.h.svm.getAccount(pool);
  if (!acct.exists) throw new Error('pool missing');
  return dbcCoder.decode('TransferHookPool', Buffer.from(acct.data)).pool_state as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export const pkAddr = (k: PublicKey): Address => address(k.toBase58());

// ------------------------------------------------------------------ DBC curve completion and migration

const FIXTURES = fileURLToPath(new URL('../../fixtures/', import.meta.url));
export const DAMM_PROGRAM_ID = new PublicKey('cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG');

/** Loads an account saved by `tests/fixtures/fetch*.sh` (`solana account --output json`). */
export function loadFixtureAccount(w: World, file: string): Address {
  const j = JSON.parse(readFileSync(`${FIXTURES}${file}`, 'utf8'));
  const data = Buffer.from(j.account.data[0], 'base64');
  w.h.svm.setAccount({ address: address(j.pubkey), data: new Uint8Array(data), executable: false, lamports: lamports(BigInt(j.account.lamports)), programAddress: address(j.account.owner), space: BigInt(data.length) });
  return address(j.pubkey);
}

export const hasMigrationFixtures = () => existsSync(`${FIXTURES}damm_v2_migration_config_2.json`);

/** DBC's SwapMode.PartialFill: swaps as much as the curve can take and keeps the rest. */
const PARTIAL_FILL = 1;

/** Buys from the pool until the curve is complete (DBC `migration_progress` reaches 1). Returns the number of swaps. */
export async function completeCurve(l: Launched, quoteChunk = 2_500_000_000_000_000n): Promise<number> {
  const { w } = l;
  const buyer = await w.trader(50_000_000_000_000_000n);
  let swaps = 0;
  while (Number(readPool(w, l.addresses.pool).migration_progress) < 1) {
    if (swaps++ > 200) throw new Error('the curve did not complete in 200 swaps');
    const ix = await dbcBuy(l, buyer, quoteChunk, PARTIAL_FILL);
    await w.h.send([CU, ix], buyer);
  }
  return swaps;
}

export type Migrated = {
  dammPool: Address;
  firstPositionNft: KeyPairSigner;
  secondPositionNft: KeyPairSigner;
  firstPosition: Address;
  secondPosition: Address;
  firstPositionNftAccount: Address;
  secondPositionNftAccount: Address;
  tokenAVault: Address;
  tokenBVault: Address;
};

/** Migrates a completed DBC pool into DAMM v2 (metadata, then the migration) with DBC's own instructions. */
export async function migrateToDammV2(l: Launched, feeOption = 2): Promise<Migrated> {
  const { w } = l;
  const a = l.addresses;
  const dammConfigAddr = loadFixtureAccount(w, `damm_v2_migration_config_${feeOption}.json`);
  const dammConfig = new PublicKey(dammConfigAddr);
  if (dammConfig.toBase58() !== DAMM_V2_MIGRATION_FEE_ADDRESS[feeOption]?.toBase58()) throw new Error('migration config fixture does not match the SDK table');
  const pool = pk(a.pool);
  const baseMint = pk(l.baseMint);
  const quoteMint = pk(w.quoteMint);
  const payer = await w.h.wallet();
  // DBC's pool authority PDA pays the rent of the DAMM v2 accounts it creates; on mainnet it holds SOL for that.
  w.h.svm.airdrop(a.poolAuthority, lamports(10_000_000_000n));
  const metadata = deriveDammV2MigrationMetadataAddress(pool);
  const create = await dbcMethods
    .migrationDammV2CreateMetadata()
    .accounts({ virtualPool: pool, config: pk(a.config), migrationMetadata: metadata, payer: pk(payer.address), systemProgram: new PublicKey('11111111111111111111111111111111'), eventAuthority: pk(await dbcEventAuthority()), program: pk(DBC_PROGRAM_ADDRESS) } as never)
    .instruction();
  await w.h.send([fromLegacy(create, { [payer.address]: payer })], payer);

  const dammPool = deriveDammV2PoolAddress(dammConfig, baseMint, quoteMint);
  const first = Keypair.generate();
  const second = Keypair.generate();
  const firstSigner = await createKeyPairSignerFromBytes(first.secretKey);
  const secondSigner = await createKeyPairSignerFromBytes(second.secretKey);
  const tokenAVault = deriveDammV2TokenVaultAddress(dammPool, baseMint);
  const tokenBVault = deriveDammV2TokenVaultAddress(dammPool, quoteMint);
  const accounts = {
    virtualPool: pool,
    migrationMetadata: metadata,
    config: pk(a.config),
    poolAuthority: pk(a.poolAuthority),
    pool: dammPool,
    firstPositionNftMint: first.publicKey,
    firstPosition: derivePositionAddress(first.publicKey),
    firstPositionNftAccount: derivePositionNftAccount(first.publicKey),
    secondPositionNftMint: second.publicKey,
    secondPosition: derivePositionAddress(second.publicKey),
    secondPositionNftAccount: derivePositionNftAccount(second.publicKey),
    dammPoolAuthority: deriveDammV2PoolAuthority(),
    ammProgram: DAMM_PROGRAM_ID,
    baseMint,
    quoteMint,
    tokenAVault,
    tokenBVault,
    baseVault: pk(a.baseVault),
    quoteVault: pk(a.quoteVault),
    payer: pk(payer.address),
    tokenBaseProgram: T22,
    tokenQuoteProgram: T22,
    token2022Program: T22,
    systemProgram: new PublicKey('11111111111111111111111111111111'),
    dammEventAuthority: deriveDammV2EventAuthority(),
  };
  const migrate = await dbcMethods.migrationDammV2().accounts(accounts as never).remainingAccounts([{ pubkey: dammConfig, isSigner: false, isWritable: false }]).instruction();
  const signers = { [payer.address]: payer, [firstSigner.address]: firstSigner, [secondSigner.address]: secondSigner };
  await w.h.send([getSetComputeUnitLimitInstruction({ units: 1_400_000 }), fromLegacy(migrate, signers)], payer, [firstSigner, secondSigner]);
  const k = (p: PublicKey) => pkAddr(p);
  return {
    dammPool: k(dammPool),
    firstPositionNft: firstSigner,
    secondPositionNft: secondSigner,
    firstPosition: k(accounts.firstPosition),
    secondPosition: k(accounts.secondPosition),
    firstPositionNftAccount: k(accounts.firstPositionNftAccount),
    secondPositionNftAccount: k(accounts.secondPositionNftAccount),
    tokenAVault: k(tokenAVault),
    tokenBVault: k(tokenBVault),
  };
}

// ------------------------------------------------------------------ DAMM v2 helpers

/** DAMM v2 `swap` on a pool the tests did not seed through the adapter: the trader pays `amountIn` of `mintIn` for the other mint. */
export async function dammSwap(m: Migrated, trader: KeyPairSigner, tokenAMint: Address, tokenBMint: Address, mintIn: Address, amountIn: bigint, hookExtras: { address: Address; role: AccountRole }[] = []): Promise<Instruction> {
  const mintOut = mintIn === tokenAMint ? tokenBMint : tokenAMint;
  const data = Buffer.alloc(24);
  createHash('sha256').update('global:swap').digest().copy(data, 0, 0, 8);
  data.writeBigUInt64LE(amountIn, 8);
  data.writeBigUInt64LE(0n, 16);
  const damm = pkAddr(DAMM_PROGRAM_ID);
  return {
    programAddress: damm,
    accounts: [
      { address: pkAddr(deriveDammV2PoolAuthority()), role: AccountRole.READONLY },
      { address: m.dammPool, role: AccountRole.WRITABLE },
      { address: await ata(trader.address, mintIn, TOKEN_2022_PROGRAM_ADDRESS), role: AccountRole.WRITABLE },
      { address: await ata(trader.address, mintOut, TOKEN_2022_PROGRAM_ADDRESS), role: AccountRole.WRITABLE },
      { address: m.tokenAVault, role: AccountRole.WRITABLE },
      { address: m.tokenBVault, role: AccountRole.WRITABLE },
      { address: tokenAMint, role: AccountRole.READONLY },
      { address: tokenBMint, role: AccountRole.READONLY },
      { address: trader.address, role: AccountRole.READONLY_SIGNER, signer: trader } as never,
      { address: TOKEN_2022_PROGRAM_ADDRESS, role: AccountRole.READONLY },
      { address: TOKEN_2022_PROGRAM_ADDRESS, role: AccountRole.READONLY },
      { address: damm, role: AccountRole.READONLY },
      { address: pkAddr(deriveDammV2EventAuthority()), role: AccountRole.READONLY },
      { address: damm, role: AccountRole.READONLY },
      ...hookExtras,
    ],
    data: new Uint8Array(data),
  } as Instruction;
}

/** DAMM v2 `swap` of base for quote on a pool the adapter seeded (token A is the base). */
export async function seededDammSwap(w: World, seed: Awaited<ReturnType<typeof buildSeedDammV2>>, trader: KeyPairSigner, amountIn: bigint): Promise<Instruction> {
  const d = Buffer.alloc(24);
  createHash('sha256').update('global:swap').digest().copy(d, 0, 0, 8);
  d.writeBigUInt64LE(amountIn, 8);
  return {
    programAddress: DAMM_V2_PROGRAM_ADDRESS,
    accounts: [
      { address: seed.addresses.poolAuthority, role: AccountRole.READONLY },
      { address: seed.addresses.pool, role: AccountRole.WRITABLE },
      { address: await ata(trader.address, w.baseMint, TOKEN_2022_PROGRAM_ADDRESS), role: AccountRole.WRITABLE },
      { address: await ata(trader.address, w.quoteMint, TOKEN_2022_PROGRAM_ADDRESS), role: AccountRole.WRITABLE },
      { address: seed.addresses.tokenAVault, role: AccountRole.WRITABLE },
      { address: seed.addresses.tokenBVault, role: AccountRole.WRITABLE },
      { address: w.baseMint, role: AccountRole.READONLY },
      { address: w.quoteMint, role: AccountRole.READONLY },
      { address: trader.address, role: AccountRole.READONLY_SIGNER, signer: trader } as never,
      { address: TOKEN_2022_PROGRAM_ADDRESS, role: AccountRole.READONLY },
      { address: TOKEN_2022_PROGRAM_ADDRESS, role: AccountRole.READONLY },
      { address: DAMM_V2_PROGRAM_ADDRESS, role: AccountRole.READONLY },
      { address: seed.addresses.eventAuthority, role: AccountRole.READONLY },
      { address: DAMM_V2_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    ],
    data: new Uint8Array(d),
  } as Instruction;
}

// ------------------------------------------------------------------ tokenized-stock-like mints

/**
 * A Token-2022 mint with the extensions every listed tokenized stock carries (`docs/evidence/DP14.md`): a pausable mint and a
 * permanent delegate. Makes it the world's quote mint, funded and with the usual associated accounts, so crosses and pools use it.
 */
export async function useStockQuoteMint(w: World): Promise<Address> {
  const mint = await (await import('@solana/kit')).generateKeyPairSigner();
  const extensions = [
    { __kind: 'PermanentDelegate' as const, delegate: w.admin.address },
    { __kind: 'PausableConfig' as const, authority: w.admin.address, paused: false },
  ];
  const space = getMintSize(extensions);
  await w.h.send(
    [
      getCreateAccountInstruction({ payer: w.admin, newAccount: mint, lamports: w.h.svm.minimumBalanceForRentExemption(BigInt(space)), space, programAddress: TOKEN_2022_PROGRAM_ADDRESS }),
      getInitializePermanentDelegateInstruction({ mint: mint.address, delegate: w.admin.address }),
      getInitializePausableConfigInstruction({ mint: mint.address, authority: w.admin.address }),
      getInitializeMint2Instruction({ mint: mint.address, decimals: 6, mintAuthority: w.admin.address, freezeAuthority: null }),
    ],
    w.admin,
  );
  w.quoteMint = mint.address;
  for (const who of [w.feeRecipient, w.integrator, w.creator]) await w.h.ata(who.address, w.quoteMint, w.admin);
  await w.h.fund(w.quoteMint, w.admin, w.creator.address, 1_000_000_000_000n);
  return mint.address;
}

/** Plants the `TokenBadge` account Meteora would issue for `mint` on the DLMM program (only Meteora can issue one on a cluster). */
export function plantDlmmTokenBadge(w: World, mint: Address, badge: Address): void {
  const data = Buffer.alloc(8 + 32 + 128);
  Buffer.from([116, 219, 204, 229, 249, 116, 255, 150]).copy(data, 0);
  new PublicKey(mint).toBuffer().copy(data, 8);
  w.h.svm.setAccount({ address: badge, data: new Uint8Array(data), executable: false, lamports: lamports(2_000_000n), programAddress: address('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo'), space: BigInt(data.length) });
}
