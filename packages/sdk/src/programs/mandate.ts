// Builders for `cross_mandate` (S4, J2; ADR-0650): an owner funds a vault and names one agent; the agent can only place buy orders inside the
// owner's on-chain limits, and the owner can revoke and withdraw at any time. An order a mandate places belongs to the mandate's signer PDA,
// so refunds and no-prints pay back into the vault, and the base side is swept to the owner.
import { type Address, type Instruction, type TransactionSigner, decompileTransactionMessage, getCompiledTransactionMessageDecoder, getTransactionDecoder } from '@solana/kit';
import {
  AllowKind,
  type AllowRule,
  CANCEL_ORDER_DISCRIMINATOR,
  CROSS_MANDATE_PROGRAM_ADDRESS,
  PLACE_ORDER_DISCRIMINATOR,
  REVEAL_ORDER_DISCRIMINATOR,
  type Limits,
  type Mandate,
  findMandatePda,
  findSignerPda,
  getCancelOrderInstruction,
  getCreateMandateInstruction,
  getFundInstruction,
  getPlaceOrderInstruction,
  getRevealOrderInstruction,
  getRevokeInstruction,
  getSetLimitsInstruction,
  getSweepInstruction,
  getWithdrawInstruction,
  getWithdrawLamportsInstruction,
} from '@opening-cross/cross-mandate-client';
import { CROSS_GATE_PROGRAM_ADDRESS } from '@opening-cross/cross-gate-client';
import { type CrossView, type OrderFacts, OrderSide, ata, baseVaultAddress, cancelExtras, commitExtras, costCeil, orderCommitment, orderPlacement, orderPda, protocolAddress, quoteVaultAddress, revealExtras, shardAddress, shardIndexFor, shardIndexOfPlacement, gatePassAddress, withAccounts, Disclosure } from '../index.js';
import { type ProgramIssue, SYSTEM_PROGRAM, createAtaIdempotent, noop, refuse, rentExempt } from './common.js';

export { AllowKind, CROSS_MANDATE_PROGRAM_ADDRESS };
export type { AllowRule, Limits, Mandate };

/** The most of a cross's declared supply one order may buy: 25% (the program's `MAX_SHARE_BPS`). */
export const MANDATE_MAX_SHARE_BPS = 2_500;
/** The longest allow list (the program's `MAX_ALLOW`). */
export const MANDATE_MAX_ALLOW = 8;
/** The largest an order account can be (body and tail), which the signer PDA pays the rent of when it places one (the program's `ORDER_SPACE_MAX`). */
export const MANDATE_ORDER_SPACE_MAX = 8 + 135 + 40;
/** What the signer PDA must hold to place one order: the rent of the largest order plus the minimum of an empty account. */
export const MANDATE_MIN_SIGNER_LAMPORTS: bigint = rentExempt(MANDATE_ORDER_SPACE_MAX) + rentExempt(0);

/** The addresses of a mandate: the account, its signer PDA (which owns every order and the vault) and the vault (the signer's quote token account). */
export type MandateAddresses = { mandate: Address; signer: Address; vault: Address };

export async function mandateAddresses(owner: Address, id: bigint, quoteMint: Address, quoteTokenProgram: Address): Promise<MandateAddresses> {
  const [mandate] = await findMandatePda({ owner, id });
  const [signer] = await findSignerPda({ mandate });
  return { mandate, signer, vault: await ata(signer, quoteMint, quoteTokenProgram) };
}

