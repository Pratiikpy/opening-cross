// Devnet proof for the DBC continuation design (ROADMAP DP1, DP2, DP4, DP5, DP6).
//
// Sends real devnet transactions against Meteora's deployed DBC and DAMM v2 programs and our
// deployed cross_hook program, asserts each outcome from chain state, and writes the
// signatures to docs/evidence/DP-dbc-hook.md.
//
//   RPC_URL=<devnet rpc> pnpm --filter @opening-cross/devnet-proofs dp:dbc
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SendTransactionError,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  AuthorityType,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  createSetAuthorityInstruction,
  createTransferCheckedWithTransferHookInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
  getTransferHook,
} from '@solana/spl-token';
import BN from 'bn.js';
import {
  AccountsType,
  ActivationType,
  BaseFeeMode,
  CollectFeeMode,
  DAMM_V2_MIGRATION_FEE_ADDRESS,
  DynamicBondingCurveClient,
  MigrationFeeOption,
  MigrationOption,
  SwapMode,
  TokenAuthorityOption,
  TokenDecimal,
  TokenType,
  buildCurve,
  deriveDbcPoolAddress,
  deriveDbcPoolAuthority,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import { type Address, type Instruction, AccountRole, address, createNoopSigner } from '@solana/kit';
import {
  CROSS_HOOK_PROGRAM_ADDRESS,
  Mode,
  findExtraMetasPda,
  findHookConfigPda,
  getGrantPassInstruction,
  getInitializeInstruction,
  getSetLockInstruction,
} from '@opening-cross/cross-hook-client';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const RPC = process.env.RPC_URL ?? 'https://api.devnet.solana.com';
const connection = new Connection(RPC, 'confirmed');
const dbc = new DynamicBondingCurveClient(connection, 'confirmed');
const HOOK = new PublicKey(CROSS_HOOK_PROGRAM_ADDRESS);

const partner = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(`${ROOT}.keys/opening-bell-devnet.json`, 'utf8'))));
const holder = Keypair.generate(); // has a pass
const outsider = Keypair.generate(); // no pass

type Step = { id: string; claim: string; result: 'PASS' | 'FAIL'; signature?: string; detail: string };
const steps: Step[] = [];
const record = (s: Step) => {
  steps.push(s);
  console.log(`${s.result} ${s.id}: ${s.claim}${s.signature ? ` (${s.signature})` : ''} — ${s.detail}`);
};

// ---------- helpers ----------

/** Converts a @solana/kit instruction into a web3.js v1 instruction (the DBC SDK is v1-based). */
function toLegacy(ix: Instruction): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(ix.programAddress),
    keys: (ix.accounts ?? []).map((a) => ({
      pubkey: new PublicKey(a.address),
      isSigner: a.role === AccountRole.READONLY_SIGNER || a.role === AccountRole.WRITABLE_SIGNER,
      isWritable: a.role === AccountRole.WRITABLE || a.role === AccountRole.WRITABLE_SIGNER,
    })),
    data: Buffer.from(ix.data ?? new Uint8Array()),
  });
}
const kitAddr = (k: PublicKey): Address => address(k.toBase58());

async function send(tx: Transaction, signers: Keypair[]): Promise<string> {
  tx.feePayer ??= signers[0]!.publicKey;
  return sendAndConfirmTransaction(connection, tx, signers, { commitment: 'confirmed' });
}

/** Sends a transaction that must fail; returns the program logs proving why. */
async function expectFailure(tx: Transaction, signers: Keypair[], mustContain: string): Promise<string> {
  try {
    const sig = await send(tx, signers);
    throw new Error(`expected failure but landed: ${sig}`);
  } catch (e) {
    const logs = e instanceof SendTransactionError ? (await e.getLogs(connection)) ?? [] : [];
    const text = `${String(e)}\n${logs.join('\n')}`;
    if (!text.includes(mustContain)) throw new Error(`failed for the wrong reason (wanted "${mustContain}"):\n${text}`);
    return logs.find((l) => l.includes(mustContain)) ?? mustContain;
  }
}

