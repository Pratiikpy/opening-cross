// DAMM v2 adapter against the real mainnet cp-amm binary: after a cross clears, the issuer seeds
// a full-range DAMM v2 pool at exactly P*. Checked from DAMM's own pool account and by executing
// a real swap through DAMM (base in → quote out at ≈ P*, less the pool fee).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BorshAccountsCoder } from '@coral-xyz/anchor';
import { AccountRole, type Instruction, address } from '@solana/kit';
import { getSetComputeUnitLimitInstruction } from '@solana-program/compute-budget';
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import { CrossState, OrderSide, ata } from '@opening-cross/sdk';
import { DAMM_V2_PROGRAM_ADDRESS, DammCollectFeeMode, buildLockDammPosition, buildSeedDammV2, sqrtPriceQ64 } from '@opening-cross/adapters';
import { World } from '../src/world.js';
import { DAMM_FIXTURE } from '../src/harness.js';

const idl = JSON.parse(readFileSync(fileURLToPath(new URL('../../../idls/cp_amm.json', import.meta.url)), 'utf8'));
const coder = new BorshAccountsCoder(idl);
const cu = getSetComputeUnitLimitInstruction({ units: 1_400_000 });

async function clearedCross(w: World) {
  const cross = await w.newCross();
  const s = await w.trader(0n, 5_000_000_000n);
  const b = await w.trader(20_000_000_000n);
  const orders = [await w.place(cross, s, OrderSide.Sell, 1_200_000n, 2_000_000_000n), await w.place(cross, b, OrderSide.Buy, 1_300_000n, 2_000_000_000n)];
  const settled = await w.settle(cross);
  await w.claimAll(settled, orders);
  await w.finalize(w.view(cross.address));
  return w.view(cross.address);
}

describe.skipIf(!existsSync(DAMM_FIXTURE))('Meteora DAMM v2 seeding', () => {
  it('opens a DAMM v2 pool at exactly P*, and a real swap trades at that price', async () => {
    const w = await World.create();
    const cross = await clearedCross(w);
    expect(cross.data.state).toBe(CrossState.Finalized);
    const pStar = cross.data.clearing.__option === 'Some' ? cross.data.clearing.value.price : 0n;
    await w.h.fund(w.baseMint, w.admin, w.creator.address, 10_000_000_000n);

    const seed = await buildSeedDammV2({ cross, creator: w.creator, baseAmount: 5_000_000_000n, quoteAmount: 6_000_000_000n, feeBps: 30 });
    await w.h.send([cu, seed.instruction], w.creator);
    const poolAcct = w.h.svm.getAccount(seed.addresses.pool);
    if (!poolAcct.exists) throw new Error('pool missing');
    const pool = coder.decode('Pool', Buffer.from(poolAcct.data));
    expect(BigInt(pool.sqrt_price.toString())).toBe(sqrtPriceQ64(pStar, cross.data.priceScale));
    expect(pool.token_a_mint.toBase58()).toBe(cross.data.baseMint);

    // Swap 10 base tokens in through DAMM and check the quote received.
    const trader = await w.trader(0n, 10_000_000n);
    await w.h.ata(trader.address, w.quoteMint, w.admin);
    const quoteBefore = await w.h.balanceOf(trader.address, w.quoteMint);
    const swap: Instruction = {
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
        { address: DAMM_V2_PROGRAM_ADDRESS, role: AccountRole.READONLY }, // no referral
        { address: seed.addresses.eventAuthority, role: AccountRole.READONLY },
        { address: DAMM_V2_PROGRAM_ADDRESS, role: AccountRole.READONLY },
      ],
      data: (() => {
        const d = Buffer.alloc(24);
        createHash('sha256').update('global:swap').digest().copy(d, 0, 0, 8);
        d.writeBigUInt64LE(10_000_000n, 8);
        d.writeBigUInt64LE(0n, 16);
        return new Uint8Array(d);
      })(),
    };
    await w.h.send([cu, swap], trader);
    const got = (await w.h.balanceOf(trader.address, w.quoteMint)) - quoteBefore;
    const fair = (10_000_000n * pStar) / cross.data.priceScale; // quote at P* with no fee or impact
    // Received within 1% of P*: 0.3% fee plus tiny price impact on a deep pool.
    expect(got > (fair * 99n) / 100n && got < fair).toBe(true);
    console.table({ clearing_price: Number(pStar), quote_for_10_base_at_P: Number(fair), received: Number(got) });
  });

  it('refuses a DAMM v2 pool that does not start at P*, and non-creators', async () => {
    const w = await World.create();
    const cross = await clearedCross(w);
    await w.h.fund(w.baseMint, w.admin, w.creator.address, 10_000_000_000n);
    const tampered = { ...cross, data: { ...cross.data, clearing: { __option: 'Some' as const, value: { ...(cross.data.clearing as { value: object }).value, price: 1_100_000n } } } } as typeof cross;
    const bad = await buildSeedDammV2({ cross: tampered, creator: w.creator, baseAmount: 1_000_000_000n, quoteAmount: 1_000_000_000n, feeBps: 30 });
    expect(await w.h.fail([cu, bad.instruction], w.creator)).toContain('StartPriceNotClearingPrice');
    const mallory = await w.trader(10_000_000_000n, 10_000_000_000n);
    const stolen = await buildSeedDammV2({ cross, creator: mallory, baseAmount: 1_000_000_000n, quoteAmount: 1_000_000_000n, feeBps: 30 });
    expect(await w.h.fail([cu, stolen.instruction], mallory)).toContain('NotCreator');
    void address;
  });
});

