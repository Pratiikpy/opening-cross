// MetaDAO settlement adapter (X3; ADR-0657): after a cross clears at P*, the creator opens a MetaDAO futarchy DAO whose spot pool starts at P* and puts the opening
// liquidity into it, in one instruction with two calls into MetaDAO's `futarchy` program (`initialize_dao`, `provide_liquidity`).
//
// `cross_settle`'s `seed_futarchy_dao` pins the first field of MetaDAO's parameters (`twap_initial_observation`) to `floor(P* x 10^12 / price_scale)` and requires the deposits to
// price the base at P* within one quote atom. MetaDAO accepts legacy SPL Token mints only, so a cross whose tokens are Token-2022 is refused (`FutarchyNeedsLegacyTokens`).
// MetaDAO's code is BSL 1.1: the adapter calls the deployed program and copies none of it.
import { type Address, type Instruction, type TransactionSigner, address, getAddressDecoder, getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';
import { PublicKey } from '@solana/web3.js';
import * as multisig from '@sqds/multisig';
import { getSeedFutarchyDaoInstruction } from '@opening-cross/cross-settle-client';
import { ASSOCIATED_TOKEN_PROGRAM, type CrossView, type ProgramIssue, SPL_TOKEN_PROGRAM, ata, governedOutcomeAccount, isGoverned, withAccounts } from '@opening-cross/sdk';

export const FUTARCHY_PROGRAM_ADDRESS = address('FUTARELBfJfQ8RDGhg1wdhddq1odMAJUePHFuBYfUxKq');
export const SQUADS_PROGRAM_ADDRESS = address('SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf');
/** MetaDAO's TWAP is scaled by 10^12 (the program's price scale). */
export const FUTARCHY_PRICE_SCALE = 1_000_000_000_000n;

const enc = getAddressEncoder();
const text = (s: string) => new TextEncoder().encode(s);
const pk = (a: Address) => new PublicKey(a);
const kit = (k: PublicKey): Address => address(k.toBase58());
const pda = async (seeds: Uint8Array[]) => (await getProgramDerivedAddress({ programAddress: FUTARCHY_PROGRAM_ADDRESS, seeds }))[0];

/** MetaDAO's `InitializeDaoParams` apart from the TWAP's first observation, which the adapter pins. Defaults are the ones the adapter's tests run with. */
export type DaoSettings = {
  twapMaxObservationChangePerUpdate?: bigint;
  twapStartDelaySeconds?: number;
  minQuoteFutarchicLiquidity?: bigint;
  minBaseFutarchicLiquidity?: bigint;
  baseToStake?: bigint;
  passThresholdBps?: number;
  secondsPerProposal?: number;
  teamSponsoredPassThresholdBps?: number;
};

const u128 = (v: bigint): Uint8Array => {
  const b = new Uint8Array(16);
  new DataView(b.buffer).setBigUint64(0, v & 0xffff_ffff_ffff_ffffn, true);
  new DataView(b.buffer).setBigUint64(8, v >> 64n, true);
  return b;
};

/** The first field of the parameters: the TWAP's first observation, `floor(P* x 10^12 / price_scale)`. */
export function twapInitialObservation(price: bigint, priceScale: bigint): bigint {
  if (priceScale <= 0n) throw new Error('priceScale must be positive');
  return (price * FUTARCHY_PRICE_SCALE) / priceScale;
}

/** Borsh of MetaDAO's `InitializeDaoParams` (109 bytes) with no initial spending limit, the way the adapter's tests build it. */
export function encodeDaoParams(twap: bigint, nonce: bigint, team: Address, s: DaoSettings = {}): Uint8Array {
  const out = new Uint8Array(16 + 16 + 4 + 8 + 8 + 8 + 2 + 4 + 8 + 1 + 2 + 32);
  const dv = new DataView(out.buffer);
  out.set(u128(twap), 0);
  out.set(u128(s.twapMaxObservationChangePerUpdate ?? FUTARCHY_PRICE_SCALE), 16);
  dv.setUint32(32, s.twapStartDelaySeconds ?? 0, true);
  dv.setBigUint64(36, s.minQuoteFutarchicLiquidity ?? 1n, true);
  dv.setBigUint64(44, s.minBaseFutarchicLiquidity ?? 1n, true);
  dv.setBigUint64(52, s.baseToStake ?? 0n, true);
  dv.setUint16(60, s.passThresholdBps ?? 300, true);
  dv.setUint32(62, s.secondsPerProposal ?? 3 * 86_400, true);
  dv.setBigUint64(66, nonce, true);
  out[74] = 0; // initial_spending_limit: None
  dv.setInt16(75, s.teamSponsoredPassThresholdBps ?? -300, true);
  out.set(enc.encode(team) as Uint8Array, 77);
  return out;
}

/** The treasury Squads checks against its program config: authority (32 bytes), creation fee (8), then the treasury. */
export function squadsTreasuryOf(programConfig: Uint8Array): Address {
  if (programConfig.length < 8 + 32 + 8 + 32) throw new Error('the Squads program config is too short to hold a treasury');
  return getAddressDecoder().decode(programConfig.slice(8 + 32 + 8, 8 + 32 + 8 + 32));
}
export const squadsProgramConfigAddress = (): Address => kit(multisig.getProgramConfigPda({})[0]);

/** Quote atoms that price `baseAmount` at P*, rounded up (the program accepts a deposit within one quote atom of the exact ratio). */
export const quoteForFutarchyBase = (baseAmount: bigint, price: bigint, priceScale: bigint): bigint => (baseAmount * price + priceScale - 1n) / priceScale;

/** The program's `deposit_matches_price`: the quote deposit is `base x P* / scale` rounded down or up, no other number. Null for a zero base or scale. */
export function depositMatchesPrice(baseAmount: bigint, quoteAmount: bigint, price: bigint, priceScale: bigint): boolean | null {
  if (priceScale === 0n || baseAmount === 0n) return null;
  const exact = baseAmount * price;
  const floor = exact / priceScale;
  const ceil = floor + (exact % priceScale !== 0n ? 1n : 0n);
  return quoteAmount >= floor && quoteAmount <= ceil;
}

export async function futarchyAddresses(creator: Address, nonce: bigint, baseMint: Address, quoteMint: Address) {
  const nonceBytes = new Uint8Array(8);
  new DataView(nonceBytes.buffer).setBigUint64(0, nonce, true);
  const dao = await pda([text('dao'), enc.encode(creator) as Uint8Array, nonceBytes]);
  const squadsMultisig = kit(multisig.getMultisigPda({ createKey: pk(dao) })[0]);
  return {
    dao,
    squadsMultisig,
    squadsMultisigVault: kit(multisig.getVaultPda({ multisigPda: pk(squadsMultisig), index: 0 })[0]),
    spendingLimit: kit(multisig.getSpendingLimitPda({ multisigPda: pk(squadsMultisig), createKey: pk(dao) })[0]),
    squadsProgramConfig: squadsProgramConfigAddress(),
    ammBaseVault: await ata(dao, baseMint, SPL_TOKEN_PROGRAM),
    ammQuoteVault: await ata(dao, quoteMint, SPL_TOKEN_PROGRAM),
    ammPosition: await pda([text('amm_position'), enc.encode(dao) as Uint8Array, enc.encode(creator) as Uint8Array]),
    eventAuthority: await pda([text('__event_authority')]),
  };
}

/** What the adapter refuses before any call: MetaDAO accepts legacy SPL Token mints only. */
export function checkFutarchyCross(cross: CrossView): ProgramIssue[] {
  const c = cross.data;
  const out: ProgramIssue[] = [];
  if (c.baseTokenProgram !== SPL_TOKEN_PROGRAM || c.quoteTokenProgram !== SPL_TOKEN_PROGRAM) {
    out.push({ code: 'FutarchyNeedsLegacyTokens', field: 'cross', message: 'MetaDAO accepts legacy SPL Token mints only; this cross has a Token-2022 token' });
  }
  return out;
}

export type SeedFutarchyInput = {
  cross: CrossView;
  creator: TransactionSigner;
  /** Distinguishes the creator's DAOs (the DAO's address is derived from the creator and this). */
  nonce: bigint;
  baseAmount: bigint;
  /** Defaults to the quote that prices `baseAmount` at P*, rounded up. */
  quoteAmount?: bigint;
  /** Read from Squads' program config account (`squadsTreasuryOf`); Squads checks it. */
  squadsTreasury: Address;
  settings?: DaoSettings;
};

/** `seed_futarchy_dao`. A governed cross also takes the `Outcome` account, which must name MetaDAO (venue 3). */
export async function buildSeedFutarchyDao(input: SeedFutarchyInput): Promise<{ instruction: Instruction; quoteAmount: bigint; twap: bigint; addresses: Awaited<ReturnType<typeof futarchyAddresses>> }> {
  const c = input.cross.data;
  if (c.clearing.__option !== 'Some') throw new Error('cross has not cleared');
  if (!c.baseBound) throw new Error('cross has no base mint yet');
  const issues = checkFutarchyCross(input.cross);
  if (issues.length > 0) throw new Error(`${issues[0]!.code}: ${issues[0]!.message}`);
  if (!(input.baseAmount > 0n)) throw new Error('baseAmount must be positive');
  const price = c.clearing.value.price;
  const quoteAmount = input.quoteAmount ?? quoteForFutarchyBase(input.baseAmount, price, c.priceScale);
  if (depositMatchesPrice(input.baseAmount, quoteAmount, price, c.priceScale) !== true) throw new Error('StartPriceNotClearingPrice: the deposits must price the base at the clearing price, to within one quote atom');
  const twap = twapInitialObservation(price, c.priceScale);
  const a = await futarchyAddresses(input.creator.address, input.nonce, c.baseMint, c.quoteMint);
  const original = getSeedFutarchyDaoInstruction({
    creator: input.creator,
    cross: input.cross.address,
    dao: a.dao,
    baseMint: c.baseMint,
    quoteMint: c.quoteMint,
    squadsMultisig: a.squadsMultisig,
    squadsMultisigVault: a.squadsMultisigVault,
    squadsProgram: SQUADS_PROGRAM_ADDRESS,
    squadsProgramConfig: a.squadsProgramConfig,
    squadsProgramConfigTreasury: input.squadsTreasury,
    spendingLimit: a.spendingLimit,
    ammBaseVault: a.ammBaseVault,
    ammQuoteVault: a.ammQuoteVault,
    creatorBase: await ata(input.creator.address, c.baseMint, SPL_TOKEN_PROGRAM),
    creatorQuote: await ata(input.creator.address, c.quoteMint, SPL_TOKEN_PROGRAM),
    ammPosition: a.ammPosition,
    eventAuthority: a.eventAuthority,
    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM,
    params: encodeDaoParams(twap, input.nonce, input.creator.address, input.settings),
    baseAmount: input.baseAmount,
    quoteAmount,
  });
  const instruction = isGoverned(input.cross.ext) ? withAccounts(original, [await governedOutcomeAccount(input.cross.address)]) : original;
  return { instruction, quoteAmount, twap, addresses: a };
}