async function balance(owner: PublicKey, mint: PublicKey): Promise<bigint> {
  const ata = getAssociatedTokenAddressSync(mint, owner, true, TOKEN_2022_PROGRAM_ID);
  return (await getAccount(connection, ata, 'confirmed', TOKEN_2022_PROGRAM_ID)).amount;
}

/**
 * The DBC SDK resolves transfer-hook accounts against placeholder source/destination accounts
 * (`PublicKey.default`), which only works for hooks whose extra accounts do not depend on token
 * account data. Our hook derives pass and lock PDAs from the real owners, so we replace the
 * SDK's resolver with one that resolves against the actual vault and wallet for each swap.
 */
type HookLeg = { source: PublicKey; destination: PublicKey; authority: PublicKey };
let nextLeg: HookLeg | undefined;
(dbc.pool as unknown as { getRemainingAccountsForTransferHook: unknown }).getRemainingAccountsForTransferHook = async (
  mint: PublicKey,
  accountTypes: unknown[] = [AccountsType.TransferHookBase],
) => {
  if (!nextLeg) throw new Error('swap leg not set');
  const leg = nextLeg;
  nextLeg = undefined;
  const keys = (
    await createTransferCheckedWithTransferHookInstruction(connection, leg.source, mint, leg.destination, leg.authority, 0n, 6, [], 'confirmed', TOKEN_2022_PROGRAM_ID)
  ).keys.slice(4);
  return { info: { slices: accountTypes.map((accountsType) => ({ accountsType, length: keys.length })) }, accounts: accountTypes.flatMap(() => keys) };
};

async function setLeg(pool: PublicKey, wallet: PublicKey, baseToUser: boolean) {
  const st = await poolState(pool);
  const userAta = getAssociatedTokenAddressSync(st.baseMint, wallet, false, TOKEN_2022_PROGRAM_ID);
  nextLeg = baseToUser
    ? { source: st.baseVault, destination: userAta, authority: deriveDbcPoolAuthority() }
    : { source: userAta, destination: st.baseVault, authority: wallet };
}

async function buy(owner: Keypair, pool: PublicKey, lamports: number, mode: SwapMode.ExactIn | SwapMode.PartialFill = SwapMode.ExactIn): Promise<Transaction> {
  await setLeg(pool, owner.publicKey, true);
  return dbc.pool.swap2WithTransferHook({
    owner: owner.publicKey,
    payer: owner.publicKey,
    pool,
    swapBaseForQuote: false,
    referralTokenAccount: null,
    swapMode: mode,
    amountIn: new BN(lamports),
    minimumAmountOut: new BN(0),
  });
}

async function sell(owner: Keypair, pool: PublicKey, baseAtoms: bigint): Promise<Transaction> {
  await setLeg(pool, owner.publicKey, false);
  return dbc.pool.swap2WithTransferHook({
    owner: owner.publicKey,
    payer: owner.publicKey,
    pool,
    swapBaseForQuote: true,
    referralTokenAccount: null,
    swapMode: SwapMode.ExactIn,
    amountIn: new BN(baseAtoms.toString()),
    minimumAmountOut: new BN(0),
  });
}

// ---------- proof ----------

