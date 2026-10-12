// Raydium CPMM adapter against Raydium's real binaries and their real AMM config and fee-receiver accounts, once
// for the mainnet deployment and once for the devnet one (the devnet-raydium build of cross_settle, ADR-0021): the
// issuer opens a pool whose deposit ratio is P*, and a real swap through Raydium trades at that price less the 0.25% fee.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AccountRole, type Address, type Instruction, address, lamports } from '@solana/kit';
import { getSetComputeUnitLimitInstruction } from '@solana-program/compute-budget';
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import { OrderSide, ata } from '@opening-cross/sdk';
import { CROSS_SETTLE_DEVNET_RAYDIUM_PROGRAM_ADDRESS, RAYDIUM_DEVNET, RAYDIUM_MAINNET, type RaydiumDeployment, buildSeedRaydiumCpmm, raydiumAmmConfig } from '@opening-cross/adapters';
import { World } from '../src/world.js';

const FIX = fileURLToPath(new URL('../../fixtures/', import.meta.url));
const DEVNET_CROSS_SETTLE = fileURLToPath(new URL('../../../target/deploy-devnet-raydium/cross_settle.so', import.meta.url));
type Target = { name: string; deployment: RaydiumDeployment; program: string; accounts: string[]; crossSettle?: string };
const TARGETS: Target[] = [
  { name: 'mainnet deployment', deployment: RAYDIUM_MAINNET, program: `${FIX}raydium_cp_swap.so`, accounts: ['raydium_amm_config_0.json', 'raydium_create_pool_fee.json'] },
  {
    name: 'devnet deployment (cross_settle --features devnet-raydium)',
    deployment: RAYDIUM_DEVNET,
    program: `${FIX}raydium_cp_swap_devnet.so`,
    accounts: ['raydium_devnet_amm_config_0.json', 'raydium_devnet_create_pool_fee.json'],
    crossSettle: DEVNET_CROSS_SETTLE,
  },
];
const cu = getSetComputeUnitLimitInstruction({ units: 1_400_000 });

function loadAccount(w: World, file: string) {
  const j = JSON.parse(readFileSync(`${FIX}${file}`, 'utf8'));
  const data = Buffer.from(j.account.data[0], j.account.data[1]);
  w.h.svm.setAccount({ address: address(j.pubkey), data: new Uint8Array(data), executable: false, lamports: lamports(BigInt(j.account.lamports)), programAddress: address(j.account.owner), space: BigInt(data.length) });
}

async function setup(t: Target) {
  const w = await World.create();
  w.h.svm.addProgramFromFile(t.deployment.cpmmProgram, t.program);
  if (t.crossSettle) w.h.svm.addProgramFromFile(CROSS_SETTLE_DEVNET_RAYDIUM_PROGRAM_ADDRESS, t.crossSettle);
  for (const a of t.accounts) loadAccount(w, a);
  const cross = await w.newCross();
  const s = await w.trader(0n, 5_000_000_000n);
  const b = await w.trader(20_000_000_000n);
  const orders = [await w.place(cross, s, OrderSide.Sell, 1_200_000n, 2_000_000_000n), await w.place(cross, b, OrderSide.Buy, 1_300_000n, 2_000_000_000n)];
  await w.settle(cross);
  await w.claimAll(w.view(cross.address), orders);
  await w.finalize(w.view(cross.address));
  await w.h.fund(w.baseMint, w.admin, w.creator.address, 10_000_000_000n);
  return { w, cross: w.view(cross.address) };
}