/** What `Limits::validate` refuses (programs/cross_mandate), found before signing. */
export function checkMandateLimits(limits: Limits, now: bigint): ProgramIssue[] {
  const out: ProgramIssue[] = [];
  const bad = (field: string, message: string) => out.push({ code: 'BadLimits', field, message });
  if (!(limits.maxPerOrder > 0n)) bad('maxPerOrder', 'the most one order may escrow must be positive');
  if (limits.totalCap < limits.maxPerOrder) bad('totalCap', 'the lifetime cap must be at least the per-order limit');
  if (limits.maxShareBps <= 0 || limits.maxShareBps > MANDATE_MAX_SHARE_BPS) bad('maxShareBps', `the share limit is between 1 and ${MANDATE_MAX_SHARE_BPS} basis points (25% of a cross's declared supply at most)`);
  if (!(limits.expiresAt > now)) bad('expiresAt', 'the expiry must be in the future');
  if (limits.allow.length === 0) bad('allow', 'name at least one base mint, creator or cross the agent may buy');
  if (limits.allow.length > MANDATE_MAX_ALLOW) bad('allow', `the allow list holds at most ${MANDATE_MAX_ALLOW} entries`);
  return out;
}

export type CreateMandateInput = { owner: TransactionSigner; agent: Address; id: bigint; quoteMint: Address; quoteTokenProgram: Address; limits: Limits; now?: bigint };

/** `create_mandate`. The owner signs and pays; the agent is only named and must differ from the owner. */
export async function buildCreateMandate(input: CreateMandateInput): Promise<{ instruction: Instruction } & MandateAddresses> {
  const { owner, agent, id, quoteMint, quoteTokenProgram, limits } = input;
  const issues = checkMandateLimits(limits, input.now ?? BigInt(Math.floor(Date.now() / 1000)));
  if (agent === owner.address) issues.push({ code: 'AgentIsOwner', field: 'agent', message: 'the agent must be a different key from the owner' });
  if (agent === SYSTEM_PROGRAM) issues.push({ code: 'AgentIsOwner', field: 'agent', message: 'the agent must be a real key' });
  refuse(issues);
  const a = await mandateAddresses(owner.address, id, quoteMint, quoteTokenProgram);
  const instruction = getCreateMandateInstruction({ owner, agent, quoteMint, mandate: a.mandate, signer: a.signer, vault: a.vault, tokenProgram: quoteTokenProgram, id, limits });
  return { instruction, ...a };
}

/** `fund`: quote tokens into the vault and/or SOL into the signer PDA (it pays the rent of each order it places and gets it back when the order is claimed). */
export async function buildFundMandate(input: { owner: TransactionSigner; mandate: MandateAddresses; quoteMint: Address; quoteTokenProgram: Address; amount: bigint; lamports: bigint }): Promise<Instruction> {
  const { owner, mandate, quoteMint, quoteTokenProgram, amount, lamports } = input;
  refuse(amount > 0n || lamports > 0n ? [] : [{ code: 'NothingToDo', field: 'amount', message: 'fund at least some quote tokens or some SOL' }]);
  return getFundInstruction({ owner, mandate: mandate.mandate, quoteMint, ownerQuote: await ata(owner.address, quoteMint, quoteTokenProgram), vault: mandate.vault, signer: mandate.signer, tokenProgram: quoteTokenProgram, amount, lamports });
}

/** `set_limits`: replaces the limits (the owner only; a revoked mandate stays revoked). */
export function buildSetMandateLimits(input: { owner: TransactionSigner; mandate: Address; limits: Limits; now?: bigint }): Instruction {
  refuse(checkMandateLimits(input.limits, input.now ?? BigInt(Math.floor(Date.now() / 1000))));
  return getSetLimitsInstruction({ owner: input.owner, mandate: input.mandate, limits: input.limits });
}

/** `revoke`: the kill switch. Immediate and permanent. */
export function buildRevokeMandate(input: { owner: TransactionSigner; mandate: Address }): Instruction {
  return getRevokeInstruction({ owner: input.owner, mandate: input.mandate });
}

/** `withdraw`: quote tokens from the vault to the owner's own account (allowed at any time). Creates the owner's account first when `createDestination` is set. */
export async function buildWithdrawMandate(input: { owner: TransactionSigner; mandate: MandateAddresses; quoteMint: Address; quoteTokenProgram: Address; amount: bigint; createDestination?: boolean }): Promise<Instruction[]> {
  const { owner, mandate, quoteMint, quoteTokenProgram, amount } = input;
  refuse(amount > 0n ? [] : [{ code: 'NothingToDo', field: 'amount', message: 'withdraw a positive amount' }]);
  const dest = await ata(owner.address, quoteMint, quoteTokenProgram);
  const ix = getWithdrawInstruction({ owner, mandate: mandate.mandate, quoteMint, vault: mandate.vault, ownerQuote: dest, signer: mandate.signer, tokenProgram: quoteTokenProgram, amount });
  return input.createDestination ? [createAtaIdempotent(owner, owner.address, quoteMint, quoteTokenProgram, dest), ix] : [ix];
}

