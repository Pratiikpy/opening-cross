// Devnet proof for ROADMAP A4 — the Raydium CPMM settlement adapter on the devnet build of cross_settle (ADR-0021).
//
// Raydium's mainnet CPMM id is not deployed on devnet, and the mainnet-bound cross_settle accepts no other id. The
// `devnet-raydium` build of cross_settle accepts only Raydium's devnet program (DRaycpLY…) and is deployed under its own
// program id. This script establishes the facts from devnet itself, then does what a launch issuer does: a real cross
// clears at P*, the issuer seeds a Raydium pool through the adapter, and real swaps trade against it. Each figure is
// recomputed independently of the adapter code.
//
//   pnpm --filter @opening-cross/devnet-proofs dp:raydium
//   env: RPC_URL (default public devnet), FUND_LAMPORTS (default 0.45 SOL for the creator),
//        CROSS_SETTLE_DEVNET_SO (default target/deploy-devnet-raydium/cross_settle.so)
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { AccountRole, type Address, type Instruction, address, fetchEncodedAccount, getAddressDecoder } from '@solana/kit';
import { TOKEN_2022_PROGRAM_ADDRESS, getTokenDecoder, getTransferCheckedInstruction } from '@solana-program/token-2022';
import {
  CROSS_SETTLE_DEVNET_RAYDIUM_PROGRAM_ADDRESS,
  RAYDIUM_CPMM_DEVNET_PROGRAM_ADDRESS,
  RAYDIUM_CPMM_PROGRAM_ADDRESS,
  RAYDIUM_DEVNET,
  RAYDIUM_DEVNET_CREATE_POOL_FEE,
  RAYDIUM_MAINNET,
  buildSeedRaydiumCpmm,
  raydiumAmmConfig,
} from '@opening-cross/adapters';
import { ROOT, Evidence, rpc } from './lib.js';
import { ata, balanceOf, clearLaunchCross, computeLimit, crossView, fundTrader, retry, send, sendCapturingFailure, sweep } from './adapter-lib.js';

const ORIGINAL_CROSS_SETTLE = address('2EVpoks9zhL6VMCE4CryQPyzhSUSxpaGMqaDPKPyJ9WQ');
const BUILD = process.env.CROSS_SETTLE_DEVNET_SO ?? `${ROOT}target/deploy-devnet-raydium/cross_settle.so`;
const ev = new Evidence(process.env.EVIDENCE_FILE ?? 'A4-raydium-cpmm-devnet.md', 'Devnet proof — Raydium CPMM seeding (A4)', [
  'Script `tests/devnet/src/raydium-proof.ts`',
  `Program under test: cross_settle built with \`--features devnet-raydium\`, deployed on devnet under its own id \`${CROSS_SETTLE_DEVNET_RAYDIUM_PROGRAM_ADDRESS}\` (the mainnet-bound cross_settle \`${ORIGINAL_CROSS_SETTLE}\` is untouched). It CPIs only into Raydium's devnet CPMM \`${RAYDIUM_CPMM_DEVNET_PROGRAM_ADDRESS}\`.`,
  'Real cross on the deployed cross_core, cleared against the independent reference; the pool is seeded through the adapter; swaps are made by a second wallet and every figure is recomputed from Raydium\'s published formulas.',
]);

const TRADE_FEE_RATE_DENOMINATOR = 1_000_000n;
const tokenAmount = async (a: Address): Promise<bigint> => {
  const acc = await retry(() => fetchEncodedAccount(rpc, a, { commitment: 'confirmed' }));
  return acc.exists ? getTokenDecoder().decode(acc.data).amount : 0n;
};
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/**
 * What the curve sees: each vault less the fees Raydium has accrued in it (protocol, fund and creator fees,
 * PoolState in raydium-cp-swap programs/cp-swap/src/states/pool.rs; the struct is packed, so the offsets are fixed).
 */
async function curveReserves(pool: Address, vault0: Address, vault1: Address): Promise<[bigint, bigint]> {
  const p = await retry(() => fetchEncodedAccount(rpc, pool, { commitment: 'confirmed' }));
  if (!p.exists) throw new Error('pool state missing');
  const dv = new DataView(p.data.buffer, p.data.byteOffset, p.data.byteLength);
  const u64 = (o: number) => dv.getBigUint64(o, true);
  const fees0 = u64(341) + u64(357) + u64(397);
  const fees1 = u64(349) + u64(365) + u64(405);
  return [(await tokenAmount(vault0)) - fees0, (await tokenAmount(vault1)) - fees1];
}

