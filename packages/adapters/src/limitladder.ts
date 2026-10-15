// Conviction ladder as DLMM limit orders (ADR-0914; row D5, with D2): the issuer's unsold base tokens stand as ask orders in the bins above P*, owned by the
// issuer, instead of liquidity in a position.
//
// The two forms differ in what the holder gets. A position (`buildDlmmConvictionLadder`) is liquidity: it earns the pair's trading fees and is withdrawn bin by bin,
// and a buyer who crosses it leaves the issuer holding quote in the bins it sold from. A limit order is a promise to sell a fixed amount at one bin's price: it earns no
// fee, it fills only when a buyer's swap crosses its bin, and cancelling it hands back exactly what did not fill together with the quote the fills paid. It reuses the
// pieces of the greenshoe (ADR-0487), which places limit orders on the bid side from a program-owned account: the bin arrays, the memo program, the pair's accounts and the
// base token's transfer-hook accounts. Here the owner is the issuer's wallet, so the order is the issuer's to cancel at any time.
//
// Layouts are from the program's published IDL (`idls/lb_clmm.json`, `place_limit_order`, `cancel_limit_order`, `close_limit_order_if_empty`).
import { createHash } from 'node:crypto';
import { AccountRole, type Address, type Instruction, type TransactionSigner, address } from '@solana/kit';
import { type CrossView, ata } from '@opening-cross/sdk';
import { DLMM_PROGRAM_ADDRESS, binArrayAddress, binArrayIndex, dlmmAddresses } from './dlmm.js';
import { gateHookAccounts } from './partner.js';

