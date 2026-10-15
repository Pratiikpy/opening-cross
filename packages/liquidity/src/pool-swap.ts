// Swap instructions for the Meteora pools a cross opens (ROADMAP W9 pool resting liquidity and K5 secondary trading, ADR-0923).
//
// A pool that a cross seeds at its clearing price is also a place to place an order: anyone can swap against it. These builders produce the
// instruction for an exact-input swap in a DAMM v2 pool (`swap2`) or a DLMM pair (`swap2`), from the pool's decoded state. They build nothing
// else: no token accounts are created, no transaction is assembled, nothing is signed. The caller adds the associated-token-account instruction
// for the output (idempotent), wraps the instructions in a transaction with the trader as fee payer, and has the trader sign.
//
// Both programs are called at their deployed addresses; the account order and argument layout are those of the IDLs in `idls/cp_amm.json` and
// `idls/lb_clmm.json`, and `test/pool-swap.test.ts` checks them against those files.
import { createHash } from 'node:crypto';
import { AccountRole, type Address, type Instruction, address, getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';

export const DAMM_V2_PROGRAM = address('cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG');
export const DLMM_PROGRAM = address('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');
export const MEMO_PROGRAM = address('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
/** An optional account that is not supplied is passed as the program's own address (the Anchor convention). */
const NONE = (program: Address) => program;

const text = new TextEncoder();
const enc = getAddressEncoder();
const disc = (name: string) => createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
const u64le = (v: bigint) => {
  if (v < 0n || v >= 1n << 64n) throw new Error('amount out of the u64 range');
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v);
  return b;
};

/** The fixed authority account of the DAMM v2 program. */
export async function dammPoolAuthority(): Promise<Address> {
  return (await getProgramDerivedAddress({ programAddress: DAMM_V2_PROGRAM, seeds: [text.encode('pool_authority')] }))[0];
}
/** The event-authority PDA both programs use for self-CPI events. */
export async function eventAuthority(program: Address): Promise<Address> {
  return (await getProgramDerivedAddress({ programAddress: program, seeds: [text.encode('__event_authority')] }))[0];
}
/** The DLMM bin array account holding bins `index * 70` to `index * 70 + 69` of `lbPair`. */
export async function dlmmBinArrayAddress(lbPair: Address, index: number): Promise<Address> {
  const seed = Buffer.alloc(8);
  seed.writeBigInt64LE(BigInt(index));
  return (await getProgramDerivedAddress({ programAddress: DLMM_PROGRAM, seeds: [text.encode('bin_array'), enc.encode(lbPair), seed] }))[0];
}

export type DammSwapInput = {
  pool: Address;
  tokenAMint: Address;
  tokenBMint: Address;
  tokenAVault: Address;
  tokenBVault: Address;
  tokenAProgram: Address;
  tokenBProgram: Address;
  /** The trader: pays, signs and owns both token accounts. */
  trader: Address;
  /** The trader's token account for the token being sold, and for the token being bought. */
  inputAccount: Address;
  outputAccount: Address;
  amountIn: bigint;
  minimumAmountOut: bigint;
};

/** DAMM v2 `swap2` in exact-input mode: sell `amountIn` of the input token and receive at least `minimumAmountOut` of the other. */
export async function buildDammSwap(i: DammSwapInput): Promise<Instruction> {
  const data = Buffer.concat([disc('swap2'), u64le(i.amountIn), u64le(i.minimumAmountOut), Buffer.from([0])]);
  const eventAuth = await eventAuthority(DAMM_V2_PROGRAM);
  return {
    programAddress: DAMM_V2_PROGRAM,
    accounts: [
      { address: await dammPoolAuthority(), role: AccountRole.READONLY },
      { address: i.pool, role: AccountRole.WRITABLE },
      { address: i.inputAccount, role: AccountRole.WRITABLE },
      { address: i.outputAccount, role: AccountRole.WRITABLE },
      { address: i.tokenAVault, role: AccountRole.WRITABLE },
      { address: i.tokenBVault, role: AccountRole.WRITABLE },
      { address: i.tokenAMint, role: AccountRole.READONLY },
      { address: i.tokenBMint, role: AccountRole.READONLY },
      { address: i.trader, role: AccountRole.READONLY_SIGNER },
      { address: i.tokenAProgram, role: AccountRole.READONLY },
      { address: i.tokenBProgram, role: AccountRole.READONLY },
      { address: NONE(DAMM_V2_PROGRAM), role: AccountRole.READONLY }, // referral token account: none
      { address: eventAuth, role: AccountRole.READONLY },
      { address: DAMM_V2_PROGRAM, role: AccountRole.READONLY },
    ],
    data: new Uint8Array(data),
  };
}

export type DlmmSwapInput = {
  lbPair: Address;
  reserveX: Address;
  reserveY: Address;
  tokenXMint: Address;
  tokenYMint: Address;
  tokenXProgram: Address;
  tokenYProgram: Address;
  oracle: Address;
  trader: Address;
  inputAccount: Address;
  outputAccount: Address;
  amountIn: bigint;
  minimumAmountOut: bigint;
  /** Indexes of the bin arrays the swap walks, in order of travel. All must exist on chain. */
  binArrays: number[];
};

/** The bitmap of initialised bin arrays a pair keeps in its own account covers indexes -512 to 511; arrays beyond that need the bitmap extension account, which this builder does not name. */
export const DLMM_INTERNAL_BITMAP_RANGE = { min: -512, max: 511 } as const;

/** DLMM `swap2` (exact input, no token-2022 hook accounts): sell `amountIn` and receive at least `minimumAmountOut`. The pair's own reserves, mints and oracle are named; the bin arrays are passed as remaining accounts. */
export async function buildDlmmSwap(i: DlmmSwapInput): Promise<Instruction> {
  for (const index of i.binArrays) {
    if (!Number.isInteger(index) || index < DLMM_INTERNAL_BITMAP_RANGE.min || index > DLMM_INTERNAL_BITMAP_RANGE.max) {
      throw new Error(`bin array ${index} is outside the range the pair's own bitmap covers (${DLMM_INTERNAL_BITMAP_RANGE.min} to ${DLMM_INTERNAL_BITMAP_RANGE.max}); the swap would need the bitmap extension account`);
    }
  }
  if (i.binArrays.length === 0) throw new Error('a swap needs at least one bin array');
  // amount_in, min_amount_out, then RemainingAccountsInfo { slices: Vec<..> } with no slices: the mints carry no transfer hook.
  const data = Buffer.concat([disc('swap2'), u64le(i.amountIn), u64le(i.minimumAmountOut), Buffer.from([0, 0, 0, 0])]);
  const eventAuth = await eventAuthority(DLMM_PROGRAM);
  const arrays = await Promise.all(i.binArrays.map((index) => dlmmBinArrayAddress(i.lbPair, index)));
  return {
    programAddress: DLMM_PROGRAM,
    accounts: [
      { address: i.lbPair, role: AccountRole.WRITABLE },
      { address: NONE(DLMM_PROGRAM), role: AccountRole.READONLY }, // bin array bitmap extension: none
      { address: i.reserveX, role: AccountRole.WRITABLE },
      { address: i.reserveY, role: AccountRole.WRITABLE },
      { address: i.inputAccount, role: AccountRole.WRITABLE },
      { address: i.outputAccount, role: AccountRole.WRITABLE },
      { address: i.tokenXMint, role: AccountRole.READONLY },
      { address: i.tokenYMint, role: AccountRole.READONLY },
      { address: i.oracle, role: AccountRole.WRITABLE },
      { address: NONE(DLMM_PROGRAM), role: AccountRole.READONLY }, // host fee account: none
      { address: i.trader, role: AccountRole.READONLY_SIGNER },
      { address: i.tokenXProgram, role: AccountRole.READONLY },
      { address: i.tokenYProgram, role: AccountRole.READONLY },
      { address: MEMO_PROGRAM, role: AccountRole.READONLY },
      { address: eventAuth, role: AccountRole.READONLY },
      { address: DLMM_PROGRAM, role: AccountRole.READONLY },
      ...arrays.map((a) => ({ address: a, role: AccountRole.WRITABLE as const })),
    ],
    data: new Uint8Array(data),
  };
}

/** The smallest output a trader accepts: the quoted output less a tolerance in basis points, rounded up so the tolerance is never exceeded. */
export function minimumOut(expectedOut: bigint, toleranceBps: number): bigint {
  if (!Number.isInteger(toleranceBps) || toleranceBps < 0 || toleranceBps > 10_000) throw new Error('tolerance must be a whole number of basis points from 0 to 10,000');
  const floor = (expectedOut * BigInt(10_000 - toleranceBps)) / 10_000n;
  return floor * 10_000n === expectedOut * BigInt(10_000 - toleranceBps) ? floor : floor + 1n;
}
