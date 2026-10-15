// Auto-invest mandates (S4, J2; ADR-0650, ADR-0801): what the mandate routes serve, the words an owner and an agent read, and the forms that become the bodies of
// the routes. Pure and free of React. Integers that can exceed 2^53 are decimal strings; times are Unix seconds.
//
// Rules of the program (programs/cross_mandate, docs/evidence/W3D-S4.md): an owner funds a vault and names one agent. The agent can only place buy orders inside the
// owner's limits (a most per order, a lifetime cap, a share of the cross's declared supply of at most 25%, an expiry and an allow list of one to eight base mints,
// creators or crosses). The owner can revoke, permanently and at once, and withdraw at any time. The agent holds a key that signs three instructions and nothing else.
import { isAddress } from '@solana/kit';
import type { ReleaseNote } from './new-programs';
import { formatAtoms, formatPrice, parseAtoms, parsePrice, shortAddress, type Market } from './units';

export type AllowKind = 'base_mint' | 'creator' | 'cross';
export type Allow = { kind: AllowKind; key: string };
export type LimitsRead = { maxPerOrder: string; totalCap: string; maxShareBps: number; expiresAt: string | number; allow: Allow[] };
export type MandateStatus = 'active' | 'revoked' | 'expired';
export type MandateRead = {
  mandate: string;
  owner: string;
  agent: string;
  id: string;
  quoteMint: string;
  quoteTokenProgram: string;
  limits: LimitsRead;
  committed: string;
  capRemaining: string;
  status: MandateStatus;
  signer: string;
  vault: string;
  vaultBalance: string;
  signerLamports: string | null;
  minSignerLamports: string;
  canPlaceOrder: boolean;
  blockers: string[];
  release: ReleaseNote;
};
export type MandateRow = { mandate: string; owner: string; agent: string; quoteMint: string; limits: LimitsRead; committed: string; funded: string; withdrawn: string; orders: number; status: MandateStatus; createdSlot: string };
export type MandatesRead = { owner?: string; mandates: MandateRow[]; release: ReleaseNote; note?: string };
export type ActivityRead = { mandate: string; events: { signature: string; name: string; slot: string }[]; orders: { order_address: string; cross_address: string; escrow: string; slot: string }[]; release: ReleaseNote };
export type GuardRead = { ok: boolean; instructions: { program: string; name: string | null }[]; issues: { code: string; field: string; message: string }[]; allowed: string[]; note: string };

export const KIND_LABEL: Record<AllowKind, string> = { base_mint: 'a base token', creator: 'a creator', cross: 'one cross' };
export const SOL = 1_000_000_000n;
export const lamportsText = (v: string | bigint): string => `${formatAtoms(BigInt(v), 9, 6)} SOL`;

/** What stops the agent from placing an order now, in words. */
export function blockerText(b: string): string {
  const map: Record<string, string> = {
    revoked: 'The owner revoked this mandate for good.',
    expired: 'The mandate has expired.',
    'vault empty': 'The vault is empty: there is nothing to escrow.',
    'lifetime cap reached': 'The lifetime cap is used up.',
    'signer account needs SOL for order rent': 'The signer account needs SOL to pay the rent of an order account (it gets it back when the order is claimed).',
  };
  return map[b] ?? b;
}

// ---------------------------------------------------------------------------------------------------- forms

export type LimitsForm = { maxPerOrder: string; totalCap: string; sharePct: string; days: string; allow: { kind: AllowKind; key: string }[] };
export const EMPTY_LIMITS: LimitsForm = { maxPerOrder: '', totalCap: '', sharePct: '5', days: '30', allow: [{ kind: 'creator', key: '' }] };
export type LimitsErrors = { maxPerOrder?: string; totalCap?: string; sharePct?: string; days?: string; allow?: string; entries: (string | undefined)[] };

/** The limits of a mandate as the routes take them. The program's own bounds (a positive most per order, a cap at least that, 1 to 2,500 bps, one to eight entries) are checked first. */
export function buildLimits(f: LimitsForm, decimals: number | null, now: number): { limits: Record<string, unknown> | null; errors: LimitsErrors } {
  const errors: LimitsErrors = { entries: f.allow.map(() => undefined) };
  const amount = (s: string) => (decimals === null ? null : parseAtoms(s, decimals));
  const per = amount(f.maxPerOrder);
  const cap = amount(f.totalCap);
  if (f.maxPerOrder.trim() === '' || per === null || per === 0n) errors.maxPerOrder = decimals === null ? 'The quote token’s decimals have not been read yet.' : `A number above zero with at most ${decimals} decimals.`;
  if (f.totalCap.trim() === '' || cap === null || cap === 0n) errors.totalCap = decimals === null ? 'The quote token’s decimals have not been read yet.' : `A number above zero with at most ${decimals} decimals.`;
  else if (per !== null && cap < per) errors.totalCap = 'The lifetime cap must be at least the most one order may escrow.';
  const bps = /^\d{1,2}(\.\d{1,2})?$/.test(f.sharePct.trim()) ? Math.round(Number(f.sharePct.trim()) * 100) : null;
  if (bps === null || bps < 1 || bps > 2_500) errors.sharePct = 'A share is above 0 and at most 25 percent of a cross’s declared supply, with at most two decimals.';
  const d = /^\d{1,4}$/.test(f.days.trim()) ? Number(f.days.trim()) : null;
  if (d === null || d < 1) errors.days = 'A whole number of days from now, at least 1.';
  if (f.allow.length === 0) errors.allow = 'Name at least one base token, creator or cross the agent may buy.';
  if (f.allow.length > 8) errors.allow = 'The allow list holds at most eight entries.';
  f.allow.forEach((a, i) => {
    if (!isAddress(a.key.trim())) errors.entries[i] = 'This is not a Solana address.';
  });
  const bad = errors.maxPerOrder || errors.totalCap || errors.sharePct || errors.days || errors.allow || errors.entries.some(Boolean);
  if (bad || per === null || cap === null || bps === null || d === null) return { limits: null, errors };
  return { limits: { maxPerOrder: per.toString(), totalCap: cap.toString(), maxShareBps: bps, expiresAt: now + d * 86_400, allow: f.allow.map((a) => ({ kind: a.kind, key: a.key.trim() })) }, errors };
}

