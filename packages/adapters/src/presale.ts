// A fixed-price tranche at the clearing price through Meteora's Presale Vault (B4; ADR-0663).
//
// After a cross prints P*, the cross's creator opens a fixed-price presale of more of the token, for everyone who did not bid in the call. `cross_settle`'s
// `open_fixed_price_presale` makes two calls into Meteora's `presale` program and pins the one thing only it can: the vault's `q_price` (quote atoms per base atom
// as a Q64.64 number) must equal `floor(P* x 2^64 / price_scale)`, the presale must be in fixed-price mode and only the creator may open it. The caps, times,
// vesting and registries are the creator's and are validated by Meteora's program. The interface is `idls/presale.json` (Presale Vault v0.1.1).
import { type Address, type Instruction, type TransactionSigner, address, getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';
import { getOpenFixedPricePresaleInstruction } from '@opening-cross/cross-settle-client';
import { type CrossView, type ProgramIssue, ata } from '@opening-cross/sdk';

export const PRESALE_PROGRAM_ADDRESS = address('presSVxnf9UU8jMxhgSMqaRwNiT36qeBdNeTRKjTdbj');
/** The vault's authority PDA (Meteora's `presale_authority`). */
export const PRESALE_AUTHORITY = address('4Xgt6XKZiowAGNdPWngVAwpYbSwAmbBnRBPtCFXhrypc');

const enc = getAddressEncoder();
const text = (s: string) => new TextEncoder().encode(s);
const pda = async (seeds: Uint8Array[]) => (await getProgramDerivedAddress({ programAddress: PRESALE_PROGRAM_ADDRESS, seeds }))[0];

/** What happens to base tokens the sale did not sell (Meteora's `unsold_token_action`). */
export const UnsoldTokenAction = { Refund: 0, Burn: 1 } as const;

export type FixedPriceTerms = {
  /** The most quote the sale accepts, and the least it needs to count as sold. */
  maxCap: bigint;
  minCap: bigint;
  /** Unix seconds. */
  start: bigint;
  end: bigint;
  /** Base atoms put into the sale; Meteora's program moves them from the creator's token account into its vault. */
  supply: bigint;
  /** Per-buyer deposit limits in quote atoms. */
  buyerMinDeposit: bigint;
  buyerMaxDeposit: bigint;
  depositFeeBps?: number;
  unsoldTokenAction?: number;
  /** Basis points of a buyer's tokens released at once; the rest vests (default 10,000: everything). */
  immediatelyReleaseBps?: number;
  lockDuration?: bigint;
  vestDuration?: bigint;
  /** Presale mode written into the arguments: 0 is fixed price. The adapter refuses any other (`PresaleNotFixedPrice`); exposed for tests of that refusal. */
  presaleMode?: number;
};

/** `q_price` the vault must hold for a cross: `floor(P* x 2^64 / price_scale)`. Throws for a cross that did not print or has a zero scale. */
export function fixedPriceQ64(price: bigint, priceScale: bigint): bigint {
  if (priceScale <= 0n) throw new Error('priceScale must be positive');
  return (price << 64n) / priceScale;
}

/** What the adapter and plain arithmetic refuse, found before signing. Meteora's own checks (caps against the price, times against the clock) are theirs and are not repeated. */
export function checkFixedPriceTerms(t: FixedPriceTerms): ProgramIssue[] {
  const out: ProgramIssue[] = [];
  const bad = (code: string, field: string, message: string) => out.push({ code, field, message });
  if (!(t.supply > 0n)) bad('NothingToDo', 'supply', 'the tranche needs a positive number of base atoms');
  if (!(t.end > t.start)) bad('BadTerms', 'end', 'the sale ends after it starts');
  if (!(t.maxCap > 0n) || t.minCap > t.maxCap) bad('BadTerms', 'maxCap', 'the maximum cap is positive and at least the minimum cap');
  if (t.buyerMinDeposit > t.buyerMaxDeposit) bad('BadTerms', 'buyerMaxDeposit', 'a buyer\'s maximum deposit is at least the minimum');
  if ((t.immediatelyReleaseBps ?? 10_000) > 10_000) bad('BadTerms', 'immediatelyReleaseBps', 'at most 10,000 basis points can be released at once');
  if ((t.depositFeeBps ?? 0) > 10_000) bad('BadTerms', 'depositFeeBps', 'a deposit fee is at most 10,000 basis points');
  return out;
}

/**
 * Borsh of the presale's `InitializePresaleArgs` for a permissionless sale with one registry: `PresaleArgs` (66 bytes), `LockedVestingArgs` (50), 32 bytes of padding,
 * a vector of one `PresaleRegistryArgs` (58). 210 bytes. Checked field by field against `idls/presale.json` in the adapters tests.
 */
export function encodePresaleArgs(t: FixedPriceTerms): Uint8Array {
  const out = new Uint8Array(210);
  const dv = new DataView(out.buffer);
  let at = 0;
  const u64 = (v: bigint) => {
    dv.setBigUint64(at, v, true);
    at += 8;
  };
  u64(t.maxCap);
  u64(t.minCap);
  u64(t.start);
  u64(t.end);
  out[at++] = 0; // whitelist_mode: permissionless
  out[at++] = t.presaleMode ?? 0; // presale_mode: fixed price
  out[at++] = t.unsoldTokenAction ?? UnsoldTokenAction.Refund;
  out[at++] = 0; // disable_earlier_presale_end_once_cap_reached
  at += 30; // padding
  dv.setUint16(at, t.immediatelyReleaseBps ?? 10_000, true);
  at += 2;
  u64(t.lockDuration ?? 0n);
  u64(t.vestDuration ?? 0n);
  u64(t.end); // immediate_release_timestamp
  at += 24; // padding
  at += 32; // padding
  dv.setUint32(at, 1, true); // one registry
  at += 4;
  u64(t.buyerMinDeposit);
  u64(t.buyerMaxDeposit);
  u64(t.supply);
  dv.setUint16(at, t.depositFeeBps ?? 0, true);
  at += 2;
  // 32 bytes of registry padding close the buffer
  return out;
}

export async function presaleAddresses(base: Address, baseMint: Address, quoteMint: Address) {
  const presale = await pda([text('presale'), enc.encode(base) as Uint8Array, enc.encode(baseMint) as Uint8Array, enc.encode(quoteMint) as Uint8Array]);
  return {
    presale,
    fixedPricePresaleParams: await pda([text('fixed_price_param'), enc.encode(presale) as Uint8Array]),
    presaleVault: await pda([text('base_vault'), enc.encode(presale) as Uint8Array]),
    quoteTokenVault: await pda([text('quote_vault'), enc.encode(presale) as Uint8Array]),
    eventAuthority: await pda([text('__event_authority')]),
  };
}

export type OpenFixedPricePresaleInput = {
  cross: CrossView;
  creator: TransactionSigner;
  /** A fresh keypair that also signs: Meteora derives the presale's address from it. */
  base: TransactionSigner;
  terms: FixedPriceTerms;
  /** Whether the presale forbids withdrawing a deposit before the end (Meteora's `disable_withdraw`; default false). */
  disableWithdraw?: boolean;
  /** Borsh of an empty `RemainingAccountsInfo` (four zero bytes) unless the base token has a transfer hook; that path is built and not exercised. */
  hook?: Uint8Array;
};

/** `open_fixed_price_presale`. The tranche is priced at exactly the cross's clearing price. */
export async function buildOpenFixedPricePresale(input: OpenFixedPricePresaleInput): Promise<{ instruction: Instruction; qPrice: bigint; addresses: Awaited<ReturnType<typeof presaleAddresses>>; clearingPrice: bigint }> {
  const c = input.cross.data;
  if (c.clearing.__option !== 'Some') throw new Error('cross has not cleared');
  if (!c.baseBound) throw new Error('cross has no base mint yet');
  const issues = checkFixedPriceTerms(input.terms);
  if (issues.length > 0) throw new Error(issues.map((i) => `${i.field}: ${i.message}`).join('; '));
  const qPrice = fixedPriceQ64(c.clearing.value.price, c.priceScale);
  const addresses = await presaleAddresses(input.base.address, c.baseMint, c.quoteMint);
  const instruction = getOpenFixedPricePresaleInstruction({
    creator: input.creator,
    cross: input.cross.address,
    base: input.base,
    presaleMint: c.baseMint,
    quoteTokenMint: c.quoteMint,
    presale: addresses.presale,
    fixedPricePresaleParams: addresses.fixedPricePresaleParams,
    presaleAuthority: PRESALE_AUTHORITY,
    presaleVault: addresses.presaleVault,
    quoteTokenVault: addresses.quoteTokenVault,
    payerPresaleToken: await ata(input.creator.address, c.baseMint, c.baseTokenProgram),
    baseTokenProgram: c.baseTokenProgram,
    quoteTokenProgram: c.quoteTokenProgram,
    eventAuthority: addresses.eventAuthority,
    args: encodePresaleArgs(input.terms),
    qPrice,
    disableWithdraw: input.disableWithdraw ? 1 : 0,
    hook: input.hook ?? new Uint8Array(4),
  });
  // A presale is not a graduation venue and the vote does not gate it (ADR-0663), so a governed cross takes no outcome account here.
  return { instruction, qPrice, addresses, clearingPrice: c.clearing.value.price };
}