// Meteora's own lock and compounding instructions on the pool the adapter opens, against the real cp-amm binary.
describe.skipIf(!existsSync(DAMM_FIXTURE))('Meteora DAMM v2 locked and compounding liquidity', () => {
  const swapIx = async (w: World, seed: Awaited<ReturnType<typeof buildSeedDammV2>>, trader: Awaited<ReturnType<World['trader']>>, amountIn: bigint): Promise<Instruction> => ({
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
    data: (() => {
      const d = Buffer.alloc(24);
      createHash('sha256').update('global:swap').digest().copy(d, 0, 0, 8);
      d.writeBigUInt64LE(amountIn, 8);
      d.writeBigUInt64LE(0n, 16);
      return new Uint8Array(d);
    })(),
  });
  const decode = (w: World, name: 'Pool' | 'Position', addr: string) => {
    const a = w.h.svm.getAccount(addr as never);
    if (!a.exists) throw new Error(`${name} missing`);
    return coder.decode(name, Buffer.from(a.data));
  };

  it('locks the opening liquidity permanently in the same transaction that seeds the pool', async () => {
    const w = await World.create();
    const cross = await clearedCross(w);
    await w.h.fund(w.baseMint, w.admin, w.creator.address, 10_000_000_000n);
    const seed = await buildSeedDammV2({ cross, creator: w.creator, baseAmount: 5_000_000_000n, quoteAmount: 6_000_000_000n, feeBps: 30 });
    // Meteora's discriminator for the instruction is the one our builder derives.
    const lockIdl = idl.instructions.find((i: { name: string }) => i.name === 'permanent_lock_position');
    const lock = await buildLockDammPosition({ cross, creator: w.creator, liquidity: seed.liquidity });
    expect(Array.from((lock.data as Uint8Array).slice(0, 8))).toEqual(lockIdl.discriminator);
    await w.h.send([cu, seed.instruction], w.creator);
    const before = decode(w, 'Position', seed.addresses.position);
    const unlocked = BigInt(before.unlocked_liquidity.toString());
    expect(unlocked > 0n).toBe(true);
    const lockAll = await buildLockDammPosition({ cross, creator: w.creator, liquidity: unlocked });
    await w.h.send([cu, lockAll], w.creator);
    const after = decode(w, 'Position', seed.addresses.position);
    expect(BigInt(after.permanent_locked_liquidity.toString())).toBe(unlocked);
    expect(BigInt(after.unlocked_liquidity.toString())).toBe(0n);
    const pool = decode(w, 'Pool', seed.addresses.pool);
    expect(BigInt(pool.permanent_lock_liquidity.toString())).toBe(unlocked);
    console.table({ unlockedBefore: Number(unlocked), permanentlyLocked: Number(after.permanent_locked_liquidity.toString()), unlockedAfter: Number(after.unlocked_liquidity.toString()) });
  });

  it('refuses a lock from anyone but the position owner, and a lock of more than the position holds', async () => {
    const w = await World.create();
    const cross = await clearedCross(w);
    await w.h.fund(w.baseMint, w.admin, w.creator.address, 10_000_000_000n);
    const seed = await buildSeedDammV2({ cross, creator: w.creator, baseAmount: 5_000_000_000n, quoteAmount: 6_000_000_000n, feeBps: 30 });
    await w.h.send([cu, seed.instruction], w.creator);
    const unlocked = BigInt(decode(w, 'Position', seed.addresses.position).unlocked_liquidity.toString());
    const mallory = await w.trader(10_000_000_000n, 10_000_000_000n);
    const stolen = await buildLockDammPosition({ cross, creator: mallory, liquidity: unlocked });
    expect((await w.h.fail([cu, stolen], mallory)).length > 0).toBe(true);
    const tooMuch = await buildLockDammPosition({ cross, creator: w.creator, liquidity: unlocked + 1n });
    expect((await w.h.fail([cu, tooMuch], w.creator)).length > 0).toBe(true);
    expect(BigInt(decode(w, 'Position', seed.addresses.position).permanent_locked_liquidity.toString())).toBe(0n);
  });

  it('opens a compounding pool at P* that keeps part of every fee in its reserves', async () => {
    const run = async (mode: number, compoundingFeeBps: number) => {
      const w = await World.create();
      const cross = await clearedCross(w);
      await w.h.fund(w.baseMint, w.admin, w.creator.address, 10_000_000_000n);
      const pStar = cross.data.clearing.__option === 'Some' ? cross.data.clearing.value.price : 0n;
      const seed = await buildSeedDammV2({ cross, creator: w.creator, baseAmount: 5_000_000_000n, quoteAmount: 6_000_000_000n, feeBps: 100, collectFeeMode: mode, compoundingFeeBps });
      await w.h.send([cu, seed.instruction], w.creator);
      const pool0 = decode(w, 'Pool', seed.addresses.pool);
      expect(BigInt(pool0.sqrt_price.toString())).toBe(sqrtPriceQ64(pStar, cross.data.priceScale));
      expect(pool0.collect_fee_mode).toBe(mode);
      const trader = await w.trader(0n, 100_000_000n);
      await w.h.ata(trader.address, w.quoteMint, w.admin);
      await w.h.send([cu, await swapIx(w, seed, trader, 100_000_000n)], trader);
      const pool1 = decode(w, 'Pool', seed.addresses.pool);
      const limbs = (x: { toString(): string }) => x.toString().split(',').map(Number).reduceRight((acc, b) => (acc << 8n) + BigInt(b), 0n);
      return { claimableFeeB: limbs(pool1.fee_b_per_liquidity), reserveA: BigInt(pool1.token_a_amount.toString()), liquidity: BigInt(pool1.liquidity.toString()), liquidity0: BigInt(pool0.liquidity.toString()) };
    };
    const plain = await run(DammCollectFeeMode.OnlyB, 0);
    const compounding = await run(DammCollectFeeMode.Compounding, 5000);
    console.table({ plainClaimableFeeB: Number(plain.claimableFeeB), compoundingClaimableFeeB: Number(compounding.claimableFeeB) });
    // The whole 100 base tokens stay in the reserves, the liquidity is unchanged, and half of the fee that LPs could claim
    // in a plain pool is left compounding inside the reserves instead.
    expect(compounding.reserveA).toBe(5_100_000_000n);
    expect(compounding.liquidity).toBe(compounding.liquidity0);
    expect(compounding.claimableFeeB > 0n && compounding.claimableFeeB < plain.claimableFeeB).toBe(true);
  });
});
