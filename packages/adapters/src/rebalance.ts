// Rebalancing the conviction ladder (ADR-0915; row W10): when buyers have walked the price up through a ladder, what is left of it should stand above the new
// price, not be spread over bins the market has already passed.
//
// The ladder is a DLMM position (`buildDlmmConvictionLadder`): base tokens in bins above the clearing price. Buyers who cross a bin take its base and leave quote in it.
// Once the active bin is inside or above the ladder, the position holds a mix: quote in the bins that sold, base in the bins that did not. A rebalance withdraws the
// whole position (its quote is the issuer's proceeds), closes it, and lays the base it got back as a fresh ladder above the new active bin, in the same shape. Every step is
// Meteora's own instruction and the issuer signs each: there is nothing a third party can do to the position, and nothing in this module moves a token to anyone else.
// A protocol that held positions for issuers could pause and rebalance a pool on its own; Meteora has no instruction that lets a third party act on another's position
// (ADR-0483), so this is the issuer's action, and the keeper may only remind them.
import { createHash } from 'node:crypto';
import { AccountRole, type Address, type Instruction, type TransactionSigner } from '@solana/kit';
import { type CrossView, ata } from '@opening-cross/sdk';
import { DLMM_PROGRAM_ADDRESS, type ConvictionLadderInput, binArrayAddress, binArrayIndex, buildDlmmConvictionLadder, dlmmAddresses } from './dlmm.js';
import { type DlmmPosition, type DlmmPositionAmounts } from './dlmmpos.js';
import { gateHookAccounts } from './partner.js';

const disc = (name: string) => createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
const MEMO = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr' as Address;

export type LadderStatus = {
  /** True when every bin of the ladder is above the active bin: nothing has sold and there is nothing to rebalance. */
  untouched: boolean;
  /** True when the active bin is above the whole ladder: it has sold out or been passed, and it holds only quote. */
  passed: boolean;
  /** Base left in the ladder, and the quote it earned, as a withdrawal would pay them now (fees not included). */
  baseLeft: bigint;
  quoteEarned: bigint;
  /** The first and last bins that still hold base. Null when none does. */
  baseFrom: number | null;
  baseTo: number | null;
  /** Whether a rebalance does anything useful: the market has moved into the ladder and some base remains. */
  worthRebalancing: boolean;
};

/** Reads a ladder: how far the market has walked into it, and what is left. Pure. */
export function ladderStatus(position: DlmmPosition, amounts: DlmmPositionAmounts, activeId: number): LadderStatus {
  const withBase = amounts.bins.filter((b) => b.x > 0n);
  const untouched = position.lowerBinId > activeId && amounts.y === 0n;
  const passed = activeId > position.upperBinId;
  return {
    untouched,
    passed,
    baseLeft: amounts.x,
    quoteEarned: amounts.y,
    baseFrom: withBase.length ? withBase[0]!.binId : null,
    baseTo: withBase.length ? withBase[withBase.length - 1]!.binId : null,
    worthRebalancing: !untouched && amounts.x > 0n,
  };
}

export type RebalanceLadderInput = {
  cross: CrossView;
  owner: TransactionSigner;
  /** The ladder position being replaced and its range (from `decodeDlmmPosition`). */
  position: Address;
  lowerBinId: number;
  upperBinId: number;
  /** A fresh keypair signer: the new position. */
  newPosition: TransactionSigner;
  /** The active bin now. */
  activeId: number;
  /** The new ladder: how many bins above the active bin, how much base (normally `ladderStatus(...).baseLeft`), and the shape. */
  bins: number;
  baseAmount: bigint;
  shape?: ConvictionLadderInput['shape'];
  /** Bin arrays that already exist, so they are not initialised twice. */
  existingBinArrays?: number[];
  /** How far the active bin may move before the new ladder is refused. Default 2. */
  maxActiveBinSlippage?: number;
  /** Claim the position's accrued fees in the same step (default true; DLMM pays them to the owner's token accounts). */
  claimFees?: boolean;
  /** Set when the base token carries the cross_gate transfer hook: its accounts are added to the withdrawal. */
  hook?: boolean;
};

export type RebalanceLadder = {
  /** Withdraw everything from the old position, claim its fees and close it. Send first. */
  withdraw: Instruction[];
  /** Open the new position and lay the base above the active bin. Send after `withdraw` has landed (it spends the base that withdrawal returns). */
  relay: Instruction[];
  lowerBinId: number;
  upperBinId: number;
};

function slices(hookLen: number): Buffer {
  const b = Buffer.alloc(4 + (hookLen > 0 ? 2 : 0));
  b.writeUInt32LE(hookLen > 0 ? 1 : 0, 0);
  if (hookLen > 0) {
    b.writeUInt8(0, 4);
    b.writeUInt8(hookLen, 5);
  }
  return b;
}