export type CreateForm = { agent: string; quoteMint: string; fundAmount: string; fundSol: string; limits: LimitsForm };
export const EMPTY_CREATE: CreateForm = { agent: '', quoteMint: '', fundAmount: '', fundSol: '0.05', limits: EMPTY_LIMITS };
export type CreateErrors = { agent?: string; quoteMint?: string; fundAmount?: string; fundSol?: string; limits: LimitsErrors };

/** The body of POST /v1/tx/mandate-create, with an optional first funding of the vault (quote tokens) and the signer account (SOL for order rent). */
export function buildCreate(f: CreateForm, owner: string | null, decimals: number | null, now: number): { body: Record<string, unknown> | null; errors: CreateErrors } {
  const l = buildLimits(f.limits, decimals, now);
  const errors: CreateErrors = { limits: l.errors };
  if (!isAddress(f.agent.trim())) errors.agent = 'This is not a Solana address.';
  else if (owner && f.agent.trim() === owner) errors.agent = 'The agent must be a different key from the owner: an agent that is the owner is no limit at all.';
  if (!isAddress(f.quoteMint.trim())) errors.quoteMint = 'This is not a Solana address.';
  const amount = f.fundAmount.trim() === '' ? 0n : decimals === null ? null : parseAtoms(f.fundAmount, decimals);
  if (amount === null) errors.fundAmount = decimals === null ? 'The quote token’s decimals have not been read yet.' : `A number with at most ${decimals} decimals.`;
  const sol = f.fundSol.trim() === '' ? 0n : parseAtoms(f.fundSol, 9);
  if (sol === null) errors.fundSol = 'A number of SOL with at most 9 decimals.';
  const bad = errors.agent || errors.quoteMint || errors.fundAmount || errors.fundSol;
  if (bad || !l.limits || !owner || amount === null || sol === null) return { body: null, errors };
  const fund = amount > 0n || sol > 0n ? { fund: { ...(amount > 0n ? { amount: amount.toString() } : {}), ...(sol > 0n ? { lamports: sol.toString() } : {}) } } : {};
  return { body: { owner, agent: f.agent.trim(), quoteMint: f.quoteMint.trim(), limits: l.limits, ...fund }, errors };
}

export type FundForm = { amount: string; sol: string };
/** The body of POST /v1/tx/mandate-fund. */
export function buildFund(f: FundForm, owner: string | null, mandate: string, decimals: number | null): { body: Record<string, unknown> | null; error?: string } {
  const amount = f.amount.trim() === '' ? 0n : decimals === null ? null : parseAtoms(f.amount, decimals);
  const sol = f.sol.trim() === '' ? 0n : parseAtoms(f.sol, 9);
  if (amount === null || sol === null) return { body: null, error: 'A number with the token’s decimals (SOL has 9).' };
  if (amount === 0n && sol === 0n) return { body: null };
  if (!owner) return { body: null };
  return { body: { owner, mandate, ...(amount > 0n ? { amount: amount.toString() } : {}), ...(sol > 0n ? { lamports: sol.toString() } : {}) } };
}

export type OrderForm = { cross: string; price: string; quantity: string };
/** The body of POST /v1/tx/mandate-place-order. The agent signs. A sealed cross needs a salt the agent keeps for the reveal. */
export type Grid = { minPrice: bigint; tick: bigint; ticks: number };
export function buildOrder(f: OrderForm, agent: string | null, mandate: string, market: Market | null, salt: string | null, grid: Grid | null = null): { body: Record<string, unknown> | null; errors: Partial<Record<keyof OrderForm, string>> } {
  const errors: Partial<Record<keyof OrderForm, string>> = {};
  if (!isAddress(f.cross.trim())) errors.cross = 'This is not a Solana address.';
  let price: bigint | null = null;
  let quantity: bigint | null = null;
  if (market) {
    price = parsePrice(f.price, market);
    if (f.price.trim() === '' || price === null || price === 0n) errors.price = 'A price per token that lands exactly on a price of the cross’s grid.';
    else if (grid && (price < grid.minPrice || grid.tick === 0n || (price - grid.minPrice) % grid.tick !== 0n || (price - grid.minPrice) / grid.tick >= BigInt(grid.ticks))) errors.price = `That price is not on the cross’s grid: it lands exactly on one of the ${grid.ticks} prices from ${formatPrice(grid.minPrice, market)} in steps of ${formatPrice(grid.tick, market)}.`;
    quantity = parseAtoms(f.quantity, market.baseDecimals);
    if (f.quantity.trim() === '' || quantity === null || quantity === 0n) errors.quantity = `A number of tokens above zero with at most ${market.baseDecimals} decimals.`;
  }
  if (Object.keys(errors).length > 0 || !market || !agent || price === null || quantity === null) return { body: null, errors };
  return { body: { agent, mandate, cross: f.cross.trim(), price: price.toString(), quantity: quantity.toString(), ...(salt ? { salt } : {}) }, errors };
}

/** 32 random bytes as 64 hex characters: the salt of a sealed order, which the agent must keep to reveal it. */
export function newSalt(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export const who = (a: string | null | undefined): string => (a ? shortAddress(a) : 'nobody');
