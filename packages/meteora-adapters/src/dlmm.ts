// DLMM adapter: open a Meteora DLMM pair whose active bin is the bin nearest P*.
// Token X = base, token Y = quote, so a bin's price (Y per X) is in the cross's units.
import BN from 'bn.js';
import { type Address, type Instruction, type TransactionSigner, address } from '@solana/kit';
import { PublicKey } from '@solana/web3.js';
import { getOpenDlmmPairInstruction } from '@opening-cross/cross-settle-client';
import { type CrossView, ata } from '@opening-cross/sdk';

export const DLMM_PROGRAM_ADDRESS = address('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');
const PROGRAM = new PublicKey(DLMM_PROGRAM_ADDRESS);
const toKit = (k: PublicKey): Address => address(k.toBase58());

// PDA derivations copied from @meteora-ag/dlmm (ts-client/src/dlmm/helpers/derive.ts); the
// package itself is not imported because its ESM build fails to load under Node.
const ILM_BASE = new PublicKey('MFGQxwAmB91SwuYX36okv2Qmdc9aMuHTwWGUrp4AtB1');
function sortMints(x: PublicKey, y: PublicKey): [PublicKey, PublicKey] {
  return x.toBuffer().compare(y.toBuffer()) === 1 ? [y, x] : [x, y];
}
const pda = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, PROGRAM)[0];

/** `(1 + binStep/10⁴)^id` in Q64.64 — identical to `cross_settle::bin_price_q64`. */
export function binPriceQ64(id: number, binStep: number): bigint {
  const one = 1n << 64n;
  const base = one + (BigInt(binStep) << 64n) / 10_000n;
  let result = one;
  let b = base;
  let e = BigInt(Math.abs(id));
  while (e > 0n) {
    if (e & 1n) result = (result * b) >> 64n;
    e >>= 1n;
    if (e > 0n) b = (b * b) >> 64n;
  }
  return id < 0 ? (one << 64n) / result : result;
}

/** Mirrors `cross_settle::bin_contains`. */
export function binContains(id: number, binStep: number, price: bigint, priceScale: bigint): boolean {
  const bin = binPriceQ64(id, binStep);
  const p = (price << 64n) / priceScale;
  return p >= (bin * BigInt(20_000 - binStep)) / 20_000n && p <= (bin * BigInt(20_000 + binStep)) / 20_000n;
}

/** The bin id the adapter will accept for P*. */
export function activeIdForPrice(price: bigint, priceScale: bigint, binStep: number): number {
  const approx = Math.round(Math.log(Number(price) / Number(priceScale)) / Math.log(1 + binStep / 10_000));
  for (const id of [approx, approx - 1, approx + 1]) if (binContains(id, binStep, price, priceScale)) return id;
  throw new Error('no DLMM bin within half a step of the clearing price');
}

export function dlmmAddresses(baseMint: Address, quoteMint: Address) {
  const [min, max] = sortMints(new PublicKey(baseMint), new PublicKey(quoteMint));
  const lbPair = pda([ILM_BASE.toBuffer(), min.toBuffer(), max.toBuffer()]);
  return {
    lbPair: toKit(lbPair),
    reserveX: toKit(pda([lbPair.toBuffer(), new PublicKey(baseMint).toBuffer()])),
    reserveY: toKit(pda([lbPair.toBuffer(), new PublicKey(quoteMint).toBuffer()])),
    oracle: toKit(pda([Buffer.from('oracle'), lbPair.toBuffer()])),
    eventAuthority: toKit(pda([Buffer.from('__event_authority')])),
  };
}

export type OpenDlmmInput = {
  cross: CrossView;
  creator: TransactionSigner;
  binStep: number;
  /** DLMM base factor: base fee = baseFactor · binStep · 10 · 10^baseFeePowerFactor (in 1e9 units). */
  baseFactor: number;
  baseFeePowerFactor?: number;
};

export async function buildOpenDlmmPair(input: OpenDlmmInput): Promise<{ instruction: Instruction; activeId: number; addresses: ReturnType<typeof dlmmAddresses> }> {
  const c = input.cross.data;
  if (c.clearing.__option !== 'Some') throw new Error('cross has not cleared');
  if (!c.baseBound) throw new Error('cross has no base mint yet');
  const activeId = activeIdForPrice(c.clearing.value.price, c.priceScale, input.binStep);
  const a = dlmmAddresses(c.baseMint, c.quoteMint);
  void BN;
  const instruction = getOpenDlmmPairInstruction({
    creator: input.creator,
    cross: input.cross.address,
    lbPair: a.lbPair,
    baseMint: c.baseMint,
    quoteMint: c.quoteMint,
    reserveX: a.reserveX,
    reserveY: a.reserveY,
    oracle: a.oracle,
    creatorBase: await ata(input.creator.address, c.baseMint, c.baseTokenProgram),
    creatorQuote: await ata(input.creator.address, c.quoteMint, c.quoteTokenProgram),
    dlmmEventAuthority: a.eventAuthority,
    baseTokenProgram: c.baseTokenProgram,
    quoteTokenProgram: c.quoteTokenProgram,
    activeId,
    binStep: input.binStep,
    baseFactor: input.baseFactor,
    activationType: 1,
    hasAlphaVault: false,
    activationPoint: null,
    creatorPoolOnOffControl: false,
    baseFeePowerFactor: input.baseFeePowerFactor ?? 0,
    concreteFunctionType: 0,
    collectFeeMode: 0,
    padding: new Uint8Array(60),
  });
  return { instruction, activeId, addresses: a };
}
