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
import { DAMM_V2_PROGRAM_ADDRESS, buildSeedDammV2, sqrtPriceQ64 } from '@opening-cross/meteora-adapters';
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