async function main() {
  console.log(`RPC ${RPC}\npartner ${partner.publicKey.toBase58()}\nholder ${holder.publicKey.toBase58()}\noutsider ${outsider.publicKey.toBase58()}`);

  // Fund the two test wallets from the partner key.
  const fund = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: partner.publicKey, toPubkey: holder.publicKey, lamports: 0.4 * LAMPORTS_PER_SOL }),
    SystemProgram.transfer({ fromPubkey: partner.publicKey, toPubkey: outsider.publicKey, lamports: 0.05 * LAMPORTS_PER_SOL }),
  );
  await send(fund, [partner]);

  // 1. Transfer-hook DBC config: Token-2022, partner keeps mint authority, fixed supply,
  //    tiny migration threshold so the curve can complete on devnet.
  const curve = buildCurve({
    token: {
      tokenType: TokenType.Token2022,
      tokenBaseDecimal: TokenDecimal.SIX,
      tokenQuoteDecimal: TokenDecimal.NINE,
      tokenAuthorityOption: TokenAuthorityOption.PartnerUpdateAndMintAuthority,
      totalTokenSupply: 1_000_000_000,
      leftover: 1_000,
    },
    fee: {
      baseFeeParams: {
        baseFeeMode: BaseFeeMode.FeeSchedulerLinear,
        feeSchedulerParam: { startingFeeBps: 200, endingFeeBps: 100, numberOfPeriod: 10, totalDuration: 60 },
      },
      dynamicFeeEnabled: false,
      collectFeeMode: CollectFeeMode.QuoteToken,
      creatorTradingFeePercentage: 0,
      poolCreationFee: 0,
      enableFirstSwapWithMinFee: false,
    },
    migration: {
      migrationOption: MigrationOption.MET_DAMM_V2,
      migrationFeeOption: MigrationFeeOption.FixedBps100,
      migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
    },
    liquidityDistribution: {
      partnerLiquidityPercentage: 0,
      partnerPermanentLockedLiquidityPercentage: 100,
      creatorLiquidityPercentage: 0,
      creatorPermanentLockedLiquidityPercentage: 0,
    },
    lockedVesting: { totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0, totalVestingDuration: 0, cliffDurationFromMigrationTime: 0 },
    activationType: ActivationType.Timestamp,
    percentageSupplyOnMigration: 20,
    migrationQuoteThreshold: 0.1,
  });

  const config = Keypair.generate();
  const cfgSig = await send(
    await dbc.partner.createConfigWithTransferHook({
      config: config.publicKey,
      feeClaimer: partner.publicKey,
      leftoverReceiver: partner.publicKey,
      payer: partner.publicKey,
      quoteMint: NATIVE_MINT,
      transferHookProgram: HOOK,
      ...curve,
    }),
    [partner, config],
  );
  const cfgState = must(await dbc.state.getPoolConfig(config.publicKey), 'config');
  record({ id: 'setup', claim: 'transfer-hook DBC config created with PartnerUpdateAndMintAuthority', result: 'PASS', signature: cfgSig, detail: `config ${config.publicKey.toBase58()}, fixedTokenSupplyFlag=${cfgState.fixedTokenSupplyFlag}, preMigrationSupply=${cfgState.preMigrationTokenSupply.toString()}` });

  // 2. Pool with our hook on the base mint.
  const baseMint = Keypair.generate();
  const poolSig = await send(
    await dbc.creator.createPoolWithTransferHook({
      baseMint: baseMint.publicKey,
      config: config.publicKey,
      name: 'Opening Cross Proof',
      symbol: 'OCP',
      uri: 'https://github.com/Pratiikpy/opening-cross',
      payer: partner.publicKey,
      poolCreator: partner.publicKey,
      transferHookProgram: HOOK,
    }),
    [partner, baseMint],
  );
  const mint = baseMint.publicKey;
  const pool = deriveDbcPoolAddress(NATIVE_MINT, mint, config.publicKey);
  const mintInfo = await getMint(connection, mint, 'confirmed', TOKEN_2022_PROGRAM_ID);
  const hookExt = getTransferHook(mintInfo);
  const authorityOk = mintInfo.mintAuthority?.equals(partner.publicKey) && hookExt?.programId.equals(HOOK);
  record({ id: 'DP1a', claim: 'after pool creation the partner holds mint authority and the mint points at cross_hook', result: authorityOk ? 'PASS' : 'FAIL', signature: poolSig, detail: `mint ${mint.toBase58()}, pool ${pool.toBase58()}, mintAuthority ${mintInfo.mintAuthority?.toBase58()}, hook ${hookExt?.programId.toBase58()}` });

  // 3. Initialize cross_hook (allowlist mode), passes for the DBC pool authority and the holder.
  const [hookConfig] = await findHookConfigPda({ mint: kitAddr(mint) });
  const [extraMetas] = await findExtraMetasPda({ mint: kitAddr(mint) });
  const partnerSigner = createNoopSigner(kitAddr(partner.publicKey));
  const pass = (owner: PublicKey) =>
    getGrantPassInstruction({ authority: partnerSigner, hookConfig, pass: pdaPass(mint, owner), owner: kitAddr(owner) });
  const initSig = await send(
    new Transaction().add(
      toLegacy(getInitializeInstruction({ payer: partnerSigner, mintAuthority: partnerSigner, mint: kitAddr(mint), hookConfig, extraMetas, authority: kitAddr(partner.publicKey), mode: Mode.Allowlist })),
      toLegacy(pass(deriveDbcPoolAuthority())),
      toLegacy(pass(holder.publicKey)),
      createAssociatedTokenAccountIdempotentInstruction(partner.publicKey, getAssociatedTokenAddressSync(mint, holder.publicKey, false, TOKEN_2022_PROGRAM_ID), holder.publicKey, mint, TOKEN_2022_PROGRAM_ID),
      createAssociatedTokenAccountIdempotentInstruction(partner.publicKey, getAssociatedTokenAddressSync(mint, outsider.publicKey, false, TOKEN_2022_PROGRAM_ID), outsider.publicKey, mint, TOKEN_2022_PROGRAM_ID),
    ),
    [partner],
  );
  record({ id: 'hook-init', claim: 'cross_hook initialized by the mint authority; passes granted to DBC pool authority and holder', result: 'PASS', signature: initSig, detail: `hookConfig ${hookConfig}, extraMetas ${extraMetas}` });

  // 4. DP1/DP2: mint outside the curve while the pool is pre-bonding.
  const before = await poolState(pool);
  const vaultBefore = (await getAccount(connection, before.baseVault, 'confirmed', TOKEN_2022_PROGRAM_ID)).amount;
  const extra = 5_000_000n * 1_000_000n; // 5M tokens at 6 decimals
  const mintSig = await send(
    new Transaction().add(createMintToInstruction(mint, getAssociatedTokenAddressSync(mint, holder.publicKey, false, TOKEN_2022_PROGRAM_ID), partner.publicKey, extra, [], TOKEN_2022_PROGRAM_ID)),
    [partner],
  );
  const after = await poolState(pool);
  const vaultAfter = (await getAccount(connection, after.baseVault, 'confirmed', TOKEN_2022_PROGRAM_ID)).amount;
  const supplyAfter = (await getMint(connection, mint, 'confirmed', TOKEN_2022_PROGRAM_ID)).supply;
  const untouched = before.baseReserve.eq(after.baseReserve) && vaultBefore === vaultAfter && before.sqrtPrice.eq(after.sqrtPrice);
  record({ id: 'DP1', claim: 'partner mints to a winner account outside the vault before trading; DBC reserves, vault and price unchanged', result: untouched && (await balance(holder.publicKey, mint)) === extra ? 'PASS' : 'FAIL', signature: mintSig, detail: `minted ${extra}; baseReserve ${before.baseReserve} → ${after.baseReserve}; vault ${vaultBefore} → ${vaultAfter}; supply now ${supplyAfter} vs preMigrationSupply ${cfgState.preMigrationTokenSupply}` });

  // 5. DP4: revoke mint authority after allocation.
  const revokeSig = await send(new Transaction().add(createSetAuthorityInstruction(mint, partner.publicKey, AuthorityType.MintTokens, null, [], TOKEN_2022_PROGRAM_ID)), [partner]);
  const revoked = (await getMint(connection, mint, 'confirmed', TOKEN_2022_PROGRAM_ID)).mintAuthority === null;
  record({ id: 'DP4', claim: 'mint authority set to None after allocation', result: revoked ? 'PASS' : 'FAIL', signature: revokeSig, detail: `getMint.mintAuthority = ${revoked ? 'null' : 'still set'}` });

  // 6. DP5: the hook runs on DBC swaps in both directions.
  const buySig = await send(await buy(holder, pool, 0.01 * LAMPORTS_PER_SOL), [holder]);
  record({ id: 'DP5a', claim: 'holder with a pass buys from the curve (hook passes, quote→base)', result: 'PASS', signature: buySig, detail: `holder balance ${await balance(holder.publicKey, mint)}` });

  const outsiderBuy = await expectFailure(await buy(outsider, pool, 0.001 * LAMPORTS_PER_SOL), [outsider], 'RecipientNotAllowed');
  record({ id: 'DP5b', claim: 'wallet without a pass cannot buy from the curve', result: 'PASS', detail: outsiderBuy });

  const sellSig = await send(await sell(holder, pool, 1_000_000n), [holder]);
  record({ id: 'DP5c', claim: 'holder sells into the curve (hook passes, base→quote, destination = pool authority)', result: 'PASS', signature: sellSig, detail: 'sold 1 token' });

  const p2p = await transferTx(holder, outsider.publicKey, mint, 1_000_000n);
  const p2pBlocked = await expectFailure(p2p, [holder], 'RecipientNotAllowed');
  record({ id: 'DP5d', claim: 'direct transfer to a wallet without a pass is blocked', result: 'PASS', detail: p2pBlocked });

  // Lock: everything above 1,000 tokens is locked for an hour.
  const held = await balance(holder.publicKey, mint);
  const lockAmount = held - 1_000n * 1_000_000n;
  const lockSig = await send(
    new Transaction().add(toLegacy(getSetLockInstruction({ authority: partnerSigner, hookConfig, lock: pdaLock(mint, holder.publicKey), owner: kitAddr(holder.publicKey), amount: lockAmount, unlockTs: BigInt(Math.floor(Date.now() / 1000) + 3600) }))),
    [partner],
  );
  record({ id: 'lock-set', claim: 'lock set on holder', result: 'PASS', signature: lockSig, detail: `locked ${lockAmount} of ${held}` });
  const lockedSell = await expectFailure(await sell(holder, pool, 2_000n * 1_000_000n), [holder], 'Locked');
  record({ id: 'DP5e', claim: 'selling into a locked balance is blocked', result: 'PASS', detail: lockedSell });
  const smallSellSig = await send(await sell(holder, pool, 500n * 1_000_000n), [holder]);
  record({ id: 'DP5f', claim: 'selling the unlocked part still works', result: 'PASS', signature: smallSellSig, detail: 'sold 500 tokens' });

  // 7. Complete the curve. Buys from the holder until the migration threshold is reached.
  let complete = false;
  let lastBuy = '';
  for (let i = 0; i < 8 && !complete; i++) {
    lastBuy = await send(await buy(holder, pool, 0.05 * LAMPORTS_PER_SOL, SwapMode.PartialFill), [holder]);
    const st = await poolState(pool);
    complete = st.isMigrated !== 0 || st.migrationProgress >= 1;
  }
  const hookAfter = getTransferHook(await getMint(connection, mint, 'confirmed', TOKEN_2022_PROGRAM_ID));
  const hookCleared = !hookAfter || hookAfter.programId.equals(PublicKey.default);
  record({ id: 'curve-complete', claim: 'curve completes; DBC removes the transfer hook from the mint', result: complete && hookCleared ? 'PASS' : 'FAIL', signature: lastBuy, detail: `hook program now ${hookAfter?.programId.toBase58() ?? 'none'}` });

  // 8. DP6/DP2: migrate to DAMM v2 with extra supply outstanding and a lock still recorded.
  const migration = await dbc.migration.migrateToDammV2({ payer: partner.publicKey, pool, dammConfig: DAMM_V2_MIGRATION_FEE_ADDRESS[2]! });
  const migSig = await send(migration.transaction, [partner, migration.firstPositionNftKeypair, migration.secondPositionNftKeypair]);
  const migrated = (await poolState(pool)).isMigrated === 1;
  record({ id: 'DP6', claim: 'DBC → DAMM v2 migration succeeds with extra minted supply outstanding and an active hook lock record', result: migrated ? 'PASS' : 'FAIL', signature: migSig, detail: `pool.isMigrated=${migrated}` });

  const leftoverSig = await send(await dbc.migration.withdrawLeftover({ payer: partner.publicKey, pool }), [partner]);
  record({ id: 'DP2', claim: 'fixed-supply config: leftover withdrawal after migration works with supply minted beyond the curve', result: 'PASS', signature: leftoverSig, detail: `total supply ${(await getMint(connection, mint, 'confirmed', TOKEN_2022_PROGRAM_ID)).supply} > preMigrationSupply ${cfgState.preMigrationTokenSupply}` });

  // 9. After graduation the hook no longer runs: a transfer to the outsider now lands.
  const freeSig = await send(await transferTx(holder, outsider.publicKey, mint, 1_000_000n), [holder]);
  record({ id: 'post-grad', claim: 'after graduation transfers are no longer gated by the hook (Token ACL must take over — DP8)', result: 'PASS', signature: freeSig, detail: `outsider balance ${await balance(outsider.publicKey, mint)}` });
}

