// Devnet proof for ROADMAP M1 (DAMM v2 lock, vest and compounding). A real cross clears on the deployed cross_core, the
// issuer opens a COMPOUNDING DAMM v2 pool at exactly P* through the deployed cross_settle, then uses Meteora's own
// permanent_lock_position and lock_position (vesting) on the opening liquidity. Meteora's remove_liquidity is then tried on
// every part of it: the permanently locked part and the not-yet-vested part must be refused, the free part and the part that
// vests after the cliff must be paid out.
//
//   pnpm --filter @opening-cross/devnet-proofs dp:damm-lock
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BorshAccountsCoder } from '@coral-xyz/anchor';
import { Keypair } from '@solana/web3.js';
import { AccountRole, type Instruction, createKeyPairSignerFromBytes } from '@solana/kit';
import { DAMM_V2_PROGRAM_ADDRESS, DammCollectFeeMode, buildLockDammPosition, buildSeedDammV2, buildVestDammPosition, sqrtPriceQ64, vestingTotal } from '@opening-cross/adapters';
import { Evidence } from './lib.js';
import { TOKEN_2022_PROGRAM_ADDRESS, account, ata, balanceOf, chainTime, clearLaunchCross, computeLimit, crossView, fundTrader, send, sendCapturingFailure, sweep, waitUntil } from './adapter-lib.js';

const CROSS_SETTLE_PROGRAM_ADDRESS = '2EVpoks9zhL6VMCE4CryQPyzhSUSxpaGMqaDPKPyJ9WQ';
const idl = JSON.parse(readFileSync(fileURLToPath(new URL('../../../idls/cp_amm.json', import.meta.url)), 'utf8'));
const coder = new BorshAccountsCoder(idl);
const ev = new Evidence('D1-damm-lock-compounding-devnet.md', 'Devnet proof — DAMM v2 compounding pool, permanent lock and vesting (M1)', [
  'Script `tests/devnet/src/damm-lock-proof.ts`',
  `Programs: cross_settle \`${CROSS_SETTLE_PROGRAM_ADDRESS}\`, cp-amm (DAMM v2) \`${DAMM_V2_PROGRAM_ADDRESS}\` — both executable on devnet`,
]);

