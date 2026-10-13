// Greenshoe builders (ADR-0487, rows D4, VM8, X18): standing DLMM bids under the clearing price, held by `cross_settle` for a week.
import { AccountRole, type Address, type Instruction, type TransactionSigner, address, getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';
import {
  CROSS_SETTLE_PROGRAM_ADDRESS,
  getCreateGreenshoeInstruction,
  getDeployGreenshoeBidInstruction,
  getFinishGreenshoeInstruction,
  getSettleGreenshoeLevelInstruction,
} from '@opening-cross/cross-settle-client';
import { type CrossView, ata } from '@opening-cross/sdk';
import { DLMM_PROGRAM_ADDRESS, binArrayAddress, binArrayIndex, binPriceQ64, dlmmAddresses } from './dlmm.js';
import { gateHookAccounts } from './partner.js';

const enc = getAddressEncoder();
const text = (s: string) => new TextEncoder().encode(s);
const MEMO_PROGRAM = address('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

/** The three bid levels as shares of P*, in basis points: 0.90, 0.85, 0.80 (mirrors `greenshoe::LEVELS_BPS`). */
export const GREENSHOE_LEVELS_BPS = [9_000, 8_500, 8_000] as const;
/** How long the bids stand, in seconds. */
export const GREENSHOE_WINDOW_SECS = 7 * 24 * 60 * 60;
/** The least budget, in basis points of what the cross's buyers paid. */
export const GREENSHOE_MIN_BUDGET_BPS = 1_000n;

/** The least budget the program accepts for a cross whose buyers paid `buyerPaid` (rounded up). */
export const greenshoeMinBudget = (buyerPaid: bigint): bigint => (buyerPaid * GREENSHOE_MIN_BUDGET_BPS + 9_999n) / 10_000n;

/** The most one level may hold: a third of the budget, rounded up. */
export const greenshoeLevelCap = (budget: bigint): bigint => (budget + 2n) / 3n;

/** The bin whose price is nearest `level`'s target (a share of P*), within half a bin step; mirrors the program's check. */
export function greenshoeBinFor(price: bigint, priceScale: bigint, binStep: number, level: number): number {
  const target = (price * BigInt(GREENSHOE_LEVELS_BPS[level]!)) / 10_000n;
  const approx = Math.round(Math.log(Number(target) / Number(priceScale)) / Math.log(1 + binStep / 10_000));
  for (const id of [approx, approx - 1, approx + 1, approx - 2, approx + 2]) {
    const bin = binPriceQ64(id, binStep);
    const p = (target << 64n) / priceScale;
    if (p >= (bin * BigInt(20_000 - binStep)) / 20_000n && p <= (bin * BigInt(20_000 + binStep)) / 20_000n) return id;
  }
  throw new Error('no DLMM bin within half a step of the level price');
}

export async function greenshoeAddresses(cross: Address) {
  const pda = async (seed: string, of: Address) => (await getProgramDerivedAddress({ programAddress: CROSS_SETTLE_PROGRAM_ADDRESS, seeds: [text(seed), enc.encode(of)] }))[0];
  const greenshoe = await pda('greenshoe', cross);
  return { greenshoe, vault: await pda('greenshoe_vault', greenshoe), baseAccount: await pda('greenshoe_base', greenshoe) };
}

async function dlmmEvents(): Promise<Address> {
  return (await getProgramDerivedAddress({ programAddress: DLMM_PROGRAM_ADDRESS, seeds: [text('__event_authority')] }))[0];
}

export type CreateGreenshoeInput = { cross: CrossView; creator: TransactionSigner; budget: bigint; startTs: bigint; periodSecs: bigint; periodCap: bigint };

/** Commits `budget` quote atoms to the greenshoe. The cross must be finalized and have a DLMM pair opened by `open_dlmm_pair*`. */
export async function buildCreateGreenshoe(input: CreateGreenshoeInput): Promise<Instruction> {
  const c = input.cross.data;
  const a = await greenshoeAddresses(input.cross.address);
  return getCreateGreenshoeInstruction({
    creator: input.creator,
    cross: input.cross.address,
    greenshoe: a.greenshoe,
    vault: a.vault,
    baseAccount: a.baseAccount,
    baseMint: c.baseMint,
    quoteMint: c.quoteMint,
    creatorQuote: await ata(input.creator.address, c.quoteMint, c.quoteTokenProgram),
    lbPair: dlmmAddresses(c.baseMint, c.quoteMint).lbPair,
    baseTokenProgram: c.baseTokenProgram,
    quoteTokenProgram: c.quoteTokenProgram,
    budget: input.budget,
    startTs: input.startTs,
    periodSecs: input.periodSecs,
    periodCap: input.periodCap,
  });
}

export type DeployGreenshoeBidInput = { cross: CrossView; payer: TransactionSigner; limitOrder: TransactionSigner; level: number; binId: number; amount: bigint };

/** Places one level as a DLMM limit order owned by the program. `limitOrder` is a fresh keypair that signs once. */
export async function buildDeployGreenshoeBid(input: DeployGreenshoeBidInput): Promise<Instruction> {
  const c = input.cross.data;
  const a = await greenshoeAddresses(input.cross.address);
  const d = dlmmAddresses(c.baseMint, c.quoteMint);
  const ix = getDeployGreenshoeBidInstruction({
    payer: input.payer,
    greenshoe: a.greenshoe,
    vault: a.vault,
    lbPair: d.lbPair,
    binArrayBitmapExtension: DLMM_PROGRAM_ADDRESS, // None, by Anchor's convention
    reserveY: d.reserveY,
    quoteMint: c.quoteMint,
    limitOrder: input.limitOrder,
    dlmmEventAuthority: await dlmmEvents(),
    quoteTokenProgram: c.quoteTokenProgram,
    level: input.level,
    binId: input.binId,
    amount: input.amount,
  } as Parameters<typeof getDeployGreenshoeBidInstruction>[0]);
  // DLMM reads the bin array that holds the bin from the remaining accounts; it must exist (`initialize_bin_array`) before this runs.
  return { ...ix, accounts: [...(ix.accounts ?? []), { address: binArrayAddress(d.lbPair, binArrayIndex(input.binId)), role: AccountRole.WRITABLE }] } as Instruction;
}

export type SettleGreenshoeLevelInput = { cross: CrossView; rentReceiver: Address; level: number; limitOrder: Address; binId: number; /** False for a base mint without the cross_gate transfer hook. */ hook?: boolean };

/** After the week: cancels a placed level, runs the base token's transfer hook for the fill and closes the limit order. */
export async function buildSettleGreenshoeLevel(input: SettleGreenshoeLevelInput): Promise<Instruction> {
  const c = input.cross.data;
  const a = await greenshoeAddresses(input.cross.address);
  const d = dlmmAddresses(c.baseMint, c.quoteMint);
  const extras = input.hook === false ? [] : await gateHookAccounts(c.baseMint, d.lbPair, a.greenshoe);
  const ix = getSettleGreenshoeLevelInstruction({
    rentReceiver: input.rentReceiver,
    greenshoe: a.greenshoe,
    vault: a.vault,
    baseAccount: a.baseAccount,
    lbPair: d.lbPair,
    binArrayBitmapExtension: DLMM_PROGRAM_ADDRESS, // None, by Anchor's convention
    reserveX: d.reserveX,
    reserveY: d.reserveY,
    baseMint: c.baseMint,
    quoteMint: c.quoteMint,
    limitOrder: input.limitOrder,
    memoProgram: MEMO_PROGRAM,
    dlmmEventAuthority: await dlmmEvents(),
    baseTokenProgram: c.baseTokenProgram,
    quoteTokenProgram: c.quoteTokenProgram,
    level: input.level,
    slices: extras.length ? [{ accountsType: { __kind: 'TransferHookX' }, length: extras.length }] : [],
  } as Parameters<typeof getSettleGreenshoeLevelInstruction>[0]);
  const binArray = { address: binArrayAddress(d.lbPair, binArrayIndex(input.binId)), role: AccountRole.WRITABLE };
  return { ...ix, accounts: [...(ix.accounts ?? []), ...extras, binArray] } as Instruction;
}

/** Burns what the bids bought and returns the unspent budget to the issuer's proceeds account. */
export async function buildFinishGreenshoe(cross: CrossView): Promise<Instruction> {
  const c = cross.data;
  const a = await greenshoeAddresses(cross.address);
  return getFinishGreenshoeInstruction({
    cross: cross.address,
    greenshoe: a.greenshoe,
    vault: a.vault,
    baseAccount: a.baseAccount,
    baseMint: c.baseMint,
    quoteMint: c.quoteMint,
    proceedsQuote: await ata(c.proceedsTo, c.quoteMint, c.quoteTokenProgram),
    baseTokenProgram: c.baseTokenProgram,
    quoteTokenProgram: c.quoteTokenProgram,
  });
}