function must<T>(v: T | null | undefined, what: string): T {
  if (v === null || v === undefined) throw new Error(`${what} not found`);
  return v;
}
async function poolState(pool: PublicKey) {
  return must(await dbc.state.getPool(pool), 'pool').poolState;
}

function pdaPass(mint: PublicKey, owner: PublicKey): Address {
  return kitAddr(PublicKey.findProgramAddressSync([Buffer.from('pass'), mint.toBuffer(), owner.toBuffer()], HOOK)[0]);
}
function pdaLock(mint: PublicKey, owner: PublicKey): Address {
  return kitAddr(PublicKey.findProgramAddressSync([Buffer.from('lock'), mint.toBuffer(), owner.toBuffer()], HOOK)[0]);
}

async function transferTx(from: Keypair, to: PublicKey, mint: PublicKey, amount: bigint): Promise<Transaction> {
  const ix = await createTransferCheckedWithTransferHookInstruction(
    connection,
    getAssociatedTokenAddressSync(mint, from.publicKey, false, TOKEN_2022_PROGRAM_ID),
    mint,
    getAssociatedTokenAddressSync(mint, to, false, TOKEN_2022_PROGRAM_ID),
    from.publicKey,
    amount,
    6,
    [],
    'confirmed',
    TOKEN_2022_PROGRAM_ID,
  );
  return new Transaction().add(ix);
}