for (const t of TARGETS) describe.skipIf(!existsSync(t.program) || (t.crossSettle && !existsSync(t.crossSettle)))(`Raydium CPMM seeding, ${t.name}`, () => {
  it('opens a pool priced at P* and a real swap trades there', async () => {
    const { w, cross } = await setup(t);
    const pStar = cross.data.clearing.__option === 'Some' ? cross.data.clearing.value.price : 0n;
    const seed = await buildSeedRaydiumCpmm({ cross, creator: w.creator, baseAmount: 3_000_000_000n, deployment: t.deployment });
    await w.h.send([cu, seed.instruction], w.creator);
    const a = seed.addresses;
    const vaultBase = w.h.balance(a.baseIsToken0 ? a.vault0 : a.vault1);
    const vaultQuote = w.h.balance(a.baseIsToken0 ? a.vault1 : a.vault0);
    expect(vaultBase).toBe(3_000_000_000n);
    expect(vaultQuote).toBe(seed.quoteAmount);
    expect((vaultQuote * cross.data.priceScale) / vaultBase).toBe(pStar);

    // Raydium opens trading at now + 1 at the earliest.
    w.h.setTime(cross.data.revealEndTs + 1_000n);
    const trader = await w.trader(0n, 10_000_000n);
    await w.h.ata(trader.address, w.quoteMint, w.admin);
    const before = await w.h.balanceOf(trader.address, w.quoteMint);
    const [inVault, outVault] = a.baseIsToken0 ? [a.vault0, a.vault1] : [a.vault1, a.vault0];
    const d = Buffer.alloc(24);
    createHash('sha256').update('global:swap_base_input').digest().copy(d, 0, 0, 8);
    d.writeBigUInt64LE(10_000_000n, 8);
    const ro = (x: Address) => ({ address: x, role: AccountRole.READONLY });
    const rw = (x: Address) => ({ address: x, role: AccountRole.WRITABLE });
    const swap = {
      programAddress: t.deployment.cpmmProgram,
      accounts: [
        { address: trader.address, role: AccountRole.READONLY_SIGNER, signer: trader },
        ro(a.authority),
        ro(await raydiumAmmConfig(0, t.deployment)),
        rw(a.pool),
        rw(await ata(trader.address, w.baseMint, TOKEN_2022_PROGRAM_ADDRESS)),
        rw(await ata(trader.address, w.quoteMint, TOKEN_2022_PROGRAM_ADDRESS)),
        rw(inVault),
        rw(outVault),
        ro(TOKEN_2022_PROGRAM_ADDRESS),
        ro(TOKEN_2022_PROGRAM_ADDRESS),
        ro(w.baseMint),
        ro(w.quoteMint),
        rw(a.observation),
      ],
      data: new Uint8Array(d),
    } as unknown as Instruction;
    await w.h.send([cu, swap], trader);
    const got = (await w.h.balanceOf(trader.address, w.quoteMint)) - before;
    const fair = (10_000_000n * pStar) / cross.data.priceScale;
    expect(got > (fair * 99n) / 100n && got < fair).toBe(true);
    console.table({ clearing_price: Number(pStar), quote_for_10_base_at_P: Number(fair), received: Number(got) });
  });

  it('refuses a deposit ratio away from P*, and non-creators', async () => {
    const { w, cross } = await setup(t);
    const good = await buildSeedRaydiumCpmm({ cross, creator: w.creator, baseAmount: 3_000_000_000n, deployment: t.deployment });
    const data = new Uint8Array(good.instruction.data!);
    const view = new DataView(data.buffer);
    view.setBigUint64(16, good.quoteAmount + 2n, true); // quote_amount is the second argument
    expect(await w.h.fail([cu, { ...good.instruction, data }], w.creator)).toContain('StartPriceNotClearingPrice');
    const mallory = await w.trader(10_000_000_000n, 10_000_000_000n);
    const stolen = await buildSeedRaydiumCpmm({ cross, creator: mallory, baseAmount: 1_000_000_000n, deployment: t.deployment });
    expect(await w.h.fail([cu, stolen.instruction], mallory)).toContain('NotCreator');
  });

  it('accepts only its own deployment of Raydium', async () => {
    const { w, cross } = await setup(t);
    const other = t.deployment === RAYDIUM_MAINNET ? RAYDIUM_DEVNET : RAYDIUM_MAINNET;
    const wrong = await buildSeedRaydiumCpmm({ cross, creator: w.creator, baseAmount: 3_000_000_000n, deployment: { ...other, crossSettleProgram: t.deployment.crossSettleProgram } });
    expect(await w.h.fail([cu, wrong.instruction], w.creator)).toContain('ConstraintAddress');
  });
});