/** Raydium's `swap_base_input` output: the trade fee is charged on the input (rounded up), then constant product. */
function expectedOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint, tradeFeeRate: bigint): bigint {
  const fee = (amountIn * tradeFeeRate + TRADE_FEE_RATE_DENOMINATOR - 1n) / TRADE_FEE_RATE_DENOMINATOR;
  const net = amountIn - fee;
  return (net * reserveOut) / (reserveIn + net);
}

async function main() {
  // ---- facts read from devnet
  const raydium = await retry(() => fetchEncodedAccount(rpc, RAYDIUM_CPMM_DEVNET_PROGRAM_ADDRESS, { commitment: 'confirmed' }));
  ev.check('raydium-devnet-program', `Raydium's devnet CPMM ${RAYDIUM_CPMM_DEVNET_PROGRAM_ADDRESS} is a deployed program`, raydium.exists && raydium.executable, raydium.exists ? `executable=${raydium.executable}, owner ${raydium.programAddress}` : 'absent');
  const mainnetId = await retry(() => fetchEncodedAccount(rpc, RAYDIUM_CPMM_PROGRAM_ADDRESS, { commitment: 'confirmed' }));
  ev.check('raydium-mainnet-id-absent', `Raydium's mainnet id ${RAYDIUM_CPMM_PROGRAM_ADDRESS} is not a program on devnet (why the separate build exists)`, !(mainnetId.exists && mainnetId.executable), mainnetId.exists ? `exists, executable=${mainnetId.executable}` : 'no account');
  const cfgAddress = await raydiumAmmConfig(0, RAYDIUM_DEVNET);
  const cfg = await retry(() => fetchEncodedAccount(rpc, cfgAddress, { commitment: 'confirmed' }));
  let tradeFeeRate = 0n;
  let createPoolFee = 0n;
  if (cfg.exists) {
    const dv = new DataView(cfg.data.buffer, cfg.data.byteOffset, cfg.data.byteLength);
    tradeFeeRate = dv.getBigUint64(12, true);
    createPoolFee = dv.getBigUint64(36, true);
  }
  ev.check('amm-config', `AMM config index 0 ${cfgAddress} exists under Raydium's devnet program and allows pool creation`, cfg.exists && cfg.programAddress === RAYDIUM_CPMM_DEVNET_PROGRAM_ADDRESS && cfg.data[9] === 0, cfg.exists ? `trade fee ${tradeFeeRate}/1,000,000, pool-creation fee ${Number(createPoolFee) / 1e9} SOL, disable_create_pool=${cfg.data[9]}` : 'absent');
  const feeReceiver = await retry(() => fetchEncodedAccount(rpc, RAYDIUM_DEVNET_CREATE_POOL_FEE, { commitment: 'confirmed' }));
  ev.check('fee-receiver', `the pool-creation fee receiver ${RAYDIUM_DEVNET_CREATE_POOL_FEE} (the \`devnet\` build's constant) exists`, feeReceiver.exists, feeReceiver.exists ? `owner ${feeReceiver.programAddress}` : 'absent');

  // ---- the deployed devnet-raydium cross_settle is the binary that was built and tested
  const settle = await retry(() => fetchEncodedAccount(rpc, CROSS_SETTLE_DEVNET_RAYDIUM_PROGRAM_ADDRESS, { commitment: 'confirmed' }));
  ev.check('settle-deployed', `cross_settle (devnet-raydium) ${CROSS_SETTLE_DEVNET_RAYDIUM_PROGRAM_ADDRESS} is a deployed program`, settle.exists && settle.executable, settle.exists ? `executable=${settle.executable}, owner ${settle.programAddress}` : 'absent');
  if (!(settle.exists && settle.executable)) throw new Error('cross_settle (devnet-raydium) is not deployed: run the deploy first (docs/evidence/A4-raydium-cpmm-devnet.md, "Deploy")');
  const local = new Uint8Array(readFileSync(BUILD));
  let chainBytes: Uint8Array;
  if (settle.programAddress === 'BPFLoaderUpgradeab1e11111111111111111111111') {
    const programData = getAddressDecoder().decode(settle.data.slice(4, 36));
    const pd = await retry(() => fetchEncodedAccount(rpc, programData, { commitment: 'confirmed' }));
    if (!pd.exists) throw new Error('program data account missing');
    chainBytes = pd.data.slice(45, 45 + local.length);
  } else {
    chainBytes = settle.data.slice(0, local.length);
  }
  ev.check('settle-bytes', 'the bytes deployed on devnet equal the local `--features devnet-raydium` build', sha256(chainBytes) === sha256(local), `sha256 on chain ${sha256(chainBytes).slice(0, 16)}…, local ${sha256(local).slice(0, 16)}… (${local.length} bytes)`);

  // ---- a real cross, cleared and finalised
  const c = await clearLaunchCross(ev, BigInt(process.env.FUND_LAMPORTS ?? 450_000_000));
  const cross = await crossView(c.cross);
  const scale = cross.data.priceScale;

  // ---- refusals (rejected at simulation, no fee taken)
  const baseAmount = 500_000_000n; // 500 tokens
  const good = await buildSeedRaydiumCpmm({ cross, creator: c.creator, baseAmount, deployment: RAYDIUM_DEVNET });
  const expectedQuote = (baseAmount * c.pStar) / scale;
  ev.check('quote-amount', 'the adapter prices the deposits at P*: quote = floor(base · P* / scale)', good.quoteAmount === expectedQuote, `base ${baseAmount}, P* ${c.pStar}, scale ${scale} → quote ${good.quoteAmount}`);

  const skewed = new Uint8Array(good.instruction.data!);
  new DataView(skewed.buffer, skewed.byteOffset).setBigUint64(16, good.quoteAmount + 2n, true); // quote_amount is the second u64 argument
  const t1 = await sendCapturingFailure([computeLimit(1_400_000), { ...good.instruction, data: skewed }], c.creator);
  ev.check('refuse-wrong-ratio', 'a deposit ratio two quote atoms away from P* is refused (StartPriceNotClearingPrice)', /StartPriceNotClearingPrice/.test(t1), t1.replace(/\s+/g, ' ').slice(0, 300));

  const thief = await buildSeedRaydiumCpmm({ cross, creator: c.trader, baseAmount: 1_000_000n, deployment: RAYDIUM_DEVNET });
  const t2 = await sendCapturingFailure([computeLimit(1_400_000), thief.instruction], c.trader);
  ev.check('refuse-non-creator', 'a wallet that is not the cross creator cannot seed the pool (NotCreator)', /NotCreator/.test(t2), t2.replace(/\s+/g, ' ').slice(0, 300));

  const wrongRaydium = await buildSeedRaydiumCpmm({ cross, creator: c.creator, baseAmount, deployment: { ...RAYDIUM_MAINNET, crossSettleProgram: CROSS_SETTLE_DEVNET_RAYDIUM_PROGRAM_ADDRESS } });
  const t3 = await sendCapturingFailure([computeLimit(1_400_000), wrongRaydium.instruction], c.creator);
  ev.check('refuse-mainnet-raydium-id', 'the devnet build refuses Raydium\'s mainnet program id (ConstraintAddress on raydium_program)', /raydium_program|ConstraintAddress|2012/.test(t3), t3.replace(/\s+/g, ' ').slice(0, 300));

  const viaOriginal = await buildSeedRaydiumCpmm({ cross, creator: c.creator, baseAmount, deployment: { ...RAYDIUM_DEVNET, crossSettleProgram: ORIGINAL_CROSS_SETTLE } });
  const t4 = await sendCapturingFailure([computeLimit(1_400_000), viaOriginal.instruction], c.creator);
  ev.check('mainnet-bound-binary-refuses-devnet-raydium', 'the mainnet-bound cross_settle (unchanged) still refuses Raydium\'s devnet id — the reason for the separate build', /raydium_program|ConstraintAddress|2012/.test(t4), t4.replace(/\s+/g, ' ').slice(0, 300));

  // ---- seed the pool
  const baseBefore = await balanceOf(c.creator.address, c.baseMint);
  const seedSig = await send([computeLimit(1_400_000), good.instruction], c.creator);
  const a = good.addresses;
  const vaultBase = await tokenAmount(a.baseIsToken0 ? a.vault0 : a.vault1);
  const vaultQuote = await tokenAmount(a.baseIsToken0 ? a.vault1 : a.vault0);
  ev.check('seed-deposits', 'Raydium\'s vaults hold exactly the two deposits the adapter sent', vaultBase === baseAmount && vaultQuote === good.quoteAmount, `vault base ${vaultBase}, vault quote ${vaultQuote}; creator base ${baseBefore} → ${await balanceOf(c.creator.address, c.baseMint)}`, seedSig);
  const opening = (vaultQuote * scale) / vaultBase;
  ev.check('opening-price', 'the pool\'s opening price (quote per base from the vaults) equals P* to within one quote atom of the deposit', vaultQuote - (c.pStar * vaultBase) / scale >= 0n && vaultQuote - (c.pStar * vaultBase) / scale <= 1n, `vault ratio ${opening} (P* ${c.pStar}), pool ${a.pool}`, seedSig);

  // Raydium opens trading at the first second after the pool's creation block.
  await new Promise((r) => setTimeout(r, 4_000));

  // ---- real swaps by a second wallet
  await fundTrader(c, 40_000_000n);
  await send(
    [getTransferCheckedInstruction({ source: await ata(c.creator.address, c.quoteMint), mint: c.quoteMint, destination: await ata(c.trader.address, c.quoteMint), authority: c.creator, amount: 60_000_000n, decimals: 6 }, { programAddress: TOKEN_2022_PROGRAM_ADDRESS })],
    c.creator,
  );
  const swap = async (baseIn: boolean, amountIn: bigint): Promise<{ sig: string; got: bigint; reserveIn: bigint; reserveOut: bigint }> => {
    const inMint = baseIn ? c.baseMint : c.quoteMint;
    const outMint = baseIn ? c.quoteMint : c.baseMint;
    const inVault = baseIn === a.baseIsToken0 ? a.vault0 : a.vault1;
    const outVault = baseIn === a.baseIsToken0 ? a.vault1 : a.vault0;
    const [r0, r1] = await curveReserves(a.pool, a.vault0, a.vault1);
    const [reserveIn, reserveOut] = baseIn === a.baseIsToken0 ? [r0, r1] : [r1, r0];
    const before = await balanceOf(c.trader.address, outMint);
    const d = Buffer.alloc(24);
    createHash('sha256').update('global:swap_base_input').digest().copy(d, 0, 0, 8);
    d.writeBigUInt64LE(amountIn, 8);
    const ro = (x: Address) => ({ address: x, role: AccountRole.READONLY });
    const rw = (x: Address) => ({ address: x, role: AccountRole.WRITABLE });
    const ix = {
      programAddress: RAYDIUM_CPMM_DEVNET_PROGRAM_ADDRESS,
      accounts: [
        { address: c.trader.address, role: AccountRole.READONLY_SIGNER, signer: c.trader },
        ro(a.authority),
        ro(cfgAddress),
        rw(a.pool),
        rw(await ata(c.trader.address, inMint)),
        rw(await ata(c.trader.address, outMint)),
        rw(inVault),
        rw(outVault),
        ro(TOKEN_2022_PROGRAM_ADDRESS),
        ro(TOKEN_2022_PROGRAM_ADDRESS),
        ro(inMint),
        ro(outMint),
        rw(a.observation),
      ],
      data: new Uint8Array(d),
    } as unknown as Instruction;
    const sig = await send([computeLimit(400_000), ix], c.trader);
    return { sig, got: (await balanceOf(c.trader.address, outMint)) - before, reserveIn, reserveOut };
  };

  const sell = await swap(true, 10_000_000n); // sell 10 base tokens
  const sellExpected = expectedOut(10_000_000n, sell.reserveIn, sell.reserveOut, tradeFeeRate);
  const fairSell = (10_000_000n * c.pStar) / scale;
  ev.check('swap-sell', 'selling 10 tokens into the pool pays exactly Raydium\'s constant-product formula (0.25% fee on the input)', sell.got === sellExpected, `received ${sell.got} quote atoms, formula ${sellExpected}; at P* with no fee and no impact it would be ${fairSell} (${(Number(sell.got) / Number(fairSell) * 100).toFixed(3)}%)`, sell.sig);
  ev.check('swap-sell-vs-P', 'the sell executes within 5% of P* (the 0.25% fee plus the price impact of a 2% trade)', sell.got < fairSell && sell.got * 100n > fairSell * 95n, `${sell.got} vs ${fairSell}`);

  const buy = await swap(false, 12_000_000n); // spend 12 quote tokens
  const buyExpected = expectedOut(12_000_000n, buy.reserveIn, buy.reserveOut, tradeFeeRate);
  const spotBuy = (12_000_000n * buy.reserveOut) / buy.reserveIn; // the sell moved the pool off P*: compare with the spot price at that moment
  ev.check('swap-buy', 'buying with 12 quote tokens pays exactly Raydium\'s formula', buy.got === buyExpected, `received ${buy.got} base atoms, formula ${buyExpected}; at the pool spot price (moved by the sell) with no fee and no impact ${spotBuy} (${(Number(buy.got) / Number(spotBuy) * 100).toFixed(3)}%)`, buy.sig);
  ev.check('swap-buy-vs-spot', 'the buy executes within 5% below the pool spot price (the 0.25% fee plus the price impact of a 2% trade)', buy.got < spotBuy && buy.got * 100n > spotBuy * 95n, `${buy.got} vs ${spotBuy}`);

  const back = await sweep(c);
  ev.check('cost', 'what the throwaway creator had left went back to the promiser', true, `returned ${Number(back) / 1e9} SOL of ${Number(c.startLamports) / 1e9} (pool-creation fee ${Number(createPoolFee) / 1e9} SOL is paid to Raydium)`);
}

main().then(() => ev.write(), (e) => { console.error(e); ev.write(e); });