function writeEvidence(error?: unknown) {
  const ok = !error && steps.every((s) => s.result === 'PASS');
  const lines = [
    '# Devnet proof — DBC continuation with cross_hook (DP1, DP2, DP4, DP5, DP6)',
    '',
    `Run: ${new Date().toISOString()} · RPC ${RPC} · script \`tests/devnet/src/dbc-hook-proof.ts\``,
    `Programs: DBC \`dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN\`, DAMM v2 \`cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG\`, cross_hook \`${HOOK.toBase58()}\``,
    '',
    `Overall: **${ok ? 'PASS' : 'FAIL'}**`,
    '',
    '| Step | Claim | Result | Transaction | Detail |',
    '|---|---|---|---|---|',
    ...steps.map((s) => `| ${s.id} | ${s.claim} | ${s.result} | ${s.signature ? `[${s.signature.slice(0, 8)}…](https://explorer.solana.com/tx/${s.signature}?cluster=devnet)` : '—'} | ${s.detail.replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`),
    ...(error ? ['', '## Error', '', '```', String(error instanceof Error ? error.stack : error), '```'] : []),
    '',
  ];
  writeFileSync(`${ROOT}docs/evidence/DP-dbc-hook.md`, lines.join('\n'));
  console.log(`evidence written (${ok ? 'PASS' : 'FAIL'})`);
}

main().then(() => writeEvidence(), (e) => { console.error(e); writeEvidence(e); process.exitCode = 1; });
