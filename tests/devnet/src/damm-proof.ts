// Devnet proof for ROADMAP A2 — the DAMM v2 settlement adapter. A real cross clears on the deployed cross_core, the
// issuer seeds a Meteora DAMM v2 pool at exactly P* through the deployed cross_settle, the pool is read back from
// chain, and a different wallet swaps through DAMM. The received amount is compared with an independent model of a
// full-range constant-product pool at the clearing price.
//
//   pnpm --filter @opening-cross/devnet-proofs dp:damm
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BorshAccountsCoder } from '@coral-xyz/anchor';
import { AccountRole, type Instruction } from '@solana/kit';
import { DAMM_V2_PROGRAM_ADDRESS, buildSeedDammV2, sqrtPriceQ64 } from '@opening-cross/adapters';
import { Evidence } from './lib.js';
import { getTokenDecoder } from "@solana-program/token-2022";
import { TOKEN_2022_PROGRAM_ADDRESS, sweep, account, ata, balanceOf, clearLaunchCross, computeLimit, crossView, fundTrader, lamports, send, sendExpectingFailure } from './adapter-lib.js';

/** Deployed cross_settle on devnet (Anchor.toml, `solana program show`). */
const CROSS_SETTLE_PROGRAM_ADDRESS = '2EVpoks9zhL6VMCE4CryQPyzhSUSxpaGMqaDPKPyJ9WQ';
const idl = JSON.parse(readFileSync(fileURLToPath(new URL('../../../idls/cp_amm.json', import.meta.url)), 'utf8'));
const coder = new BorshAccountsCoder(idl);
const ev = new Evidence('A2-damm-v2-devnet.md', 'Devnet proof — DAMM v2 seeding at P* (A2)', [
  'Script `tests/devnet/src/damm-proof.ts`',
  `Programs: cross_settle \`${CROSS_SETTLE_PROGRAM_ADDRESS}\`, cp-amm (DAMM v2) \`${DAMM_V2_PROGRAM_ADDRESS}\` — both executable on devnet (checked with getAccountInfo before the run)`,
]);

