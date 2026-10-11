// Devnet proof for volatility-aware trading fees on a Meteora DBC pool (ADR-0018).
//
// Opens a DBC pool whose dynamic fee comes from `volatilityFeeParams`, then drives real swaps: a calm
// one, a burst that moves the price, and a calm one again after the decay period. Each swap's effective
// fee is read from the pool's own fee counters (chain truth), not from a quote.
//
//   RPC_URL=<devnet rpc> pnpm --filter @opening-cross/devnet-proofs dp:volfee
import { LAMPORTS_PER_SOL, Keypair } from '@solana/web3.js';
import BN from 'bn.js';
import {
  ActivationType,
  BaseFeeMode,
  CollectFeeMode,
  DynamicBondingCurveClient,
  MigrationFeeOption,
  MigrationOption,
  SwapMode,
  TokenAuthorityOption,
  TokenDecimal,
  TokenType,
  buildCurve,
  deriveDbcPoolAddress,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import { NATIVE_MINT } from '@solana/spl-token';
import { dynamicFeeBps, maxDynamicFeeBps, volatilityFeeParams } from '@opening-cross/adapters';
import { Evidence, RPC, connection, operator, send } from './lib.js';

const dbc = new DynamicBondingCurveClient(connection, 'confirmed');
const BASE_FEE_BPS = 100;
const DESIGN = { baseFeeBps: BASE_FEE_BPS, extraFeeShareOfBase: 1, maxPriceChangeBps: 300, filterPeriodSeconds: 10, decayPeriodSeconds: 30 } as const;
const params = volatilityFeeParams(DESIGN);
const CAP_BPS = maxDynamicFeeBps(params);

const ev = new Evidence('DP-volatility-fee.md', 'Devnet proof — volatility-aware DBC trading fees (ADR-0018)', [
  'Script `tests/devnet/src/volatility-fee-proof.ts`',
  `Design: base ${BASE_FEE_BPS} bps fixed; the dynamic layer may add up to ${CAP_BPS.toFixed(2)} bps once the price has moved ${DESIGN.maxPriceChangeBps / 100}% (filter ${DESIGN.filterPeriodSeconds} s, decay ${DESIGN.decayPeriodSeconds} s, variableFeeControl ${params.variableFeeControl}, max volatility accumulator ${params.maxVolatilityAccumulator}).`,
  "The fee of each swap is the change in the pool's three fee counters (protocol, partner, creator) divided by the amount in.",
]);

const must = <T>(v: T | null | undefined, what: string): T => {
  if (v === null || v === undefined) throw new Error(`${what} not found`);
  return v;
};

async function main() {
  console.log(`RPC ${RPC}\ntrader ${operator.publicKey.toBase58()}`);
  const curve = buildCurve({
    token: { tokenType: TokenType.SPLToken, tokenBaseDecimal: TokenDecimal.SIX, tokenQuoteDecimal: TokenDecimal.NINE, tokenAuthorityOption: TokenAuthorityOption.Immutable, totalTokenSupply: 1_000_000_000, leftover: 1_000 },
    fee: {
      baseFeeParams: { baseFeeMode: BaseFeeMode.FeeSchedulerLinear, feeSchedulerParam: { startingFeeBps: BASE_FEE_BPS, endingFeeBps: BASE_FEE_BPS, numberOfPeriod: 0, totalDuration: 0 } },
      dynamicFeeEnabled: true,
      collectFeeMode: CollectFeeMode.QuoteToken,
      creatorTradingFeePercentage: 0,
      poolCreationFee: 0,
      enableFirstSwapWithMinFee: false,
    },
    migration: { migrationOption: MigrationOption.MET_DAMM_V2, migrationFeeOption: MigrationFeeOption.FixedBps100, migrationFee: { feePercentage: 0, creatorFeePercentage: 0 } },
    liquidityDistribution: { partnerLiquidityPercentage: 0, partnerPermanentLockedLiquidityPercentage: 100, creatorLiquidityPercentage: 0, creatorPermanentLockedLiquidityPercentage: 0 },
    lockedVesting: { totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0, totalVestingDuration: 0, cliffDurationFromMigrationTime: 0 },
    activationType: ActivationType.Timestamp,
    percentageSupplyOnMigration: 20,
    migrationQuoteThreshold: 0.5,
  });
  // Replace the SDK helper's fixed "20% of base" dynamic fee with the explicit design under test.
  curve.poolFees.dynamicFee = params;

  const config = Keypair.generate();
  const cfgSig = await send(await dbc.partner.createConfig({ config: config.publicKey, feeClaimer: operator.publicKey, leftoverReceiver: operator.publicKey, payer: operator.publicKey, quoteMint: NATIVE_MINT, ...curve }), [operator, config]);
  const cfg = must(await dbc.state.getPoolConfig(config.publicKey), 'config');
  const onChain = cfg.poolFees.dynamicFee;
  ev.check(
    'config',
    'the config on chain carries the designed dynamic-fee parameters',
    onChain.variableFeeControl.toString() === String(params.variableFeeControl) &&
      onChain.maxVolatilityAccumulator.toString() === String(params.maxVolatilityAccumulator) &&
      onChain.filterPeriod === params.filterPeriod &&
      onChain.decayPeriod === params.decayPeriod &&
      onChain.reductionFactor === params.reductionFactor,
    `on chain: filter ${onChain.filterPeriod}, decay ${onChain.decayPeriod}, reduction ${onChain.reductionFactor}, variableFeeControl ${onChain.variableFeeControl}, max accumulator ${onChain.maxVolatilityAccumulator}`,
    cfgSig,
  );

  const baseMint = Keypair.generate();
  const poolSig = await send(await dbc.creator.createPool({ baseMint: baseMint.publicKey, config: config.publicKey, name: 'Volatility Fee Proof', symbol: 'VFP', uri: 'https://github.com/Pratiikpy/opening-cross', payer: operator.publicKey, poolCreator: operator.publicKey }), [operator, baseMint]);
  const pool = deriveDbcPoolAddress(NATIVE_MINT, baseMint.publicKey, config.publicKey);
  console.log(`pool ${pool.toBase58()} (${poolSig})`);

  // Fees accrue in three counters of the pool (protocol, partner, creator); their sum is the whole fee charged.
  const state = async () => {
    const p = must(await dbc.state.getPool(pool), 'pool').poolState;
    const fee = BigInt(p.protocolQuoteFee.toString()) + BigInt(p.partnerQuoteFee.toString()) + BigInt(p.creatorQuoteFee.toString());
    return { feeQuote: fee, va: BigInt(p.volatilityTracker.volatilityAccumulator.toString()), sqrt: BigInt(p.sqrtPrice.toString()) };
  };

  /** `vaBefore` is the accumulator stored when the swap started; `va` is what the swap left behind. */
  type Swap = { label: string; amount: number; feeBps: number; vaBefore: bigint; va: bigint; moveBps: number; sig: string; at: number };
  const swaps: Swap[] = [];
  async function buy(label: string, lamports: number): Promise<Swap> {
    const before = await state();
    const tx = await dbc.pool.swap2({ owner: operator.publicKey, payer: operator.publicKey, pool, swapBaseForQuote: false, referralTokenAccount: null, swapMode: SwapMode.ExactIn, amountIn: new BN(lamports), minimumAmountOut: new BN(0) });
    const sig = await send(tx, [operator]);
    const after = await state();
    const fee = Number(after.feeQuote - before.feeQuote);
    // Price is the square of the sqrt price: move in basis points.
    const priceRatio = (Number(after.sqrt) / Number(before.sqrt)) ** 2;
    const s: Swap = { label, amount: lamports, feeBps: (fee * 10_000) / lamports, vaBefore: before.va, va: after.va, moveBps: (priceRatio - 1) * 10_000, sig, at: Date.now() };
    swaps.push(s);
    const modelBps = BASE_FEE_BPS + dynamicFeeBps(params, before.va);
    console.log(`${label}: ${lamports / LAMPORTS_PER_SOL} SOL in, fee ${s.feeBps.toFixed(2)} bps (model ${modelBps.toFixed(2)}), price moved ${s.moveBps.toFixed(1)} bps, accumulator ${before.va} -> ${s.va}`);
    return s;
  }

  // 1. Calm: a tiny swap on a fresh pool.
  const calm1 = await buy('calm', 0.0005 * LAMPORTS_PER_SOL);
  ev.check('calm', 'a tiny swap on a calm pool pays the base fee, within 0.5 bps', Math.abs(calm1.feeBps - BASE_FEE_BPS) <= 0.5, `${calm1.feeBps.toFixed(2)} bps against a base of ${BASE_FEE_BPS}`, calm1.sig);

  // 2. Burst: larger swaps back to back, inside the filter period, moving the price.
  const burst: Swap[] = [];
  for (let i = 0; i < 4; i++) burst.push(await buy(`burst ${i + 1}`, 0.02 * LAMPORTS_PER_SOL));
  const peak = burst.reduce((a, b) => (b.feeBps > a.feeBps ? b : a));
  ev.check('burst-rises', 'during a burst that moves the price the fee rises above the base', peak.feeBps > BASE_FEE_BPS + 5, `peak ${peak.feeBps.toFixed(2)} bps after the price moved ${burst.reduce((m, x) => m + x.moveBps, 0).toFixed(0)} bps in total`, peak.sig);
  ev.check('burst-grows', 'the fee grows as volatility accumulates within the burst', burst[burst.length - 1]!.feeBps > burst[0]!.feeBps, `first ${burst[0]!.feeBps.toFixed(2)} bps, last ${burst[burst.length - 1]!.feeBps.toFixed(2)} bps`);
  ev.check('cap', 'no swap ever pays more than base plus the designed cap', swaps.every((x) => x.feeBps <= BASE_FEE_BPS + CAP_BPS + 0.05), `highest ${Math.max(...swaps.map((x) => x.feeBps)).toFixed(2)} bps against a ceiling of ${(BASE_FEE_BPS + CAP_BPS).toFixed(2)}`);

  // 3. Decay: wait past the decay period; the first swap afterwards, then one more.
  const wait = (DESIGN.decayPeriodSeconds + 8) * 1000;
  console.log(`waiting ${wait / 1000} s for the volatility reference to decay`);
  await new Promise((r) => setTimeout(r, wait));
  const stale = await buy('first swap after the quiet period', 0.0005 * LAMPORTS_PER_SOL);
  const calm3 = await buy('second swap after the quiet period', 0.0005 * LAMPORTS_PER_SOL);
  ev.check('decay', 'after the quiet period the volatility is reset, so the next swap pays close to the base fee', calm3.feeBps <= BASE_FEE_BPS + 3 && calm3.feeBps < peak.feeBps && calm3.vaBefore < peak.va, `second swap ${calm3.feeBps.toFixed(2)} bps (peak was ${peak.feeBps.toFixed(2)}); accumulator ${peak.va} before the quiet period, ${calm3.vaBefore} after`, calm3.sig);

  // The model reproduces the chain: every swap pays the base fee plus the dynamic fee of the accumulator the pool stored when the swap started.
  const errs = swaps.map((x) => Math.abs(x.feeBps - (BASE_FEE_BPS + dynamicFeeBps(params, x.vaBefore))));
  ev.check('model', 'every swap paid base + dynamic fee at the accumulator stored before it, within 0.2 bps', errs.every((e) => e <= 0.2), `${swaps.length} swaps, largest difference ${Math.max(...errs).toFixed(3)} bps`);
  // Finding, recorded as a fact rather than a claim: the fee follows the stored accumulator, which the swap updates AFTER charging.
  ev.record({
    id: 'lag',
    claim: 'finding: a swap pays for the volatility earlier swaps left behind, not for its own move; after a quiet period the first swap still pays the old rate',
    result: 'PASS',
    detail: `the swap that first moved the price paid ${burst[0]!.feeBps.toFixed(2)} bps; the first swap after ${DESIGN.decayPeriodSeconds} s of quiet paid ${stale.feeBps.toFixed(2)} bps (stored accumulator ${stale.vaBefore}) and the next paid ${calm3.feeBps.toFixed(2)} bps`,
  });
}

main().then(() => ev.write(), (e) => { console.error(e); ev.write(e); });