/** `withdraw_lamports`: SOL from the signer PDA to the owner. The signer keeps the rent-exempt minimum of an empty account or is emptied completely. */
export function buildWithdrawMandateLamports(input: { owner: TransactionSigner; mandate: MandateAddresses; lamports: bigint }): Instruction {
  refuse(input.lamports > 0n ? [] : [{ code: 'NothingToDo', field: 'lamports', message: 'withdraw a positive amount' }]);
  return getWithdrawLamportsInstruction({ owner: input.owner, mandate: input.mandate.mandate, signer: input.mandate.signer, lamports: input.lamports });
}

/** `sweep`: all of a base token the signer PDA holds, to the owner's own account (anyone may send it; the destination is fixed). The owner's account is created first. */
export async function buildSweepMandate(input: { payer: TransactionSigner; owner: Address; mandate: MandateAddresses; mint: Address; tokenProgram: Address }): Promise<Instruction[]> {
  const { payer, owner, mandate, mint, tokenProgram } = input;
  const destination = await ata(owner, mint, tokenProgram);
  const sweep = getSweepInstruction({ mandate: mandate.mandate, signer: mandate.signer, mint, source: await ata(mandate.signer, mint, tokenProgram), destination, tokenProgram });
  return [createAtaIdempotent(payer, owner, mint, tokenProgram, destination), sweep];
}

// ------------------------------------------------------------------ the agent's order

/** The supply a mandate's share limit is measured against: the cross's hard cap on delivered base when it has one, else its declared total supply, else 0. */
export function mandateSupplyReference(cross: CrossView): bigint {
  const g = cross.ext?.guards;
  if (!g) return 0n;
  return g.maxMatched > 0n ? g.maxMatched : g.totalSupply;
}

/** The most base atoms an escrow can pay for: `floor(escrow x price_scale / min_price)`. */
export const maxBaseForEscrow = (escrow: bigint, priceScale: bigint, minPrice: bigint): bigint | null => (minPrice === 0n ? null : (escrow * priceScale) / minPrice);

/** The base an order may be measured to buy, as the program measures it: its own quantity for an open cross, the most the escrow could buy at the lowest price for a sealed one. */
export function mandateShareBound(cross: CrossView, escrow: bigint, quantity: bigint): bigint | null {
  return cross.data.disclosure === Disclosure.Open ? quantity : maxBaseForEscrow(escrow, cross.data.priceScale, cross.data.minPrice);
}

export type MandateOrderFacts = {
  mandate: Pick<Mandate, 'revoked' | 'expiresAt' | 'maxPerOrder' | 'totalCap' | 'committed' | 'maxShareBps' | 'quoteMint' | 'quoteTokenProgram' | 'allow'>;
  cross: CrossView;
  escrow: bigint;
  quantity: bigint;
  now: bigint;
  /** The vault's balance, when known (a chain read). */
  vaultBalance?: bigint;
  /** The signer PDA's lamports, when known. */
  signerLamports?: bigint;
};

