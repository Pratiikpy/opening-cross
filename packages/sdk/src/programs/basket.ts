// Builders for `cross_basket` (S5; ADR-0652): a share token backed by fixed amounts of one to eight tokens. Minting pays `ceil(units x shares / 10^6)` of
// every component into the basket's vaults, redeeming pays `floor(...)`; no manager, fee, rebalance or pause.
import { type Address, type Instruction, type ReadonlyUint8Array, type TransactionSigner } from '@solana/kit';
import { getMintDecoder } from '@solana-program/token-2022';
import {
  type Basket,
  CROSS_BASKET_PROGRAM_ADDRESS,
  type Component,
  findBasketPda,
  findShareMintPda,
  getCreateBasketInstruction,
  getMintSharesInstruction,
  getRedeemSharesInstruction,
} from '@opening-cross/cross-basket-client';
import { ata, readonly, withAccounts, writable } from '../index.js';
import { type ProgramIssue, SPL_TOKEN_PROGRAM, TOKEN_2022_PROGRAM, createAtaIdempotent, refuse } from './common.js';

export { CROSS_BASKET_PROGRAM_ADDRESS };
export type { Basket, Component };

/** A basket holds one to eight components, a label of at most 32 bytes (the program's `MAX_COMPONENTS`, `MAX_LABEL`). */
export const BASKET_MAX_COMPONENTS = 8;
export const BASKET_MAX_LABEL_BYTES = 32;
/** A share has six decimals: one whole share is 10^6 share atoms (the program's `SHARE_UNIT`). */
export const BASKET_SHARE_UNIT = 1_000_000n;

/** What a component costs or pays for `shares` share atoms, with the program's rounding: deposits round up, redemptions round down. */
export const basketOwed = (unitsPerShare: bigint, shares: bigint, up: boolean): bigint => {
  const n = unitsPerShare * shares;
  const q = n / BASKET_SHARE_UNIT;
  return up && n % BASKET_SHARE_UNIT !== 0n ? q + 1n : q;
};
/** Whether a vault of `balance` atoms covers `supply` share atoms at `unitsPerShare` per whole share (the program's `covers`). */
export const basketCovers = (balance: bigint, unitsPerShare: bigint, supply: bigint): boolean => balance * BASKET_SHARE_UNIT >= unitsPerShare * supply;

/** The Token-2022 extensions a component may carry (the program's `check_extensions`): display only. */
const ALLOWED_EXTENSIONS: ReadonlySet<string> = new Set(['MetadataPointer', 'TokenMetadata', 'GroupPointer', 'GroupMemberPointer', 'TokenGroup', 'TokenGroupMember', 'ScaledUiAmount', 'InterestBearingConfig']);

/**
 * Whether a mint may be a component: a legacy SPL Token mint, or a Token-2022 mint whose extensions are all display ones. A transfer fee, a permanent delegate, a
 * transfer hook, a pausable, a close authority, confidential transfers, default state or a non-transferable extension are refused, because each could make the
 * backing unprovable. A gated token (a `cross_gate` transfer hook) therefore cannot be a component.
 */
export function checkBasketComponentMint(mint: { owner: Address; data: ReadonlyUint8Array }, address: Address): ProgramIssue[] {
  const bad = (code: string, message: string): ProgramIssue[] => [{ code, field: `components.${address}`, message }];
  if (mint.owner === SPL_TOKEN_PROGRAM) return [];
  if (mint.owner !== TOKEN_2022_PROGRAM) return bad('BadComponent', 'a component must be a token mint of the legacy Token program or Token-2022');
  let decoded;
  try {
    decoded = getMintDecoder().decode(mint.data as Uint8Array);
  } catch {
    return bad('BadComponent', 'the account does not decode as a Token-2022 mint');
  }
  const ext = decoded.extensions.__option === 'Some' ? decoded.extensions.value : [];
  const refused = ext.map((e) => e.__kind).filter((k) => !ALLOWED_EXTENSIONS.has(k));
  return refused.length === 0 ? [] : bad('UnsafeExtension', `the token has the extension${refused.length > 1 ? 's' : ''} ${refused.join(', ')}, which could break the backing`);
}

export type BasketComponentInput = { mint: Address; tokenProgram: Address; unitsPerShare: bigint };

export type BasketAddresses = { basket: Address; shareMint: Address; vaults: Address[] };
export async function basketAddresses(creator: Address, id: bigint, components: readonly { mint: Address; tokenProgram: Address }[]): Promise<BasketAddresses> {
  const [basket] = await findBasketPda({ creator, id });
  const [shareMint] = await findShareMintPda({ basket });
  return { basket, shareMint, vaults: await Promise.all(components.map((c) => ata(basket, c.mint, c.tokenProgram))) };
}

