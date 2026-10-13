// DBC partner-side claims through cross_settle (ADR-0480, ADR-0481, ROADMAP HD4).
//
// The settler PDA of a cross is the DBC partner of its pool, so only the program can sign the partner's claims. These
// builders assemble the permissionless instructions; every destination is fixed by the cross (trading fees and the
// migration fee to the protocol fee recipient, surplus to the issuer's proceeds account), so anyone may send them.
import { AccountRole, type Address, type Instruction, getProgramDerivedAddress, getAddressEncoder, address } from '@solana/kit';
import {
  getClaimPartnerFeeInstruction,
  getClaimPartnerPoolCreationFeeInstruction,
  getClaimPolFeesInstruction,
  getWithdrawPartnerMigrationFeeInstruction,
  getWithdrawPartnerSurplusInstruction,
} from '@opening-cross/cross-settle-client';
import { CROSS_GATE_PROGRAM_ADDRESS } from '@opening-cross/cross-gate-client';
import { type CrossView, ata } from '@opening-cross/sdk';
import { TOKEN_2022, continuationAddresses, dbcConfigAddress, dbcEventAuthority, gateConfigAddress, gateHookMetasAddress, settlerAddress } from './index.js';

const enc = getAddressEncoder();
const text = (s: string) => new TextEncoder().encode(s);
const U64_MAX = 0xffff_ffff_ffff_ffffn;

/**
 * The accounts Token-2022 needs to run the `cross_gate` transfer hook on one transfer of `baseMint`: the gate config, the
 * receiving owner's pass, the sending owner's lock, the hook program and its meta list. DBC takes them as remaining
 * accounts with a slice length.
 */
export async function gateHookAccounts(baseMint: Address, sourceOwner: Address, destinationOwner: Address) {
  const pda = async (seed: string, owner: Address) => (await getProgramDerivedAddress({ programAddress: CROSS_GATE_PROGRAM_ADDRESS, seeds: [text(seed), enc.encode(baseMint), enc.encode(owner)] }))[0];
  return [
    await gateConfigAddress(baseMint),
    await pda('pass', destinationOwner),
    await pda('lock', sourceOwner),
    CROSS_GATE_PROGRAM_ADDRESS,
    await gateHookMetasAddress(baseMint),
  ].map((a) => ({ address: a, role: AccountRole.READONLY }));
}

export type PartnerClaimInput = {
  cross: CrossView;
  /** Base-token fees to claim at most; default all. Only a pool that collects fees in the base token earns any. */
  maxBase?: bigint;
  maxQuote?: bigint;
  /** Overrides the default destinations (the associated accounts of the cross's fee recipient). */
  baseDestination?: Address;
  quoteDestination?: Address;
};

/** Claims the partner's trading fees to the fee recipient's accounts. */
export async function buildClaimPartnerFee(input: PartnerClaimInput): Promise<Instruction> {
  const c = input.cross.data;
  if (c.baseMint === address('11111111111111111111111111111111')) throw new Error('the cross has no base mint yet; open and bind the DBC pool first');
  const a = await continuationAddresses(input.cross.address, c.quoteMint);
  const extras = await gateHookAccounts(c.baseMint, a.poolAuthority, c.feeRecipient);
  const base = input.baseDestination ?? (await ata(c.feeRecipient, c.baseMint, TOKEN_2022));
  const ix = getClaimPartnerFeeInstruction({
    cross: input.cross.address,
    settler: a.settler,
    dbcPoolAuthority: a.poolAuthority,
    dbcConfig: a.config,
    pool: a.pool,
    baseDestination: base,
    quoteDestination: input.quoteDestination ?? (await ata(c.feeRecipient, c.quoteMint, c.quoteTokenProgram)),
    baseVault: a.baseVault,
    quoteVault: a.quoteVault,
    baseMint: c.baseMint,
    quoteMint: c.quoteMint,
    dbcEventAuthority: await dbcEventAuthority(),
    baseTokenProgram: c.baseTokenProgram,
    quoteTokenProgram: c.quoteTokenProgram,
    maxBase: input.maxBase ?? U64_MAX,
    maxQuote: input.maxQuote ?? U64_MAX,
    slices: [{ accountsType: 0, length: extras.length }],
  } as Parameters<typeof getClaimPartnerFeeInstruction>[0]);
  return { ...ix, accounts: [...(ix.accounts ?? []), ...extras] } as Instruction;
}