/** Every refusal of `place_order` that can be read from the mandate, the cross and the vault, in the program's order. Empty means the program's own checks pass. */
export function checkMandateOrder(f: MandateOrderFacts): ProgramIssue[] {
  const m = f.mandate;
  const c = f.cross.data;
  const out: ProgramIssue[] = [];
  const bad = (code: string, field: string, message: string) => out.push({ code, field, message });
  if (m.revoked) bad('Revoked', 'mandate', 'the owner revoked this mandate; no new order can be placed');
  if (!(f.now < m.expiresAt)) bad('Expired', 'mandate', 'the mandate has expired');
  if (!(f.escrow > 0n)) bad('NothingToDo', 'escrow', 'the escrow must be positive');
  if (f.escrow > m.maxPerOrder) bad('OverPerOrderLimit', 'escrow', `the escrow is over the per-order limit of ${m.maxPerOrder}`);
  if (m.committed + f.escrow > m.totalCap) bad('OverTotalCap', 'escrow', `the order would take the mandate's lifetime total to ${m.committed + f.escrow}, over its cap of ${m.totalCap}`);
  if (f.vaultBalance !== undefined && f.vaultBalance < f.escrow) bad('VaultTooLow', 'escrow', `the vault holds ${f.vaultBalance}, less than the escrow`);
  if (c.quoteMint !== m.quoteMint || c.quoteTokenProgram !== m.quoteTokenProgram) bad('WrongQuote', 'cross', "the cross is not quoted in the mandate's token");
  const allowed = m.allow.some((r) => (r.kind === AllowKind.BaseMint ? c.baseBound && c.baseMint === r.key : r.kind === AllowKind.Creator ? c.creator === r.key : f.cross.address === r.key));
  if (!allowed) bad('NotAllowed', 'cross', "the cross is not on the mandate's allow list (its base mint, its creator or the cross itself)");
  const reference = mandateSupplyReference(f.cross);
  if (reference === 0n) bad('NoSupplyReference', 'cross', 'the cross declares neither a hard cap on delivered base nor a total supply, so a share of it is not a limit');
  else {
    const bound = mandateShareBound(f.cross, f.escrow, f.quantity);
    if (bound === null) bad('Overflow', 'cross', 'the cross has no minimum price to bound a sealed order with');
    else if (bound * 10_000n > reference * BigInt(m.maxShareBps)) bad('OverShareLimit', 'quantity', `the order could buy more than ${m.maxShareBps} basis points of the cross's ${reference} atoms of supply`);
  }
  if (f.signerLamports !== undefined && f.signerLamports < MANDATE_MIN_SIGNER_LAMPORTS) bad('NeedRentFunding', 'mandate', `the signer PDA holds ${f.signerLamports} lamports; placing an order needs ${MANDATE_MIN_SIGNER_LAMPORTS} (fund it with lamports)`);
  return out;
}

export type MandatePlaceInput = {
  agent: TransactionSigner;
  mandate: MandateAddresses & { data: Mandate };
  cross: CrossView;
  nonce: bigint;
  price: bigint;
  quantity: bigint;
  /** Defaults to the exact cost of the order. A sealed order may escrow more to hide its price. */
  escrow?: bigint;
  /** Required for a sealed cross; the reveal needs it. */
  salt?: Uint8Array;
  /** Unix seconds the order will be placed at (an ending period is cut into buckets by the chain clock). */
  now?: bigint;
  vaultBalance?: bigint;
  signerLamports?: bigint;
};