const SYSTEM_PROGRAM = address('11111111111111111111111111111111');
const MEMO_PROGRAM = address('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const disc = (name: string) => createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);

/** One rung of the ladder: sell `amount` base atoms at the price of bin `binId`. */
export type LimitRung = { binId: number; amount: bigint };

/** How the base is spread over the rungs: evenly, most at the first rung, or most at the last. */
export type LimitLadderShape = 'flat' | 'taper' | 'wall';

/** The most bins a single DLMM limit order may carry, checked against the real program (`tests/core/test/meteora-limit-ladder.test.ts`). */
export const MAX_LIMIT_ORDER_BINS = 70;

/**
 * Plans the rungs of a ladder above the active bin: `count` rungs, `spacing` bins apart, the first `firstOffset` bins above the active bin, splitting `baseAmount`
 * by `shape` so that the amounts add up to it exactly (the remainder goes to the first rung). Pure arithmetic.
 */
export function planLimitLadder(input: { activeId: number; count: number; baseAmount: bigint; shape?: LimitLadderShape; spacing?: number; firstOffset?: number }): LimitRung[] {
  const spacing = input.spacing ?? 1;
  const firstOffset = input.firstOffset ?? 1;
  if (!Number.isInteger(input.count) || input.count < 1 || input.count > MAX_LIMIT_ORDER_BINS) throw new Error(`a ladder has 1 to ${MAX_LIMIT_ORDER_BINS} rungs`);
  if (!Number.isInteger(spacing) || spacing < 1) throw new Error('spacing is a whole number of bins, at least 1');
  if (!Number.isInteger(firstOffset) || firstOffset < 1) throw new Error('the first rung is at least one bin above the active bin: an ask at or below the market would fill at once');
  if (input.baseAmount < BigInt(input.count)) throw new Error('baseAmount must be at least one atom per rung');
  const shape = input.shape ?? 'flat';
  const weights = Array.from({ length: input.count }, (_, i) => (shape === 'flat' ? 1 : shape === 'taper' ? input.count - i : i + 1));
  const total = weights.reduce((a, b) => a + b, 0);
  const amounts = weights.map((w) => (input.baseAmount * BigInt(w)) / BigInt(total));
  amounts[0] = amounts[0]! + (input.baseAmount - amounts.reduce((a, b) => a + b, 0n));
  return amounts.map((amount, i) => ({ binId: input.activeId + firstOffset + i * spacing, amount }));
}

/** The bin-array indexes a set of bins needs, lowest first. */
export const limitLadderArrayIndexes = (activeId: number, rungs: LimitRung[]): number[] => {
  const ids = [activeId, ...rungs.map((r) => r.binId)];
  const out: number[] = [];
  for (let i = binArrayIndex(Math.min(...ids)); i <= binArrayIndex(Math.max(...ids)); i++) out.push(i);
  return out;
};

async function hookExtras(cross: CrossView, owner: Address, hook: boolean | undefined) {
  if (!hook) return [];
  const c = cross.data;
  const d = dlmmAddresses(c.baseMint, c.quoteMint);
  return gateHookAccounts(c.baseMint, owner, d.lbPair);
}

function remainingInfo(hookLen: number): Buffer {
  const b = Buffer.alloc(4 + (hookLen > 0 ? 2 : 0));
  b.writeUInt32LE(hookLen > 0 ? 1 : 0, 0);
  if (hookLen > 0) {
    b.writeUInt8(0, 4); // TransferHookX: the base token is token X of the pair
    b.writeUInt8(hookLen, 5);
  }
  return b;
}

export type PlaceLimitLadderInput = {
  cross: CrossView;
  owner: TransactionSigner;
  /** A fresh keypair signer: the limit-order account. */
  limitOrder: TransactionSigner;
  /** The active bin you observed; DLMM reads every rung as an offset from it. */
  activeId: number;
  rungs: LimitRung[];
  /** How far the active bin may have moved when the transaction lands before DLMM refuses it. Default 2. */
  maxActiveBinSlippage?: number;
  /** Bin-array indexes that already exist (so they are not initialised twice). */
  existingBinArrays?: number[];
  /** Set when the base token carries the cross_gate transfer hook: its accounts are added. */
  hook?: boolean;
};

/** Initialises the bin arrays the rungs need, then places one ask-side limit order holding every rung. The issuer pays rent for both. */
export async function buildPlaceLimitLadder(input: PlaceLimitLadderInput): Promise<{ instructions: Instruction[]; limitOrder: Address; binArrays: Address[] }> {
  const c = input.cross.data;
  const d = dlmmAddresses(c.baseMint, c.quoteMint);
  if (input.rungs.length < 1 || input.rungs.length > MAX_LIMIT_ORDER_BINS) throw new Error(`a limit order carries 1 to ${MAX_LIMIT_ORDER_BINS} bins`);
  const seen = new Set<number>();
  for (const r of input.rungs) {
    if (r.binId <= input.activeId) throw new Error(`rung ${r.binId} is at or below the active bin ${input.activeId}: an ask there would fill at once`);
    if (seen.has(r.binId)) throw new Error(`bin ${r.binId} appears twice`);
    seen.add(r.binId);
    if (r.amount <= 0n) throw new Error('every rung sells a positive amount');
  }
  const slippage = input.maxActiveBinSlippage ?? 2;
  if (!Number.isInteger(slippage) || slippage < 0) throw new Error('maxActiveBinSlippage is a whole number of bins');
  const indexes = limitLadderArrayIndexes(input.activeId, input.rungs);
  const have = new Set(input.existingBinArrays ?? []);
  const instructions: Instruction[] = [];
  const binArrays: Address[] = [];
  for (const i of indexes) {
    const addr = binArrayAddress(d.lbPair, i);
    binArrays.push(addr);
    if (have.has(i)) continue;
    const data = Buffer.alloc(16);
    disc('initialize_bin_array').copy(data, 0);
    data.writeBigInt64LE(BigInt(i), 8);
    instructions.push({
      programAddress: DLMM_PROGRAM_ADDRESS,
      accounts: [
        { address: d.lbPair, role: AccountRole.READONLY },
        { address: addr, role: AccountRole.WRITABLE },
        { address: input.owner.address, role: AccountRole.WRITABLE_SIGNER, signer: input.owner } as never,
        { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
      ],
      data: new Uint8Array(data),
    });
  }
  const extras = await hookExtras(input.cross, input.owner.address, input.hook);
  const params = Buffer.alloc(1 + 16 + 1 + 8 + 4 + input.rungs.length * 12);
  let o = 0;
  params.writeUInt8(1, o); o += 1; // is_ask_side
  o += 16; // padding
  params.writeUInt8(1, o); o += 1; // relative_bin: Some
  params.writeInt32LE(input.activeId, o); o += 4;
  params.writeInt32LE(slippage, o); o += 4;
  params.writeUInt32LE(input.rungs.length, o); o += 4;
  for (const r of input.rungs) {
    params.writeInt32LE(r.binId - input.activeId, o); o += 4; // an offset from the active bin
    params.writeBigUInt64LE(r.amount, o); o += 8;
  }
  const data = Buffer.concat([disc('place_limit_order'), params, remainingInfo(extras.length)]);
  instructions.push({
    programAddress: DLMM_PROGRAM_ADDRESS,
    accounts: [
      { address: d.lbPair, role: AccountRole.WRITABLE },
      { address: DLMM_PROGRAM_ADDRESS, role: AccountRole.READONLY }, // no bitmap extension
      { address: d.reserveX, role: AccountRole.WRITABLE },
      { address: c.baseMint, role: AccountRole.READONLY },
      { address: input.limitOrder.address, role: AccountRole.WRITABLE_SIGNER, signer: input.limitOrder } as never,
      { address: input.owner.address, role: AccountRole.WRITABLE_SIGNER, signer: input.owner } as never,
      { address: input.owner.address, role: AccountRole.READONLY },
      { address: await ata(input.owner.address, c.baseMint, c.baseTokenProgram), role: AccountRole.WRITABLE },
      { address: input.owner.address, role: AccountRole.READONLY_SIGNER, signer: input.owner } as never,
      { address: c.baseTokenProgram, role: AccountRole.READONLY },
      { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
      { address: d.eventAuthority, role: AccountRole.READONLY },
      { address: DLMM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
      ...extras,
      ...binArrays.map((a) => ({ address: a, role: AccountRole.WRITABLE })),
    ],
    data: new Uint8Array(data),
  });
  return { instructions, limitOrder: input.limitOrder.address, binArrays };
}

export type CancelLimitLadderInput = {
  cross: CrossView;
  owner: TransactionSigner;
  limitOrder: Address;
  /** The bins to cancel (absolute ids; every rung the order still holds, or a subset). */
  binIds: number[];
  hook?: boolean;
};

/**
 * Cancels rungs of the order: DLMM returns the base that did not fill to the owner's base account and pays the quote the fills earned into the owner's quote
 * account. Cancel every rung and then close the order to get its rent back.
 */
export async function buildCancelLimitLadder(input: CancelLimitLadderInput): Promise<Instruction> {
  const c = input.cross.data;
  const d = dlmmAddresses(c.baseMint, c.quoteMint);
  if (input.binIds.length < 1) throw new Error('name at least one bin to cancel');
  const extras = await hookExtras(input.cross, d.lbPair, input.hook);
  const arrays = [...new Set(input.binIds.map(binArrayIndex))].sort((a, b) => a - b).map((i) => binArrayAddress(d.lbPair, i));
  const bins = Buffer.alloc(4 + input.binIds.length * 4);
  bins.writeUInt32LE(input.binIds.length, 0);
  input.binIds.forEach((id, i) => bins.writeInt32LE(id, 4 + i * 4));
  return {
    programAddress: DLMM_PROGRAM_ADDRESS,
    accounts: [
      { address: d.lbPair, role: AccountRole.WRITABLE },
      { address: DLMM_PROGRAM_ADDRESS, role: AccountRole.READONLY }, // no bitmap extension
      { address: d.reserveX, role: AccountRole.WRITABLE },
      { address: d.reserveY, role: AccountRole.WRITABLE },
      { address: c.baseMint, role: AccountRole.READONLY },
      { address: c.quoteMint, role: AccountRole.READONLY },
      { address: input.limitOrder, role: AccountRole.WRITABLE },
      { address: await ata(input.owner.address, c.baseMint, c.baseTokenProgram), role: AccountRole.WRITABLE },
      { address: await ata(input.owner.address, c.quoteMint, c.quoteTokenProgram), role: AccountRole.WRITABLE },
      { address: input.owner.address, role: AccountRole.READONLY_SIGNER, signer: input.owner } as never,
      { address: c.baseTokenProgram, role: AccountRole.READONLY },
      { address: c.quoteTokenProgram, role: AccountRole.READONLY },
      { address: MEMO_PROGRAM, role: AccountRole.READONLY },
      { address: d.eventAuthority, role: AccountRole.READONLY },
      { address: DLMM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
      ...extras,
      ...arrays.map((a) => ({ address: a, role: AccountRole.WRITABLE })),
    ],
    data: new Uint8Array(Buffer.concat([disc('cancel_limit_order'), bins, remainingInfo(extras.length)])),
  };
}

/** Closes an emptied limit order and returns its rent to `rentReceiver` (DLMM refuses while any rung still holds base or quote). */
export function buildCloseLimitLadder(input: { cross: CrossView; owner: TransactionSigner; limitOrder: Address; rentReceiver: Address }): Instruction {
  const c = input.cross.data;
  const d = dlmmAddresses(c.baseMint, c.quoteMint);
  return {
    programAddress: DLMM_PROGRAM_ADDRESS,
    accounts: [
      { address: input.limitOrder, role: AccountRole.WRITABLE },
      { address: input.owner.address, role: AccountRole.READONLY_SIGNER, signer: input.owner } as never,
      { address: input.rentReceiver, role: AccountRole.WRITABLE },
      { address: d.eventAuthority, role: AccountRole.READONLY },
      { address: DLMM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    ],
    data: new Uint8Array(disc('close_limit_order_if_empty')),
  };
}