/** What `create_basket` refuses from the terms alone. */
export function checkBasketTerms(label: string, components: readonly BasketComponentInput[]): ProgramIssue[] {
  const out: ProgramIssue[] = [];
  if (components.length < 1 || components.length > BASKET_MAX_COMPONENTS) out.push({ code: 'BadBasket', field: 'components', message: `a basket has one to ${BASKET_MAX_COMPONENTS} components` });
  if (new TextEncoder().encode(label).length > BASKET_MAX_LABEL_BYTES) out.push({ code: 'BadBasket', field: 'label', message: `the label is at most ${BASKET_MAX_LABEL_BYTES} bytes` });
  if (components.some((c) => !(c.unitsPerShare > 0n))) out.push({ code: 'BadBasket', field: 'components', message: 'every component has a positive amount per whole share' });
  const seen = new Set<string>();
  for (const c of components) {
    if (seen.has(c.mint)) out.push({ code: 'DuplicateComponent', field: 'components', message: `${c.mint} is listed twice` });
    seen.add(c.mint);
  }
  return out;
}

/** `create_basket`, with the idempotent creation of the basket's vault for every component in front of it (send them in one transaction when it fits). */
export async function buildCreateBasket(input: { creator: TransactionSigner; id: bigint; label: string; components: readonly BasketComponentInput[] }): Promise<{ instructions: Instruction[] } & BasketAddresses> {
  const { creator, id, label, components } = input;
  refuse(checkBasketTerms(label, components));
  const a = await basketAddresses(creator.address, id, components);
  const pre = components.map((c, i) => createAtaIdempotent(creator, a.basket, c.mint, c.tokenProgram, a.vaults[i]!));
  const create = withAccounts(
    getCreateBasketInstruction({ creator, basket: a.basket, shareMint: a.shareMint, id, label, unitsPerShare: components.map((c) => c.unitsPerShare) }),
    components.flatMap((c, i) => [readonly(c.mint), readonly(a.vaults[i]!)]),
  );
  return { instructions: [...pre, create], ...a };
}

async function legs(basket: Address, components: readonly { mint: Address; tokenProgram: Address }[], user: Address) {
  const out = [];
  for (const c of components) out.push(readonly(c.mint), writable(await ata(basket, c.mint, c.tokenProgram)), writable(await ata(user, c.mint, c.tokenProgram)));
  return out;
}

/** `mint_shares`: the share account is created first (legacy Token). The depositor must already hold every component in the amounts `basketOwed(.., true)` names. */
export async function buildMintShares(input: { user: TransactionSigner; basket: Address; shareMint: Address; components: readonly { mint: Address; tokenProgram: Address }[]; shares: bigint }): Promise<Instruction[]> {
  const { user, basket, shareMint, components, shares } = input;
  refuse(shares > 0n ? [] : [{ code: 'NothingToDo', field: 'shares', message: 'mint a positive number of shares' }]);
  const userShares = await ata(user.address, shareMint, SPL_TOKEN_PROGRAM);
  return [
    createAtaIdempotent(user, user.address, shareMint, SPL_TOKEN_PROGRAM, userShares),
    withAccounts(getMintSharesInstruction({ user, basket, shareMint, userShares, tokenProgram: SPL_TOKEN_PROGRAM, token2022Program: TOKEN_2022_PROGRAM, shares }), await legs(basket, components, user.address)),
  ];
}

/** `redeem_shares`: the redeemer's account for every component is created first (a redemption pays into it). */
export async function buildRedeemShares(input: { user: TransactionSigner; basket: Address; shareMint: Address; components: readonly { mint: Address; tokenProgram: Address }[]; shares: bigint }): Promise<Instruction[]> {
  const { user, basket, shareMint, components, shares } = input;
  refuse(shares > 0n ? [] : [{ code: 'NothingToDo', field: 'shares', message: 'redeem a positive number of shares' }]);
  const userShares = await ata(user.address, shareMint, SPL_TOKEN_PROGRAM);
  const pre = await Promise.all(components.map(async (c) => createAtaIdempotent(user, user.address, c.mint, c.tokenProgram, await ata(user.address, c.mint, c.tokenProgram))));
  return [
    ...pre,
    withAccounts(getRedeemSharesInstruction({ user, basket, shareMint, userShares, tokenProgram: SPL_TOKEN_PROGRAM, token2022Program: TOKEN_2022_PROGRAM, shares }), await legs(basket, components, user.address)),
  ];
}