/** `place_order`: the agent's buy order, inside the limits. Every refusal readable from the facts given is thrown first as a `ProgramRefusal`. */
export async function buildMandatePlaceOrder(input: MandatePlaceInput): Promise<{ instruction: Instruction; order: Address; escrow: bigint; commitment: Uint8Array }> {
  const { agent, mandate, cross, nonce, price, quantity } = input;
  const c = cross.data;
  const now = input.now ?? BigInt(Math.floor(Date.now() / 1000));
  const sealed = c.disclosure === Disclosure.Sealed;
  const escrow = input.escrow ?? costCeil(quantity, price, c.priceScale);
  refuse(checkMandateOrder({ mandate: mandate.data, cross, escrow, quantity, now, ...(input.vaultBalance !== undefined && { vaultBalance: input.vaultBalance }), ...(input.signerLamports !== undefined && { signerLamports: input.signerLamports }) }));
  if (sealed && !input.salt) throw new Error('sealed crosses need a 32-byte salt');
  const [order, orderBump] = await orderPda(cross.address, mandate.signer, nonce);
  const commitment: Uint8Array = sealed ? orderCommitment(cross.address, mandate.signer, nonce, OrderSide.Buy, price, quantity, input.salt!) : new Uint8Array(32);
  const shardIndex = orderPlacement(cross, mandate.signer, nonce, now).shardIndex;
  const gateMint = c.gateMint.__option === 'Some' ? c.gateMint.value : null;
  const ix = getPlaceOrderInstruction({
    agent,
    mandate: mandate.mandate,
    signer: mandate.signer,
    quoteMint: c.quoteMint,
    vault: mandate.vault,
    protocol: await protocolAddress(),
    cross: cross.address,
    order,
    ...(sealed ? {} : { shard: await shardAddress(cross.address, shardIndex) }),
    ...(gateMint ? { pass: await gatePassAddress(gateMint, mandate.signer) } : {}),
    escrowVault: await quoteVaultAddress(cross.address),
    tokenProgram: c.quoteTokenProgram,
    nonce,
    escrow,
    commitment,
    price: sealed ? 0n : price,
    quantity: sealed ? 0n : quantity,
    orderBump,
  });
  const extras = await commitExtras(cross.ext ?? null, cross.address, mandate.signer, { class: 0, now, gateProgram: CROSS_GATE_PROGRAM_ADDRESS });
  return { instruction: withAccounts(ix, extras), order, escrow, commitment };
}

function shardOfMandateOrder(cross: CrossView, owner: Address, nonce: bigint, order?: OrderFacts): number {
  return cross.ext && order ? shardIndexOfPlacement(owner, nonce, cross.data.shards, order.ext) : shardIndexFor(owner, nonce, cross.data.shards);
}

/** `reveal_order` for a sealed order the mandate placed (the owner or the agent may send it, also after a revoke or an expiry). */
export async function buildMandateReveal(input: { caller: TransactionSigner; mandate: MandateAddresses; cross: CrossView; nonce: bigint; price: bigint; quantity: bigint; salt: Uint8Array; order?: OrderFacts }): Promise<Instruction> {
  const { caller, mandate, cross, nonce } = input;
  if (cross.ext && !input.order) throw new Error('revealing an order of a cross with rules needs the order (its ending bucket and side)');
  const ix = getRevealOrderInstruction({
    caller,
    mandate: mandate.mandate,
    signer: mandate.signer,
    cross: cross.address,
    order: (await orderPda(cross.address, mandate.signer, nonce))[0],
    shard: await shardAddress(cross.address, shardOfMandateOrder(cross, mandate.signer, nonce, input.order)),
    price: input.price,
    quantity: input.quantity,
    salt: input.salt,
  });
  return withAccounts(ix, await revealExtras(cross.ext ?? null, cross.address, true));
}

/** `cancel_order`: withdraws an order of the mandate during its cross's call window. The refund lands in the vault. */
export async function buildMandateCancel(input: { caller: TransactionSigner; mandate: MandateAddresses; cross: CrossView; nonce: bigint; revealed: boolean; order?: OrderFacts }): Promise<Instruction> {
  const { caller, mandate, cross, nonce, revealed } = input;
  const c = cross.data;
  if (cross.ext && !input.order) throw new Error('cancelling an order of a cross with rules needs the order (its ending bucket and side)');
  const ix = getCancelOrderInstruction({
    caller,
    mandate: mandate.mandate,
    signer: mandate.signer,
    cross: cross.address,
    order: (await orderPda(cross.address, mandate.signer, nonce))[0],
    ...(revealed ? { shard: await shardAddress(cross.address, shardOfMandateOrder(cross, mandate.signer, nonce, input.order)) } : {}),
    baseMint: c.baseMint,
    quoteMint: c.quoteMint,
    quoteVault: await quoteVaultAddress(cross.address),
    baseVault: await baseVaultAddress(cross.address),
    vault: mandate.vault,
    baseTokenProgram: c.baseTokenProgram,
    tokenProgram: c.quoteTokenProgram,
  });
  return withAccounts(ix, await cancelExtras(cross.ext ?? null, cross.address, mandate.signer, { revealed, isBuy: true }));
}

