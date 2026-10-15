// Meteora Alpha Vault: fair entry into a pool before it opens to the public (ADR-0484, rows X13/R2 and X12/C1).
//
// A batch-opened market (ADR-0483) is closed to trading until its start. An Alpha Vault bound to that pool lets people who
// missed the cross deposit quote tokens during a window; at the pool's pre-activation point the vault buys base tokens from the
// pool in one fill, and every depositor claims its share. Pro-rata mode scales everyone down equally when the vault is
// oversubscribed; first-come mode closes the vault at its cap. The vault is bound to one pool and one pair of mints at creation.
//
// Layouts are from the program's published IDL (`idls/alpha_vault.json`, Meteora damm-v2 `tests/helpers/idl`, Apache-2.0).
// This file covers DAMM v2 pools (pool type 2); the DLMM fill (pool type 0), the depositor's withdraw and the escrow close are in `alphavault-dlmm.ts`.
import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { AccountRole, type Address, type Instruction, type TransactionSigner, address } from '@solana/kit';
import { getCreateAssociatedTokenIdempotentInstruction } from '@solana-program/token';
import { ata } from '@opening-cross/sdk';

/** Mainnet and devnet program id (`@meteora-ag/alpha-vault` 1.1.16). */
export const ALPHA_VAULT_PROGRAM_ADDRESS = address('vaU6kP7iNEGkbmPkLmZfGwiGxd4Mob24QQCie5R9kd2');
/** The vault's treasury, which receives escrow and crank fees unless a crank-fee whitelist applies (from the IDL). */
export const ALPHA_VAULT_TREASURY_ADDRESS = address('BJQbRiRWhJCyTYZcAuAL3ngDCx3AyFQGKDq8zhiZAKUw');
const PROGRAM = new PublicKey(ALPHA_VAULT_PROGRAM_ADDRESS);
const SYSTEM_PROGRAM = address('11111111111111111111111111111111');

/** Pool types the vault supports (`pool_type`). */
export const AlphaPoolType = { Dlmm: 0, DynamicAmm: 1, DammV2: 2 } as const;
/** Whitelist modes (`whitelist_mode`). */
export const AlphaWhitelist = { Permissionless: 0, PermissionedWithMerkleProof: 1, PermissionedWithAuthority: 2 } as const;

const disc = (name: string) => createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
const toKit = (k: PublicKey): Address => address(k.toBase58());

export function alphaVaultAddresses(base: Address, pool: Address) {
  const vault = PublicKey.findProgramAddressSync([Buffer.from('vault'), new PublicKey(base).toBuffer(), new PublicKey(pool).toBuffer()], PROGRAM)[0];
  return {
    vault: toKit(vault),
    eventAuthority: toKit(PublicKey.findProgramAddressSync([Buffer.from('__event_authority')], PROGRAM)[0]),
  };
}

export function alphaEscrowAddress(vault: Address, owner: Address): Address {
  return toKit(PublicKey.findProgramAddressSync([Buffer.from('escrow'), new PublicKey(vault).toBuffer(), new PublicKey(owner).toBuffer()], PROGRAM)[0]);
}

const u64 = (v: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v);
  return b;
};

export type AlphaVaultInput = {
  funder: TransactionSigner;
  /**
   * The signer that makes the vault address unique. For a DAMM v2 pool it must be the account that created the pool (the creator
   * that seeded it): DAMM v2 records only the vault derived from that account, and the vault refuses any other pool binding.
   */
  base: TransactionSigner;
  pool: Address;
  poolType?: number;
  baseMint: Address;
  baseTokenProgram: Address;
  quoteMint: Address;
  quoteTokenProgram: Address;
  /** Pool-denominated time points (the pool's activation type: unix seconds for a timestamp pool). */
  depositingPoint?: bigint;
  startVestingPoint: bigint;
  endVestingPoint: bigint;
  /** Lamports each depositor pays to open an escrow. */
  escrowFee?: bigint;
  whitelistMode?: number;
} & ({ mode: 'prorata'; maxBuyingCap: bigint } | { mode: 'fcfs'; maxDepositingCap: bigint; individualDepositingCap: bigint });