async function main() {
  const c = await clearLaunchCross(ev);
  const cross = await crossView(c.cross);
  const pStar = c.pStar;
  const scale = cross.data.priceScale;
  const BASE = 900_000_000n;
  const QUOTE = (BASE * pStar) / scale;

  // The program must refuse a pool that does not start at P*, and anyone but the cross creator.
  const tampered = { ...cross, data: { ...cross.data, clearing: { __option: 'Some' as const, value: { ...(cross.data.clearing as { value: object }).value, price: pStar + 100_000n } } } } as typeof cross;
  const bad = await buildSeedDammV2({ cross: tampered, creator: c.creator, baseAmount: BASE, quoteAmount: QUOTE, feeBps: 30 });
  await sendExpectingFailure([computeLimit(1_400_000), bad.instruction], c.creator, 'StartPriceNotClearingPrice');
  ev.check('refuse-wrong-price', 'a pool whose start price is not P* is refused by cross_settle', true, `tried ${(pStar + 100_000n).toString()} against P* ${pStar}: StartPriceNotClearingPrice`);
  const stolen = await buildSeedDammV2({ cross, creator: c.trader, baseAmount: BASE, quoteAmount: QUOTE, feeBps: 30 });
  await fundTrader(c, 1_000_000n);
  await sendExpectingFailure([computeLimit(1_400_000), stolen.instruction], c.trader, 'NotCreator');
  ev.check('refuse-non-creator', 'a wallet that did not create the cross cannot seed its pool', true, `trader ${c.trader.address}: NotCreator`);

  const seed = await buildSeedDammV2({ cross, creator: c.creator, baseAmount: BASE, quoteAmount: QUOTE, feeBps: 30 });
  const seedSig = await send([computeLimit(1_400_000), seed.instruction], c.creator);
  const poolAcct = await account(seed.addresses.pool);
  const pool = coder.decode('Pool', Buffer.from(poolAcct.data));
  const expectedSqrt = sqrtPriceQ64(pStar, scale);
  ev.check('pool-price', 'the DAMM pool account holds exactly the sqrt price of P*', BigInt(pool.sqrt_price.toString()) === expectedSqrt, `pool ${seed.addresses.pool} sqrt_price ${pool.sqrt_price.toString()} (expected ${expectedSqrt}); P* ${pStar}/${scale}`, seedSig);
  ev.check('pool-mints', 'token A is the launch token and token B is the quote token', pool.token_a_mint.toBase58() === c.baseMint && pool.token_b_mint.toBase58() === c.quoteMint, `A ${pool.token_a_mint.toBase58()} B ${pool.token_b_mint.toBase58()}`);
  const vaA = await tokenAmount(seed.addresses.tokenAVault);
  const vaB = await tokenAmount(seed.addresses.tokenBVault);
  ev.check('pool-reserves', 'the pool vaults hold the deposits (≥ 99.9% of both sides, never more than offered)', vaA <= BASE && vaB <= QUOTE && vaA * 1000n >= BASE * 999n && vaB * 1000n >= QUOTE * 999n, `vault A ${vaA} of ${BASE}, vault B ${vaB} of ${QUOTE}; liquidity ${pool.liquidity.toString()}`);
  const nft = getTokenDecoder().decode((await account(seed.addresses.positionNftAccount)).data);
  ev.check('position', 'the creator owns the liquidity position (the position NFT token account is owned by the creator and holds 1)', nft.owner === c.creator.address && nft.amount === 1n && nft.mint === seed.addresses.positionNftMint, `position ${seed.addresses.position}, nft account ${seed.addresses.positionNftAccount}, owner ${nft.owner}`);

  // A different wallet swaps base for quote through DAMM itself.
  const swapIn = 5_000_000n;
  await fundTrader(c, swapIn);
  const quoteBefore = await balanceOf(c.trader.address, c.quoteMint);
  const sqrtBefore = BigInt(pool.sqrt_price.toString());
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
      { address: DAMM_V2_PROGRAM_ADDRESS, role: AccountRole.READONLY }, // no referral
      { address: seed.addresses.eventAuthority, role: AccountRole.READONLY },
      { address: DAMM_V2_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    ],
    data: (() => {
      const d = Buffer.alloc(24);
      createHash('sha256').update('global:swap').digest().copy(d, 0, 0, 8);
      d.writeBigUInt64LE(swapIn, 8);
      d.writeBigUInt64LE(0n, 16);
      return new Uint8Array(d);
    })(),
  };
  const swapSig = await send([computeLimit(1_400_000), swap], c.trader);
  const got = (await balanceOf(c.trader.address, c.quoteMint)) - quoteBefore;
  const fair = (swapIn * pStar) / scale;
  ev.check('swap-near-pstar', 'a real swap pays within 1.5% of P* (0.30% fee plus the price impact of 0.55% of depth)', got > (fair * 985n) / 1000n && got < fair, `${swapIn} base in → ${got} quote out; ${fair} at exactly P*; ratio ${(Number(got) / Number(fair)).toFixed(5)}`, swapSig);

  // Independent model: full-range constant product with the pool's own liquidity, fee 30 bps.
  const L = Number(BigInt(pool.liquidity.toString())) / 2 ** 64;
  const s0 = Number(sqrtBefore) / 2 ** 64;
  const s1 = (L * s0) / (L + Number(swapIn) * s0);
  const modelOut = L * (s0 - s1);
  const modelNet = modelOut * (1 - 0.003);
  const err = Math.abs(Number(got) / modelNet - 1);
  ev.check('swap-model', 'the amount received matches an independent constant-product model within 0.05%', err < 0.0005, `received ${got}, model ${modelNet.toFixed(1)} (gross ${modelOut.toFixed(1)}, fee 30 bps), error ${(err * 100).toFixed(4)}%`);
  const after = coder.decode('Pool', Buffer.from((await account(seed.addresses.pool)).data));
  const sqrtAfter = Number(BigInt(after.sqrt_price.toString())) / 2 ** 64;
  ev.check('swap-pool-price', 'the pool price moved down to the modelled price after base was sold into it', Math.abs(sqrtAfter / s1 - 1) < 1e-4 && BigInt(after.sqrt_price.toString()) < sqrtBefore, `sqrt price ${Number(sqrtBefore) / 2 ** 64} → ${sqrtAfter} (model ${s1})`);
  const spent = c.startLamports - (await lamports(c.creator.address));
  const spent0 = spent;
  void spent0;
  const back = await sweep(c);
  ev.check('cost', 'the whole run, including rent for the cross, mints and pool, fit inside the 2 SOL cap; the remainder went back to the promiser', spent < 2_000_000_000n, `creator spent ${Number(spent - back) / 1e9} SOL, returned ${Number(back) / 1e9} SOL`);
}

async function tokenAmount(vault: string): Promise<bigint> {
  return getTokenDecoder().decode((await account(vault as never)).data).amount;
}

main().then(() => ev.write(), (e) => { console.error(e); ev.write(e); });