const u128 = (x: { toString(): string }) => BigInt(x.toString());
/** The program's own reason out of a failed simulation's logs. */
const reason = (logs: string) => {
  const parts = [/AnchorError[^"]*?Error Message: [^"]*/.exec(logs)?.[0], /Program (?!Compute)\w+ failed: [^"]*/.exec(logs)?.[0], /custom program error: 0x[0-9a-f]+/.exec(logs)?.[0]].filter(Boolean);
  return (parts.length ? parts.join(' · ') : logs.slice(logs.indexOf('"logs"'), logs.indexOf('"logs"') + 600)).trim();
};
const disc = (name: string) => createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);

async function main() {
  const c = await clearLaunchCross(ev, 1_500_000_000n);
  const cross = await crossView(c.cross);
  const pStar = c.pStar;
  const scale = cross.data.priceScale;
  const BASE = 900_000_000n;
  const QUOTE = (BASE * pStar) / scale;

  // 1. Compounding pool at exactly P*.
  const seed = await buildSeedDammV2({ cross, creator: c.creator, baseAmount: BASE, quoteAmount: QUOTE, feeBps: 100, collectFeeMode: DammCollectFeeMode.Compounding, compoundingFeeBps: 5000 });
  const seedSig = await send([computeLimit(1_400_000), seed.instruction], c.creator);
  const pool0 = coder.decode('Pool', Buffer.from((await account(seed.addresses.pool)).data));
  ev.check('compounding-pool', "the pool opens in Meteora's compounding fee mode at exactly the sqrt price of P*", pool0.collect_fee_mode === DammCollectFeeMode.Compounding && BigInt(pool0.sqrt_price.toString()) === sqrtPriceQ64(pStar, scale), `pool ${seed.addresses.pool} collect_fee_mode ${pool0.collect_fee_mode}, sqrt_price ${pool0.sqrt_price.toString()}`, seedSig);

  // 2. A real swap: in compounding mode the whole input stays in the reserves and the liquidity does not change.
  const swapIn = 5_000_000n;
  await fundTrader(c, swapIn);
  const swap: Instruction = {
    programAddress: DAMM_V2_PROGRAM_ADDRESS,
    accounts: [
      { address: seed.addresses.poolAuthority, role: AccountRole.READONLY },
      { address: seed.addresses.pool, role: AccountRole.WRITABLE },
      { address: await ata(c.trader.address, c.baseMint), role: AccountRole.WRITABLE },
      { address: await ata(c.trader.address, c.quoteMint), role: AccountRole.WRITABLE },
      { address: seed.addresses.tokenAVault, role: AccountRole.WRITABLE },
      { address: seed.addresses.tokenBVault, role: AccountRole.WRITABLE },
      { address: c.baseMint, role: AccountRole.READONLY },
      { address: c.quoteMint, role: AccountRole.READONLY },
      { address: c.trader.address, role: AccountRole.READONLY_SIGNER, signer: c.trader } as never,
      { address: TOKEN_2022_PROGRAM_ADDRESS, role: AccountRole.READONLY },
      { address: TOKEN_2022_PROGRAM_ADDRESS, role: AccountRole.READONLY },
      { address: DAMM_V2_PROGRAM_ADDRESS, role: AccountRole.READONLY },
      { address: seed.addresses.eventAuthority, role: AccountRole.READONLY },
      { address: DAMM_V2_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    ],
    data: (() => {
      const d = Buffer.alloc(24);
      disc('swap').copy(d, 0);
      d.writeBigUInt64LE(swapIn, 8);
      return new Uint8Array(d);
    })(),
  };
  const swapSig = await send([computeLimit(1_400_000), swap], c.trader);
  const pool1 = coder.decode('Pool', Buffer.from((await account(seed.addresses.pool)).data));
  ev.check('compounding-swap', 'a real swap leaves the pool liquidity unchanged and the whole base input in the reserves', u128(pool1.liquidity) === u128(pool0.liquidity) && u128(pool1.token_a_amount) === u128(pool0.token_a_amount) + swapIn, `liquidity ${pool1.liquidity.toString()} (was ${pool0.liquidity.toString()}), token A ${pool1.token_a_amount.toString()} (was ${pool0.token_a_amount.toString()} + ${swapIn})`, swapSig);

  // 3. Split the opening liquidity: 40% permanent lock, 40% vesting, 20% free.
  const posAddr = seed.addresses.position;
  const total = u128(coder.decode('Position', Buffer.from((await account(posAddr)).data)).unlocked_liquidity);
  const forever = (total * 4n) / 10n;
  const vest = (total * 4n) / 10n;
  const free = total - forever - vest;
  const stolen = await buildLockDammPosition({ cross, creator: c.trader, liquidity: forever });
  const stolenLogs = await sendCapturingFailure([computeLimit(1_400_000), stolen], c.trader);
  ev.check('lock-refuse-non-owner', 'a wallet that does not own the position NFT cannot lock it', stolenLogs.length > 0, reason(stolenLogs));
  const tooMuch = await buildLockDammPosition({ cross, creator: c.creator, liquidity: total + 1n });
  const tooMuchLogs = await sendCapturingFailure([computeLimit(1_400_000), tooMuch], c.creator);
  ev.check('lock-refuse-excess', 'locking more liquidity than the position holds is refused', tooMuchLogs.length > 0, reason(tooMuchLogs));

  const lockSig = await send([computeLimit(1_400_000), await buildLockDammPosition({ cross, creator: c.creator, liquidity: forever })], c.creator);
  const afterLock = coder.decode('Position', Buffer.from((await account(posAddr)).data));
  ev.check('permanent-lock', "Meteora's permanent_lock_position moved exactly that liquidity into the permanent lock", u128(afterLock.permanent_locked_liquidity) === forever && u128(afterLock.unlocked_liquidity) === total - forever, `locked ${afterLock.permanent_locked_liquidity.toString()} of ${total}; unlocked ${afterLock.unlocked_liquidity.toString()}`, lockSig);

  const now = await chainTime();
  const per = vest / 2n;
  const schedule = { cliffPoint: now + 60n, periodFrequency: 20n, cliffUnlockLiquidity: vest - per, liquidityPerPeriod: per, numberOfPeriod: 1 };
  if (vestingTotal(schedule) !== vest) throw new Error('schedule does not add up');
  const vesting = await createKeyPairSignerFromBytes(Keypair.generate().secretKey);
  const vestSig = await send([computeLimit(1_400_000), await buildVestDammPosition({ cross, creator: c.creator, vesting, schedule })], c.creator);
  const afterVest = coder.decode('Position', Buffer.from((await account(posAddr)).data));
  ev.check('vesting-lock', "Meteora's lock_position put exactly the scheduled liquidity under vesting; only the free part is withdrawable", u128(afterVest.vested_liquidity) === vest && u128(afterVest.unlocked_liquidity) === free && u128(afterVest.permanent_locked_liquidity) === forever, `vested ${afterVest.vested_liquidity.toString()}, permanent ${afterVest.permanent_locked_liquidity.toString()}, unlocked ${afterVest.unlocked_liquidity.toString()}; cliff in 60 s then 1 period of 20 s`, vestSig);

  // 4. Meteora's own remove_liquidity against each part.
  const removeIx = async (liquidity: bigint): Promise<Instruction> => {
    const d = Buffer.alloc(8 + 16 + 8 + 8);
    disc('remove_liquidity').copy(d, 0);
    d.writeBigUInt64LE(liquidity & 0xffff_ffff_ffff_ffffn, 8);
    d.writeBigUInt64LE(liquidity >> 64n, 16);
    return {
      programAddress: DAMM_V2_PROGRAM_ADDRESS,
      accounts: [
        { address: seed.addresses.poolAuthority, role: AccountRole.READONLY },
        { address: seed.addresses.pool, role: AccountRole.WRITABLE },
        { address: posAddr, role: AccountRole.WRITABLE },
        { address: await ata(c.creator.address, c.baseMint), role: AccountRole.WRITABLE },
        { address: await ata(c.creator.address, c.quoteMint), role: AccountRole.WRITABLE },
        { address: seed.addresses.tokenAVault, role: AccountRole.WRITABLE },
        { address: seed.addresses.tokenBVault, role: AccountRole.WRITABLE },
        { address: c.baseMint, role: AccountRole.READONLY },
        { address: c.quoteMint, role: AccountRole.READONLY },
        { address: seed.addresses.positionNftAccount, role: AccountRole.READONLY },
        { address: c.creator.address, role: AccountRole.READONLY_SIGNER, signer: c.creator } as never,
        { address: TOKEN_2022_PROGRAM_ADDRESS, role: AccountRole.READONLY },
        { address: TOKEN_2022_PROGRAM_ADDRESS, role: AccountRole.READONLY },
        { address: seed.addresses.eventAuthority, role: AccountRole.READONLY },
        { address: DAMM_V2_PROGRAM_ADDRESS, role: AccountRole.READONLY },
      ],
      data: new Uint8Array(d),
    };
  };
  const refresh = (): Instruction => ({
    programAddress: DAMM_V2_PROGRAM_ADDRESS,
    accounts: [
      { address: seed.addresses.pool, role: AccountRole.READONLY },
      { address: posAddr, role: AccountRole.WRITABLE },
      { address: seed.addresses.positionNftAccount, role: AccountRole.READONLY },
      { address: c.creator.address, role: AccountRole.READONLY },
      { address: vesting.address, role: AccountRole.WRITABLE },
    ],
    data: new Uint8Array(disc('refresh_vesting')),
  });
  const unlockedNow = async () => u128(coder.decode('Position', Buffer.from((await account(posAddr)).data)).unlocked_liquidity);

  const over = await sendCapturingFailure([computeLimit(1_400_000), refresh(), await removeIx(free + 1n)], c.creator);
  ev.check('refuse-over-free', 'removing one liquidity unit more than the free part (which would dip into the locked or unvested part) is refused', /InsufficientLiquidity/.test(over), reason(over));
  const baseBefore = await balanceOf(c.creator.address, c.baseMint);
  const freeSig = await send([computeLimit(1_400_000), await removeIx(free)], c.creator);
  ev.check('withdraw-free', 'the free part can be withdrawn and pays out tokens', (await balanceOf(c.creator.address, c.baseMint)) > baseBefore && (await unlockedNow()) === 0n, `withdrew ${free} liquidity; unlocked now ${await unlockedNow()}`, freeSig);
  const early = await sendCapturingFailure([computeLimit(1_400_000), refresh(), await removeIx(1n)], c.creator);
  ev.check('refuse-before-cliff', 'before the cliff nothing more can be withdrawn, however small', /InsufficientLiquidity/.test(early), reason(early));

  await waitUntil(schedule.cliffPoint + 2n);
  const refSig = await send([computeLimit(1_400_000), refresh()], c.creator);
  const cliffTranche = schedule.cliffUnlockLiquidity;
  ev.check('cliff-vests', 'after the cliff exactly the cliff tranche has vested', (await unlockedNow()) === cliffTranche, `unlocked ${await unlockedNow()} (expected ${cliffTranche})`, refSig);
  const outSig = await send([computeLimit(1_400_000), await removeIx(cliffTranche)], c.creator);
  const tooMuchNow = await sendCapturingFailure([computeLimit(1_400_000), await removeIx(1n)], c.creator);
  ev.check('withdraw-vested', 'the vested tranche is withdrawable and not one unit more', /InsufficientLiquidity/.test(tooMuchNow) && (await unlockedNow()) === 0n, reason(tooMuchNow), outSig);
  const final = coder.decode('Position', Buffer.from((await account(posAddr)).data));
  ev.check('permanent-still-locked', 'the permanently locked liquidity is untouched after every withdrawal', u128(final.permanent_locked_liquidity) === forever, `permanent_locked_liquidity ${final.permanent_locked_liquidity.toString()} (expected ${forever})`);

  const back = await sweep(c);
  ev.check('cost', 'leftover SOL went back to the promiser', true, `returned ${Number(back) / 1e9} SOL of ${Number(c.startLamports) / 1e9}`);
}

main().then(() => ev.write(), (e) => { console.error(e); ev.write(e); });