/** Creates the vault and its two token accounts (quote in, base out). Returns the instructions in the order they must run. */
export async function buildInitializeAlphaVault(input: AlphaVaultInput): Promise<{ instructions: Instruction[]; vault: Address; tokenVault: Address; tokenOutVault: Address }> {
  const a = alphaVaultAddresses(input.base.address, input.pool);
  const tokenVault = await ata(a.vault, input.quoteMint, input.quoteTokenProgram);
  const tokenOutVault = await ata(a.vault, input.baseMint, input.baseTokenProgram);
  const ensure = (mint: Address, tokenProgram: Address, account: Address) => getCreateAssociatedTokenIdempotentInstruction({ payer: input.funder, ata: account, owner: a.vault, mint, tokenProgram }) as Instruction;
  const common = [
    Buffer.from([input.poolType ?? AlphaPoolType.DammV2]),
    Buffer.from(new PublicKey(input.quoteMint).toBytes()),
    Buffer.from(new PublicKey(input.baseMint).toBytes()),
    u64(input.depositingPoint ?? 0n),
    u64(input.startVestingPoint),
    u64(input.endVestingPoint),
  ];
  const whitelist = Buffer.from([input.whitelistMode ?? AlphaWhitelist.Permissionless]);
  const data =
    input.mode === 'prorata'
      ? Buffer.concat([disc('initialize_prorata_vault'), ...common, u64(input.maxBuyingCap), u64(input.escrowFee ?? 0n), whitelist])
      : Buffer.concat([disc('initialize_fcfs_vault'), ...common, u64(input.maxDepositingCap), u64(input.individualDepositingCap), u64(input.escrowFee ?? 0n), whitelist]);
  const init: Instruction = {
    programAddress: ALPHA_VAULT_PROGRAM_ADDRESS,
    accounts: [
      { address: a.vault, role: AccountRole.WRITABLE },
      { address: input.pool, role: AccountRole.READONLY },
      { address: input.funder.address, role: AccountRole.WRITABLE_SIGNER, signer: input.funder } as never,
      { address: input.base.address, role: AccountRole.READONLY_SIGNER, signer: input.base } as never,
      { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
      { address: a.eventAuthority, role: AccountRole.READONLY },
      { address: ALPHA_VAULT_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    ],
    data: new Uint8Array(data),
  };
  return { instructions: [ensure(input.quoteMint, input.quoteTokenProgram, tokenVault), ensure(input.baseMint, input.baseTokenProgram, tokenOutVault), init], vault: a.vault, tokenVault, tokenOutVault };
}

export type AlphaDepositInput = { vault: Address; pool: Address; owner: TransactionSigner; payer?: TransactionSigner; quoteMint: Address; quoteTokenProgram: Address; amount: bigint; tokenVault: Address; withEscrow?: boolean };

/** Opens the owner's escrow (once) and deposits `amount` quote atoms. */
export async function buildAlphaDeposit(input: AlphaDepositInput): Promise<Instruction[]> {
  const events = toKit(PublicKey.findProgramAddressSync([Buffer.from('__event_authority')], PROGRAM)[0]);
  const payer = input.payer ?? input.owner;
  const escrow = alphaEscrowAddress(input.vault, input.owner.address);
  const out: Instruction[] = [];
  if (input.withEscrow ?? true) {
    out.push({
      programAddress: ALPHA_VAULT_PROGRAM_ADDRESS,
      accounts: [
        { address: input.vault, role: AccountRole.WRITABLE },
        { address: input.pool, role: AccountRole.READONLY },
        { address: escrow, role: AccountRole.WRITABLE },
        { address: input.owner.address, role: AccountRole.READONLY },
        { address: payer.address, role: AccountRole.WRITABLE_SIGNER, signer: payer } as never,
        { address: ALPHA_VAULT_TREASURY_ADDRESS, role: AccountRole.WRITABLE },
        { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
        { address: events, role: AccountRole.READONLY },
        { address: ALPHA_VAULT_PROGRAM_ADDRESS, role: AccountRole.READONLY },
      ],
      data: new Uint8Array(disc('create_new_escrow')),
    });
  }
  out.push({
    programAddress: ALPHA_VAULT_PROGRAM_ADDRESS,
    accounts: [
      { address: input.vault, role: AccountRole.WRITABLE },
      { address: input.pool, role: AccountRole.READONLY },
      { address: escrow, role: AccountRole.WRITABLE },
      { address: await ata(input.owner.address, input.quoteMint, input.quoteTokenProgram), role: AccountRole.WRITABLE },
      { address: input.tokenVault, role: AccountRole.WRITABLE },
      { address: input.quoteMint, role: AccountRole.READONLY },
      { address: input.quoteTokenProgram, role: AccountRole.READONLY },
      { address: input.owner.address, role: AccountRole.READONLY_SIGNER, signer: input.owner } as never,
      { address: events, role: AccountRole.READONLY },
      { address: ALPHA_VAULT_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    ],
    data: new Uint8Array(Buffer.concat([disc('deposit'), u64(input.amount)])),
  });
  return out;
}

export type AlphaFillInput = {
  vault: Address;
  cranker: TransactionSigner;
  maxAmount: bigint;
  tokenVault: Address;
  tokenOutVault: Address;
  /** The DAMM v2 pool and its accounts, as the pool stores them. */
  pool: { address: Address; authority: Address; tokenAVault: Address; tokenBVault: Address; tokenAMint: Address; tokenBMint: Address; tokenAProgram: Address; tokenBProgram: Address; eventAuthority: Address; programAddress: Address };
};

/** Permissionless crank: the vault buys base from the pool with up to `maxAmount` of the quote it holds (pre-activation, at the pool's lowest fee). */
export function buildAlphaFillDammV2(input: AlphaFillInput): Instruction {
  const events = toKit(PublicKey.findProgramAddressSync([Buffer.from('__event_authority')], PROGRAM)[0]);
  const p = input.pool;
  return {
    programAddress: ALPHA_VAULT_PROGRAM_ADDRESS,
    accounts: [
      { address: input.vault, role: AccountRole.WRITABLE },
      { address: input.tokenVault, role: AccountRole.WRITABLE },
      { address: input.tokenOutVault, role: AccountRole.WRITABLE },
      { address: p.programAddress, role: AccountRole.READONLY },
      { address: p.authority, role: AccountRole.READONLY },
      { address: p.address, role: AccountRole.WRITABLE },
      { address: p.tokenAVault, role: AccountRole.WRITABLE },
      { address: p.tokenBVault, role: AccountRole.WRITABLE },
      { address: p.tokenAMint, role: AccountRole.READONLY },
      { address: p.tokenBMint, role: AccountRole.READONLY },
      { address: p.tokenAProgram, role: AccountRole.READONLY },
      { address: p.tokenBProgram, role: AccountRole.READONLY },
      { address: p.eventAuthority, role: AccountRole.READONLY },
      { address: ALPHA_VAULT_PROGRAM_ADDRESS, role: AccountRole.READONLY }, // crank_fee_whitelist: None
      { address: ALPHA_VAULT_TREASURY_ADDRESS, role: AccountRole.WRITABLE },
      { address: input.cranker.address, role: AccountRole.WRITABLE_SIGNER, signer: input.cranker } as never,
      { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
      { address: events, role: AccountRole.READONLY },
      { address: ALPHA_VAULT_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    ],
    data: new Uint8Array(Buffer.concat([disc('fill_damm_v2'), u64(input.maxAmount)])),
  };
}

/** After the vesting start, a depositor claims the base tokens its share of the fill earns. */
export async function buildAlphaClaim(input: { vault: Address; owner: TransactionSigner; baseMint: Address; baseTokenProgram: Address; tokenOutVault: Address }): Promise<Instruction[]> {
  const events = toKit(PublicKey.findProgramAddressSync([Buffer.from('__event_authority')], PROGRAM)[0]);
  const destination = await ata(input.owner.address, input.baseMint, input.baseTokenProgram);
  const ensure = getCreateAssociatedTokenIdempotentInstruction({ payer: input.owner, ata: destination, owner: input.owner.address, mint: input.baseMint, tokenProgram: input.baseTokenProgram }) as Instruction;
  return [
    ensure,
    {
      programAddress: ALPHA_VAULT_PROGRAM_ADDRESS,
      accounts: [
        { address: input.vault, role: AccountRole.WRITABLE },
        { address: alphaEscrowAddress(input.vault, input.owner.address), role: AccountRole.WRITABLE },
        { address: input.tokenOutVault, role: AccountRole.WRITABLE },
        { address: destination, role: AccountRole.WRITABLE },
        { address: input.baseMint, role: AccountRole.READONLY },
        { address: input.baseTokenProgram, role: AccountRole.READONLY },
        { address: input.owner.address, role: AccountRole.READONLY_SIGNER, signer: input.owner } as never,
        { address: events, role: AccountRole.READONLY },
        { address: ALPHA_VAULT_PROGRAM_ADDRESS, role: AccountRole.READONLY },
      ],
      data: new Uint8Array(disc('claim_token')),
    },
  ];
}

/** A pro-rata vault that was oversubscribed returns the quote it did not spend; the depositor takes it back. */
export async function buildAlphaWithdrawRemaining(input: { vault: Address; pool: Address; owner: TransactionSigner; quoteMint: Address; quoteTokenProgram: Address; tokenVault: Address }): Promise<Instruction> {
  const events = toKit(PublicKey.findProgramAddressSync([Buffer.from('__event_authority')], PROGRAM)[0]);
  return {
    programAddress: ALPHA_VAULT_PROGRAM_ADDRESS,
    accounts: [
      { address: input.vault, role: AccountRole.WRITABLE },
      { address: input.pool, role: AccountRole.READONLY },
      { address: alphaEscrowAddress(input.vault, input.owner.address), role: AccountRole.WRITABLE },
      { address: input.tokenVault, role: AccountRole.WRITABLE },
      { address: await ata(input.owner.address, input.quoteMint, input.quoteTokenProgram), role: AccountRole.WRITABLE },
      { address: input.quoteMint, role: AccountRole.READONLY },
      { address: input.quoteTokenProgram, role: AccountRole.READONLY },
      { address: input.owner.address, role: AccountRole.READONLY_SIGNER, signer: input.owner } as never,
      { address: events, role: AccountRole.READONLY },
      { address: ALPHA_VAULT_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    ],
    data: new Uint8Array(disc('withdraw_remaining_quote')),
  };
}
