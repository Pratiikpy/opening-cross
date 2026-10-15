// The buyer's side of the fixed-price tranche (ADR-0916; row B4): the instructions that take a buyer from "there is a tranche at the clearing price" to "I hold the tokens",
// and the creator's withdrawal of what the tranche raised. They are Meteora's Presale Vault instructions (`idls/presale.json`); `open_fixed_price_presale` in `cross_settle`
// (`presale.ts`) only opens the sale. Meteora publishes no buyer page address that this repository can verify, so these builders are the link: an app that sends them
// has the buyer deposit into the tranche without leaving Opening Bell.
//
// A base token with the cross_gate transfer hook (a launch minted through the DBC continuation) needs the hook's accounts on every transfer of it: when the creator funds
// the tranche, and when a buyer claims. `hook: true` adds them, with the slice the vault reads them by (`TransferHookBase`).
import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { AccountRole, type Address, type Instruction, type TransactionSigner, address, getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';
import { getCreateAssociatedTokenIdempotentInstruction } from '@solana-program/token';
import { type CrossView, ata } from '@opening-cross/sdk';
import { PRESALE_AUTHORITY, PRESALE_PROGRAM_ADDRESS } from './presale.js';
import { gateHookAccounts } from './partner.js';

const SYSTEM_PROGRAM = address('11111111111111111111111111111111');
const MEMO_PROGRAM = address('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const enc = getAddressEncoder();
const text = (s: string) => new TextEncoder().encode(s);
const disc = (name: string) => createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
const u64 = (v: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v);
  return b;
};

const eventAuthority = async () => (await getProgramDerivedAddress({ programAddress: PRESALE_PROGRAM_ADDRESS, seeds: [text('__event_authority')] }))[0];

/** The buyer's escrow in a permissionless sale: `["escrow", presale, owner, 0]` (registry index 0). */
export async function presaleEscrowAddress(presale: Address, owner: Address): Promise<Address> {
  return (await getProgramDerivedAddress({ programAddress: PRESALE_PROGRAM_ADDRESS, seeds: [text('escrow'), enc.encode(presale) as Uint8Array, enc.encode(owner) as Uint8Array, new Uint8Array([0])] }))[0];
}

/** `RemainingAccountsInfo` with one slice of `length` hook accounts for the base or the quote token, or none. */
function hookInfo(length: number, side: 'base' | 'quote'): Buffer {
  const b = Buffer.alloc(4 + (length > 0 ? 2 : 0));
  b.writeUInt32LE(length > 0 ? 1 : 0, 0);
  if (length > 0) {
    b.writeUInt8(side === 'base' ? 0 : 1, 4);
    b.writeUInt8(length, 5);
  }
  return b;
}

/** Opens the buyer's escrow. Anyone may pay its rent for the buyer; the sale must be ongoing. */
export async function buildPresaleCreateEscrow(input: { presale: Address; owner: Address; payer: TransactionSigner }): Promise<Instruction> {
  return {
    programAddress: PRESALE_PROGRAM_ADDRESS,
    accounts: [
      { address: input.presale, role: AccountRole.WRITABLE },
      { address: await presaleEscrowAddress(input.presale, input.owner), role: AccountRole.WRITABLE },
      { address: input.owner, role: AccountRole.READONLY },
      { address: input.payer.address, role: AccountRole.WRITABLE_SIGNER, signer: input.payer } as never,
      { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
      { address: await eventAuthority(), role: AccountRole.READONLY },
      { address: PRESALE_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    ],
    data: new Uint8Array(disc('create_permissionless_escrow')),
  };
}

export type PresaleDepositInput = {
  presale: Address;
  /** The presale's quote vault (`presaleAddresses(...).quoteTokenVault`). */
  quoteTokenVault: Address;
  quoteMint: Address;
  quoteTokenProgram: Address;
  buyer: TransactionSigner;
  /** The most quote the buyer will pay; the vault takes less when the sale's cap or the buyer's cap leaves less room. */
  maxAmount: bigint;
  /** Opens the escrow in the same transaction. */
  createEscrow?: boolean;
};

/** Deposits quote into the tranche (and opens the buyer's escrow first when asked). The fixed price means a buyer's tokens are `deposit x price_scale / P*`. */
export async function buildPresaleDeposit(input: PresaleDepositInput): Promise<Instruction[]> {
  if (input.maxAmount <= 0n) throw new Error('deposit a positive amount');
  const out: Instruction[] = [];
  if (input.createEscrow) out.push(await buildPresaleCreateEscrow({ presale: input.presale, owner: input.buyer.address, payer: input.buyer }));
  out.push({
    programAddress: PRESALE_PROGRAM_ADDRESS,
    accounts: [
      { address: input.presale, role: AccountRole.WRITABLE },
      { address: input.quoteTokenVault, role: AccountRole.WRITABLE },
      { address: input.quoteMint, role: AccountRole.READONLY },
      { address: await presaleEscrowAddress(input.presale, input.buyer.address), role: AccountRole.WRITABLE },
      { address: await ata(input.buyer.address, input.quoteMint, input.quoteTokenProgram), role: AccountRole.WRITABLE },
      { address: input.buyer.address, role: AccountRole.READONLY_SIGNER, signer: input.buyer } as never,
      { address: input.quoteTokenProgram, role: AccountRole.READONLY },
      { address: await eventAuthority(), role: AccountRole.READONLY },
      { address: PRESALE_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    ],
    data: new Uint8Array(Buffer.concat([disc('deposit'), u64(input.maxAmount), hookInfo(0, 'quote')])),
  });
  return out;
}

export type PresaleClaimInput = {
  presale: Address;
  /** The presale's base vault (`presaleAddresses(...).presaleVault`). */
  baseTokenVault: Address;
  baseMint: Address;
  baseTokenProgram: Address;
  buyer: TransactionSigner;
  /** The base token carries the cross_gate transfer hook: add its accounts (the buyer's pass, the vault authority's lock, the hook program and its meta list). */
  hook?: boolean;
};

/** After the sale has completed: the buyer claims the base tokens their deposit bought, into their own account (created when missing). */
export async function buildPresaleClaim(input: PresaleClaimInput): Promise<Instruction[]> {
  const destination = await ata(input.buyer.address, input.baseMint, input.baseTokenProgram);
  const ensure = getCreateAssociatedTokenIdempotentInstruction({ payer: input.buyer, ata: destination, owner: input.buyer.address, mint: input.baseMint, tokenProgram: input.baseTokenProgram }) as Instruction;
  const extras = input.hook ? await gateHookAccounts(input.baseMint, PRESALE_AUTHORITY, input.buyer.address) : [];
  return [
    ensure,
    {
      programAddress: PRESALE_PROGRAM_ADDRESS,
      accounts: [
        { address: input.presale, role: AccountRole.WRITABLE },
        { address: input.baseTokenVault, role: AccountRole.WRITABLE },
        { address: input.baseMint, role: AccountRole.READONLY },
        { address: PRESALE_AUTHORITY, role: AccountRole.READONLY },
        { address: await presaleEscrowAddress(input.presale, input.buyer.address), role: AccountRole.WRITABLE },
        { address: destination, role: AccountRole.WRITABLE },
        { address: input.buyer.address, role: AccountRole.READONLY_SIGNER, signer: input.buyer } as never,
        { address: input.baseTokenProgram, role: AccountRole.READONLY },
        { address: MEMO_PROGRAM, role: AccountRole.READONLY },
        { address: await eventAuthority(), role: AccountRole.READONLY },
        { address: PRESALE_PROGRAM_ADDRESS, role: AccountRole.READONLY },
        ...extras,
      ],
      data: new Uint8Array(Buffer.concat([disc('claim'), hookInfo(extras.length, 'base')])),
    },
  ];
}

/** The part of a `Presale` account the app reads: its caps, times, deposits and vaults (`idls/presale.json`; offsets after the 8-byte discriminator). */
export type PresaleState = {
  owner: Address;
  quoteMint: Address;
  baseMint: Address;
  baseTokenVault: Address;
  quoteTokenVault: Address;
  base: Address;
  maxCap: bigint;
  minCap: bigint;
  start: bigint;
  end: bigint;
  supply: bigint;
  totalDeposit: bigint;
  hasCreatorWithdrawn: boolean;
};
const PRESALE_DISCRIMINATOR = [...createHash('sha256').update('account:Presale').digest().subarray(0, 8)];

/** Decodes a `Presale` account; null when the bytes are not one. */
export function decodePresale(data: Uint8Array): PresaleState | null {
  if (data.length < 1272 || !PRESALE_DISCRIMINATOR.every((b, i) => data[i] === b)) return null;
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const key = (at: number): Address => address(new PublicKey(data.subarray(at, at + 32)).toBase58());
  return { owner: key(8), quoteMint: key(40), baseMint: key(72), baseTokenVault: key(104), quoteTokenVault: key(136), base: key(168), maxCap: v.getBigUint64(208, true), minCap: v.getBigUint64(216, true), start: v.getBigUint64(224, true), end: v.getBigUint64(232, true), supply: v.getBigUint64(240, true), totalDeposit: v.getBigUint64(248, true), hasCreatorWithdrawn: data[352] === 1 };
}

/**
 * Where a sale stands: `completed` when it has ended with the minimum raised (or sold out before its end, which Meteora's program also treats as completed; the tolerance of two atoms
 * is the rounding of the vault's own cap), `failed` when it has ended without the minimum, `ongoing` between its start and end, `not-started` before. Pure.
 */
export function presaleOutcome(p: Pick<PresaleState, 'start' | 'end' | 'minCap' | 'maxCap' | 'totalDeposit'>, now: bigint): 'not-started' | 'ongoing' | 'completed' | 'failed' {
  if (now < p.start) return 'not-started';
  if (p.maxCap - p.totalDeposit <= 2n && p.totalDeposit >= p.minCap) return 'completed';
  if (now < p.end) return 'ongoing';
  return p.totalDeposit >= p.minCap ? 'completed' : 'failed';
}

/**
 * The creator's withdrawal, once. After a completed sale it pays the quote raised into the creator's quote account; after a failed one it returns the base supply into the creator's base
 * account. Meteora's program reads the vault and the mint it moves from as the first two remaining accounts (then the hook's, for a hooked base).
 */
export async function buildPresaleCreatorWithdraw(input: { presale: Address; cross: CrossView; creator: TransactionSigner; outcome: 'completed' | 'failed'; quoteTokenVault: Address; baseTokenVault: Address; /** The base token carries the cross_gate hook (needed to return the base of a failed sale). */ hook?: boolean }): Promise<Instruction> {
  const c = input.cross.data;
  const failed = input.outcome === 'failed';
  const extras = failed && input.hook ? await gateHookAccounts(c.baseMint, PRESALE_AUTHORITY, input.creator.address) : [];
  const ownerToken = failed ? await ata(input.creator.address, c.baseMint, c.baseTokenProgram) : await ata(input.creator.address, c.quoteMint, c.quoteTokenProgram);
  return {
    programAddress: PRESALE_PROGRAM_ADDRESS,
    accounts: [
      { address: input.presale, role: AccountRole.WRITABLE },
      { address: PRESALE_AUTHORITY, role: AccountRole.READONLY },
      { address: ownerToken, role: AccountRole.WRITABLE },
      { address: input.creator.address, role: AccountRole.READONLY_SIGNER, signer: input.creator } as never,
      { address: failed ? c.baseTokenProgram : c.quoteTokenProgram, role: AccountRole.READONLY },
      { address: MEMO_PROGRAM, role: AccountRole.READONLY },
      { address: await eventAuthority(), role: AccountRole.READONLY },
      { address: PRESALE_PROGRAM_ADDRESS, role: AccountRole.READONLY },
      { address: failed ? input.baseTokenVault : input.quoteTokenVault, role: AccountRole.WRITABLE },
      { address: failed ? c.baseMint : c.quoteMint, role: AccountRole.READONLY },
      ...extras,
    ],
    data: new Uint8Array(Buffer.concat([disc('creator_withdraw'), hookInfo(extras.length, 'base')])),
  };
}