export async function buildRebalanceLadder(input: RebalanceLadderInput): Promise<RebalanceLadder> {
  const c = input.cross.data;
  const d = dlmmAddresses(c.baseMint, c.quoteMint);
  if (input.upperBinId < input.lowerBinId) throw new Error('the position range is empty');
  if (input.baseAmount <= 0n) throw new Error('there is no base to lay again: baseAmount must be positive');
  const arrays: Address[] = [];
  for (let i = binArrayIndex(input.lowerBinId); i <= binArrayIndex(input.upperBinId); i++) arrays.push(binArrayAddress(d.lbPair, i));
  const extras = input.hook ? await gateHookAccounts(c.baseMint, d.lbPair, input.owner.address) : [];
  const userX = await ata(input.owner.address, c.baseMint, c.baseTokenProgram);
  const userY = await ata(input.owner.address, c.quoteMint, c.quoteTokenProgram);
  const withdraw: Instruction[] = [];
  if (input.claimFees ?? true) {
    const data = Buffer.alloc(8 + 4 + 4);
    let o = disc('claim_fee2').copy(data, 0);
    data.writeInt32LE(input.lowerBinId, o); o += 4;
    data.writeInt32LE(input.upperBinId, o);
    withdraw.push({
      programAddress: DLMM_PROGRAM_ADDRESS,
      accounts: [
        { address: d.lbPair, role: AccountRole.WRITABLE },
        { address: input.position, role: AccountRole.WRITABLE },
        { address: input.owner.address, role: AccountRole.READONLY_SIGNER, signer: input.owner } as never,
        { address: d.reserveX, role: AccountRole.WRITABLE },
        { address: d.reserveY, role: AccountRole.WRITABLE },
        { address: userX, role: AccountRole.WRITABLE },
        { address: userY, role: AccountRole.WRITABLE },
        { address: c.baseMint, role: AccountRole.READONLY },
        { address: c.quoteMint, role: AccountRole.READONLY },
        { address: c.baseTokenProgram, role: AccountRole.READONLY },
        { address: c.quoteTokenProgram, role: AccountRole.READONLY },
        { address: MEMO, role: AccountRole.READONLY },
        { address: d.eventAuthority, role: AccountRole.READONLY },
        { address: DLMM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
        ...extras,
        ...arrays.map((a) => ({ address: a, role: AccountRole.WRITABLE })),
      ],
      data: new Uint8Array(Buffer.concat([data, slices(extras.length)])),
    });
  }
  const remove = Buffer.alloc(8 + 4 + 4 + 2);
  let o = disc('remove_liquidity_by_range2').copy(remove, 0);
  remove.writeInt32LE(input.lowerBinId, o); o += 4;
  remove.writeInt32LE(input.upperBinId, o); o += 4;
  remove.writeUInt16LE(10_000, o);
  withdraw.push({
    programAddress: DLMM_PROGRAM_ADDRESS,
    accounts: [
      { address: input.position, role: AccountRole.WRITABLE },
      { address: d.lbPair, role: AccountRole.WRITABLE },
      { address: DLMM_PROGRAM_ADDRESS, role: AccountRole.READONLY }, // no bitmap extension
      { address: userX, role: AccountRole.WRITABLE },
      { address: userY, role: AccountRole.WRITABLE },
      { address: d.reserveX, role: AccountRole.WRITABLE },
      { address: d.reserveY, role: AccountRole.WRITABLE },
      { address: c.baseMint, role: AccountRole.READONLY },
      { address: c.quoteMint, role: AccountRole.READONLY },
      { address: input.owner.address, role: AccountRole.READONLY_SIGNER, signer: input.owner } as never,
      { address: c.baseTokenProgram, role: AccountRole.READONLY },
      { address: c.quoteTokenProgram, role: AccountRole.READONLY },
      { address: MEMO, role: AccountRole.READONLY },
      { address: d.eventAuthority, role: AccountRole.READONLY },
      { address: DLMM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
      ...extras,
      ...arrays.map((a) => ({ address: a, role: AccountRole.WRITABLE })),
    ],
    data: new Uint8Array(Buffer.concat([remove, slices(extras.length)])),
  });
  withdraw.push({
    programAddress: DLMM_PROGRAM_ADDRESS,
    accounts: [
      { address: input.position, role: AccountRole.WRITABLE },
      { address: input.owner.address, role: AccountRole.READONLY_SIGNER, signer: input.owner } as never,
      { address: input.owner.address, role: AccountRole.WRITABLE },
      { address: d.eventAuthority, role: AccountRole.READONLY },
      { address: DLMM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    ],
    data: new Uint8Array(disc('close_position2')),
  });
  const ladder = await buildDlmmConvictionLadder({
    cross: input.cross,
    creator: input.owner,
    position: input.newPosition,
    activeId: input.activeId,
    bins: input.bins,
    baseAmount: input.baseAmount,
    ...(input.shape && { shape: input.shape }),
    ...(input.existingBinArrays && { existingBinArrays: input.existingBinArrays }),
    maxActiveBinSlippage: input.maxActiveBinSlippage ?? 2,
  });
  return { withdraw, relay: ladder.instructions, lowerBinId: ladder.lowerBinId, upperBinId: ladder.upperBinId };
}
