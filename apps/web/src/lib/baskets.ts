// Basket tokens (S5, K3; ADR-0652): what the basket routes serve, the words a holder reads, and the forms that become the bodies of the routes. Pure and free of React.
// Integers that can exceed 2^53 are decimal strings.
//
// Rules of the program (programs/cross_basket, docs/evidence/W3D-S5.md): a share (six decimals) is backed by `unitsPerShare` atoms of each of one to eight components per whole
// share (10^6 share atoms). Minting rounds each deposit up, redeeming rounds each payout down, so rounding always favours the basket; after every step each vault must cover
// the shares outstanding. There is no manager, fee, rebalance or pause, and a basket never changes. Components must behave like plain tokens: a transfer fee, permanent
// delegate, transfer hook, pausable, confidential-transfer, default-state or non-transferable extension is refused, and a token gated by cross_gate cannot be one.
import { isAddress } from '@solana/kit';
import type { ReleaseNote } from './new-programs';
import { formatAtoms, parseAtoms } from './units';

export const SHARE_UNIT = 1_000_000n;
export const SHARE_DECIMALS = 6;
export const MAX_COMPONENTS = 8;
/** Extensions the program refuses at creation, by the name the cluster's parsed accounts give them. */
export const UNSAFE_EXTENSIONS: Record<string, string> = {
  transferFeeConfig: 'a transfer fee',
  permanentDelegate: 'a permanent delegate',
  transferHook: 'a transfer hook',
  pausableConfig: 'a pause switch',
  confidentialTransferMint: 'confidential transfers',
  defaultAccountState: 'a default account state',
  nonTransferable: 'non-transferability',
};

export type BasketComponent = { mint: string; tokenProgram: string; unitsPerShare: string; vault: string; balance: string | null; covers: boolean | null; backingPerShare: string | null };
export type BasketRead = { basket: string; creator: string; id: string; label: string; shareMint: string; shareDecimals: number; shareSupply: string | null; components: BasketComponent[]; solvent: boolean | null; release: ReleaseNote };
export type BasketRow = { basket: string; creator: string; shareMint: string; components: { mint: string; tokenProgram: string; unitsPerShare: string }[]; minted: string; redeemed: string; outstanding: string; createdSlot: string };
export type BasketsRead = { baskets: BasketRow[]; release: ReleaseNote; note?: string };
export type QuoteLine = { mint: string; tokenProgram: string; unitsPerShare: string; amount: string; exact: boolean };
export type QuoteRead = { basket: string; side: 'mint' | 'redeem'; shares: string; lines: QuoteLine[]; rounding: string; release: ReleaseNote };

/** The first unsafe extension a token carries, as words; null when none. */
export function unsafeExtension(extensions: string[]): string | null {
  const hit = extensions.find((e) => e in UNSAFE_EXTENSIONS);
  return hit ? UNSAFE_EXTENSIONS[hit]! : null;
}

export type ComponentForm = { mint: string; units: string };
export type BasketForm = { label: string; components: ComponentForm[] };
export const EMPTY_BASKET: BasketForm = { label: '', components: [{ mint: '', units: '' }, { mint: '', units: '' }] };
export type ResolvedMint = { decimals: number; extensions: string[] } | null;
export type BasketErrors = { label?: string; components?: string; rows: { mint?: string; units?: string }[] };

/** The body of POST /v1/tx/basket-create. `mints[i]` is what was read of component i's token; a row is held back until its token was read and is plain. */
export function buildBasket(f: BasketForm, creator: string | null, mints: ResolvedMint[]): { body: Record<string, unknown> | null; errors: BasketErrors } {
  const errors: BasketErrors = { rows: f.components.map(() => ({})) };
  const bytes = new TextEncoder().encode(f.label).length;
  if (f.label.trim() === '' || bytes > 32) errors.label = 'A basket has a label of 1 to 32 bytes.';
  if (f.components.length < 1 || f.components.length > MAX_COMPONENTS) errors.components = `A basket has one to ${MAX_COMPONENTS} components.`;
  const seen = new Set<string>();
  const out: { mint: string; unitsPerShare: string }[] = [];
  f.components.forEach((c, i) => {
    const row = errors.rows[i]!;
    const mint = c.mint.trim();
    if (!isAddress(mint)) row.mint = 'This is not a Solana address.';
    else if (seen.has(mint)) row.mint = 'A token is a component once.';
    else seen.add(mint);
    const info = mints[i] ?? null;
    if (isAddress(mint) && info) {
      const bad = unsafeExtension(info.extensions);
      if (bad) row.mint = `This token has ${bad}. It would make the backing unprovable, so the program refuses it as a component.`;
    }
    const units = info ? parseAtoms(c.units, info.decimals) : null;
    if (c.units.trim() === '' || units === null || units === 0n) row.units = info ? `A number above zero with at most ${info.decimals} decimals.` : 'Enter the token first, then the amount per share.';
    else if (!row.mint) out.push({ mint, unitsPerShare: units.toString() });
  });
  const bad = errors.label || errors.components || errors.rows.some((r) => r.mint || r.units);
  if (bad || !creator || out.length !== f.components.length) return { body: null, errors };
  return { body: { creator, label: f.label, components: out }, errors };
}

/** Whole shares typed by a person, as share atoms. */
export function sharesAtoms(text: string): bigint | null {
  const v = parseAtoms(text, SHARE_DECIMALS);
  return v === null || v === 0n ? null : v;
}

export const lineText = (l: QuoteLine, decimals: number | null, symbol: string): string => `${decimals === null ? l.amount : formatAtoms(BigInt(l.amount), decimals)} ${symbol}${l.exact ? '' : ' (rounded)'}`;