async function surplusAccounts(cross: CrossView, destination: Address) {
  const c = cross.data;
  const a = await continuationAddresses(cross.address, c.quoteMint);
  return {
    cross: cross.address,
    settler: a.settler,
    dbcPoolAuthority: a.poolAuthority,
    dbcConfig: a.config,
    pool: a.pool,
    destination,
    quoteVault: a.quoteVault,
    quoteMint: c.quoteMint,
    dbcEventAuthority: await dbcEventAuthority(),
    quoteTokenProgram: c.quoteTokenProgram,
  };
}

/** After migration: the partner's share of the surplus quote goes to the issuer's proceeds account. */
export async function buildWithdrawPartnerSurplus(cross: CrossView, destination?: Address): Promise<Instruction> {
  const c = cross.data;
  return getWithdrawPartnerSurplusInstruction(await surplusAccounts(cross, destination ?? (await ata(c.proceedsTo, c.quoteMint, c.quoteTokenProgram))));
}

/** After migration: the partner's slice of the migration fee goes to the fee recipient. */
export async function buildWithdrawPartnerMigrationFee(cross: CrossView, destination?: Address): Promise<Instruction> {
  const c = cross.data;
  return getWithdrawPartnerMigrationFeeInstruction(await surplusAccounts(cross, destination ?? (await ata(c.feeRecipient, c.quoteMint, c.quoteTokenProgram))));
}

/** The pool-creation fee, in lamports, goes to the fee recipient's wallet. */
export async function buildClaimPartnerPoolCreationFee(cross: CrossView): Promise<Instruction> {
  const c = cross.data;
  const a = await continuationAddresses(cross.address, c.quoteMint);
  return getClaimPartnerPoolCreationFeeInstruction({
    cross: cross.address,
    settler: await settlerAddress(cross.address),
    dbcConfig: await dbcConfigAddress(cross.address),
    pool: a.pool,
    feeReceiver: c.feeRecipient,
    dbcEventAuthority: await dbcEventAuthority(),
  });
}


export type ClaimPolFeesInput = {
  cross: CrossView;
  /** The DAMM v2 pool a DBC migration created, its settler-owned position and that position's NFT token account. */
  pool: Address;
  position: Address;
  positionNftAccount: Address;
  /** The pool's two mints and vaults, in the pool's own order (DAMM v2 orders them by key). */
  tokenAMint: Address;
  tokenBMint: Address;
  tokenAVault: Address;
  tokenBVault: Address;
  /** Default: the associated accounts of the cross's `proceeds_to`. */
  tokenADestination?: Address;
  tokenBDestination?: Address;
};

const DAMM_V2_PROGRAM = address('cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG');

/** Claims the fees of the protocol-owned liquidity position a DBC migration left with the settler, to the issuer's proceeds accounts (ADR-0482). */
export async function buildClaimPolFees(input: ClaimPolFeesInput): Promise<Instruction> {
  const c = input.cross.data;
  const tokenProgram = (mint: Address) => (mint === c.baseMint ? c.baseTokenProgram : c.quoteTokenProgram);
  const [poolAuthority, eventAuthority] = await Promise.all(
    ['pool_authority', '__event_authority'].map(async (seed) => (await getProgramDerivedAddress({ programAddress: DAMM_V2_PROGRAM, seeds: [text(seed)] }))[0]),
  );
  return getClaimPolFeesInstruction({
    cross: input.cross.address,
    settler: await settlerAddress(input.cross.address),
    dammPoolAuthority: poolAuthority!,
    pool: input.pool,
    position: input.position,
    tokenADestination: input.tokenADestination ?? (await ata(c.proceedsTo, input.tokenAMint, tokenProgram(input.tokenAMint))),
    tokenBDestination: input.tokenBDestination ?? (await ata(c.proceedsTo, input.tokenBMint, tokenProgram(input.tokenBMint))),
    tokenAVault: input.tokenAVault,
    tokenBVault: input.tokenBVault,
    tokenAMint: input.tokenAMint,
    tokenBMint: input.tokenBMint,
    positionNftAccount: input.positionNftAccount,
    dammEventAuthority: eventAuthority!,
    tokenAProgram: tokenProgram(input.tokenAMint),
    tokenBProgram: tokenProgram(input.tokenBMint),
  });
}