/** The instructions an agent may sign: nothing else moves the mandate's funds. A wallet or an MCP host holding an agent key refuses any other program or discriminator. */
export const MANDATE_AGENT_INSTRUCTIONS = ['place_order', 'cancel_order', 'reveal_order'] as const;

const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';
const AGENT_DISCRIMINATORS: [string, Uint8Array][] = [
  ['place_order', PLACE_ORDER_DISCRIMINATOR as Uint8Array],
  ['cancel_order', CANCEL_ORDER_DISCRIMINATOR as Uint8Array],
  ['reveal_order', REVEAL_ORDER_DISCRIMINATOR as Uint8Array],
];

/**
 * The guard a host that holds an agent key runs on a transaction before it signs: every instruction must be a compute-budget instruction that sets the unit
 * limit or price, or one of `cross_mandate`'s `place_order`, `cancel_order` and `reveal_order`. A transaction with anything else (a transfer, an approval, another
 * program, a version-0 transaction that loads accounts from a lookup table) is not ok, with a sentence per instruction that fails the test. Nothing is signed or sent.
 */
export function inspectMandateAgentTransaction(base64: string): { ok: boolean; instructions: { program: string; name: string | null }[]; issues: ProgramIssue[] } {
  const issues: ProgramIssue[] = [];
  const instructions: { program: string; name: string | null }[] = [];
  let ixs: readonly Instruction[] = [];
  try {
    const decoded = getTransactionDecoder().decode(Uint8Array.from(Buffer.from(base64, 'base64')));
    const message = getCompiledTransactionMessageDecoder().decode(decoded.messageBytes);
    if ('addressTableLookups' in message && message.addressTableLookups && message.addressTableLookups.length > 0) issues.push({ code: 'LookupTable', field: 'transaction', message: 'the transaction loads accounts from an address lookup table, which this check cannot read; build it without one' });
    else ixs = decompileTransactionMessage(message).instructions;
  } catch {
    issues.push({ code: 'Undecodable', field: 'transaction', message: 'the bytes are not a Solana transaction this check can read' });
  }
  ixs.forEach((ix, i) => {
    const data = ix.data ?? new Uint8Array();
    if (ix.programAddress === COMPUTE_BUDGET) {
      const tag = data[0];
      instructions.push({ program: ix.programAddress, name: tag === 2 ? 'set_compute_unit_limit' : tag === 3 ? 'set_compute_unit_price' : null });
      if (tag !== 2 && tag !== 3) issues.push({ code: 'NotAllowed', field: `instructions[${i}]`, message: 'only the compute-unit limit and price may be set' });
      return;
    }
    if (ix.programAddress !== CROSS_MANDATE_PROGRAM_ADDRESS) {
      instructions.push({ program: ix.programAddress, name: null });
      issues.push({ code: 'NotAllowed', field: `instructions[${i}]`, message: `instruction ${i} calls ${ix.programAddress}; an agent key signs only cross_mandate's ${MANDATE_AGENT_INSTRUCTIONS.join(', ')}` });
      return;
    }
    const hit = AGENT_DISCRIMINATORS.find(([, d]) => d.every((b, k) => data[k] === b));
    instructions.push({ program: ix.programAddress, name: hit ? hit[0] : null });
    if (!hit) issues.push({ code: 'NotAllowed', field: `instructions[${i}]`, message: `instruction ${i} is a cross_mandate instruction an agent may not send; an agent key signs only ${MANDATE_AGENT_INSTRUCTIONS.join(', ')}` });
  });
  if (ixs.length > 0 && !instructions.some((x) => x.name === 'place_order' || x.name === 'cancel_order' || x.name === 'reveal_order')) issues.push({ code: 'NothingToSign', field: 'transaction', message: 'the transaction has no cross_mandate instruction' });
  return { ok: issues.length === 0 && ixs.length > 0, instructions, issues };
}

export { noop as mandateSigner, CROSS_MANDATE_PROGRAM_ADDRESS as MANDATE_PROGRAM_ADDRESS };
