// Helpers for `cross_mandate` tests: a mandate, its signer PDA and vault, and the instructions an agent and an owner send.
// An order placed through a mandate belongs to the mandate's signer PDA, so claims, cancels and reveals address that PDA
// as the order's owner.
import { type Address, type Instruction, type KeyPairSigner } from '@solana/kit';
import {
  type Limits,
  AllowKind,
  getCancelOrderInstruction,
  getCreateMandateInstruction,
  getFundInstruction,
  getMandateDecoder,
  getPlaceOrderInstruction,
  getRevealOrderInstruction,
  getRevokeInstruction,
  getSetLimitsInstruction,
  getSweepInstruction,
  getWithdrawInstruction,
  getWithdrawLamportsInstruction,
  findMandatePda,
  findSignerPda,
} from '@opening-cross/cross-mandate-client';
import {
  type CrossView,
  AUX_END_BASE,
  AUX_EXT_BASE,
  Disclosure,
  OrderSide,
  ata,
  baseVaultAddress,
  commitExtras,
  cancelExtras,
  costCeil,
  orderCommitment,
  orderPda,
  placementAt,
  protocolAddress,
  quoteVaultAddress,
  revealExtras,
  shardAddress,
  shardIndexFor,
  withAccounts,
  gatePassAddress,
} from '@opening-cross/sdk';
import { TOKEN_2022_PROGRAM_ADDRESS, getCreateAssociatedTokenIdempotentInstruction } from '@solana-program/token-2022';
import { CROSS_GATE_PROGRAM_ADDRESS } from '@opening-cross/cross-gate-client';
import { salt } from './harness.js';
import { type RView, type RulesWorld } from './rules-world.js';
import type { PlacedOrder } from './world.js';

export { AllowKind };
export type { Limits };

export type Mandate = {
  address: Address;
  signer: Address;
  vault: Address;
  owner: KeyPairSigner;
  agent: KeyPairSigner;
  id: bigint;
};

export type MandatePlaced = {
  nonce: bigint;
  escrow: bigint;
  price: bigint;
  quantity: bigint;
  salt: Uint8Array;
  order: Address;
};

/** A stand-in for a placed order whose owner is the mandate's signer PDA, in the shape the RulesWorld claim builders take. */
export function asOrder(m: Mandate, p: MandatePlaced, side: OrderSide = OrderSide.Buy): PlacedOrder {
  return { owner: { address: m.signer } as unknown as KeyPairSigner, nonce: p.nonce, side, price: p.price, quantity: p.quantity, escrow: p.escrow, index: 0, salt: p.salt, reveal: true };
}

export function readMandate(w: RulesWorld, m: Mandate) {
  const a = w.h.svm.getAccount(m.address);
  if (!a.exists) throw new Error('mandate missing');
  return getMandateDecoder().decode(a.data);
}

export async function mandateAddresses(owner: Address, id: bigint, quoteMint: Address) {
  const [address] = await findMandatePda({ owner, id });
  const [signer] = await findSignerPda({ mandate: address });
  const vault = await ata(signer, quoteMint, TOKEN_2022_PROGRAM_ADDRESS);
  return { address, signer, vault };
}

export const limits = (w: RulesWorld, over: Partial<Limits> & { allowCreator?: boolean } = {}): Limits => ({
  maxPerOrder: 500_000_000n,
  totalCap: 1_000_000_000n,
  maxShareBps: 2_500,
  expiresAt: w.h.svm.getClock().unixTimestamp + 1_000_000n,
  allow: [{ kind: AllowKind.Creator, key: w.creator.address }],
  ...over,
});

export async function createMandate(w: RulesWorld, owner: KeyPairSigner, agent: KeyPairSigner, id: bigint, lim: Limits, fund: { quote?: bigint; lamports?: bigint } = {}): Promise<Mandate> {
  const { address, signer, vault } = await mandateAddresses(owner.address, id, w.quoteMint);
  const ixs: Instruction[] = [
    getCreateMandateInstruction({ owner, agent: agent.address, quoteMint: w.quoteMint, mandate: address, signer, vault, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS, id, limits: lim }),
  ];
  const m: Mandate = { address, signer, vault, owner, agent, id };
  await w.h.send(ixs, owner);
  if (fund.quote || fund.lamports) await w.h.send([await fundIx(w, m, fund.quote ?? 0n, fund.lamports ?? 0n)], owner);
  return m;
}

export async function fundIx(w: RulesWorld, m: Mandate, amount: bigint, lamports: bigint, who: KeyPairSigner = m.owner): Promise<Instruction> {
  return getFundInstruction({
    owner: who,
    mandate: m.address,
    quoteMint: w.quoteMint,
    ownerQuote: await ata(who.address, w.quoteMint, TOKEN_2022_PROGRAM_ADDRESS),
    vault: m.vault,
    signer: m.signer,
    tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    amount,
    lamports,
  });
}

export const setLimitsIx = (m: Mandate, lim: Limits, who: KeyPairSigner = m.owner) => getSetLimitsInstruction({ owner: who, mandate: m.address, limits: lim });
export const revokeIx = (m: Mandate, who: KeyPairSigner = m.owner) => getRevokeInstruction({ owner: who, mandate: m.address });

export async function withdrawIx(w: RulesWorld, m: Mandate, amount: bigint, who: KeyPairSigner = m.owner, dest?: Address): Promise<Instruction> {
  return getWithdrawInstruction({
    owner: who,
    mandate: m.address,
    quoteMint: w.quoteMint,
    vault: m.vault,
    ownerQuote: dest ?? (await ata(who.address, w.quoteMint, TOKEN_2022_PROGRAM_ADDRESS)),
    signer: m.signer,
    tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    amount,
  });
}

export const withdrawLamportsIx = (m: Mandate, lamports: bigint, who: KeyPairSigner = m.owner) =>
  getWithdrawLamportsInstruction({ owner: who, mandate: m.address, signer: m.signer, lamports });

/** The instructions that move all of a base token the signer PDA holds to `destination` (the owner's account by default). */
export async function sweepIxs(m: Mandate, mint: Address, payer: KeyPairSigner, destination?: Address): Promise<Instruction[]> {
  const dest = destination ?? (await ata(m.owner.address, mint, TOKEN_2022_PROGRAM_ADDRESS));
  const sweep = getSweepInstruction({ mandate: m.address, signer: m.signer, mint, source: await ata(m.signer, mint, TOKEN_2022_PROGRAM_ADDRESS), destination: dest, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS });
  // The owner's account is created (idempotently) in the same transaction; a custom destination is taken as given.
  return destination ? [sweep] : [getCreateAssociatedTokenIdempotentInstruction({ payer, ata: dest, owner: m.owner.address, mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS }), sweep];
}

export async function placeIx(w: RulesWorld, view: RView, m: Mandate, nonce: bigint, price: bigint, quantity: bigint, opts: { escrow?: bigint; agent?: KeyPairSigner; salt?: Uint8Array } = {}): Promise<{ ix: Instruction; placed: MandatePlaced }> {
  const c = view.data;
  const sealed = c.disclosure === Disclosure.Sealed;
  const escrow = opts.escrow ?? costCeil(quantity, price, c.priceScale);
  const s = opts.salt ?? salt();
  const [order, orderBump] = await orderPda(view.address, m.signer, nonce);
  const commitment = sealed ? orderCommitment(view.address, m.signer, nonce, OrderSide.Buy, price, quantity, s) : new Uint8Array(32);
  const now = w.h.svm.getClock().unixTimestamp;
  const placement = placementAt(view.ext, c.closeTs, now);
  const shardIndex = placement.epoch > 0 ? AUX_EXT_BASE + shardIndexFor(m.signer, nonce, Math.min(Math.max(c.shards, 1), 8)) : placement.bucket !== 255 ? AUX_END_BASE + placement.bucket : shardIndexFor(m.signer, nonce, c.shards);
  const gateMint = c.gateMint.__option === 'Some' ? c.gateMint.value : null;
  const ix = getPlaceOrderInstruction({
    agent: opts.agent ?? m.agent,
    mandate: m.address,
    signer: m.signer,
    quoteMint: c.quoteMint,
    vault: m.vault,
    protocol: await protocolAddress(),
    cross: view.address,
    order,
    ...(sealed ? {} : { shard: await shardAddress(view.address, shardIndex) }),
    ...(gateMint ? { pass: await gatePassAddress(gateMint, m.signer) } : {}),
    escrowVault: await quoteVaultAddress(view.address),
    tokenProgram: c.quoteTokenProgram,
    nonce,
    escrow,
    commitment,
    price: sealed ? 0n : price,
    quantity: sealed ? 0n : quantity,
    orderBump,
  });
  const extras = await commitExtras(view.ext, view.address, m.signer, { class: 0, now, gateProgram: CROSS_GATE_PROGRAM_ADDRESS });
  return { ix: withAccounts(ix, extras), placed: { nonce, escrow, price, quantity, salt: s, order } };
}

export async function revealIx(w: RulesWorld, view: RView, m: Mandate, p: MandatePlaced, who: KeyPairSigner = m.agent): Promise<Instruction> {
  const c = view.data;
  const orderExt = await w.orderExt(view.address, asOrder(m, p));
  const idx = orderExt.epoch > 0 ? AUX_EXT_BASE + shardIndexFor(m.signer, p.nonce, Math.min(Math.max(c.shards, 1), 8)) : orderExt.bucket !== 255 ? AUX_END_BASE + orderExt.bucket : shardIndexFor(m.signer, p.nonce, c.shards);
  const ix = getRevealOrderInstruction({
    caller: who,
    mandate: m.address,
    signer: m.signer,
    cross: view.address,
    order: p.order,
    shard: await shardAddress(view.address, idx),
    price: p.price,
    quantity: p.quantity,
    salt: p.salt,
  });
  return withAccounts(ix, await revealExtras(view.ext, view.address, true));
}

export async function cancelIx(w: RulesWorld, view: RView, m: Mandate, p: MandatePlaced, who: KeyPairSigner = m.agent): Promise<Instruction> {
  const c = view.data;
  const revealed = c.disclosure === Disclosure.Open;
  const orderExt = await w.orderExt(view.address, asOrder(m, p));
  const idx = orderExt.epoch > 0 ? AUX_EXT_BASE + shardIndexFor(m.signer, p.nonce, Math.min(Math.max(c.shards, 1), 8)) : orderExt.bucket !== 255 ? AUX_END_BASE + orderExt.bucket : shardIndexFor(m.signer, p.nonce, c.shards);
  const ix = getCancelOrderInstruction({
    caller: who,
    mandate: m.address,
    signer: m.signer,
    cross: view.address,
    order: p.order,
    ...(revealed ? { shard: await shardAddress(view.address, idx) } : {}),
    baseMint: c.baseMint,
    quoteMint: c.quoteMint,
    quoteVault: await quoteVaultAddress(view.address),
    baseVault: await baseVaultAddress(view.address),
    vault: m.vault,
    baseTokenProgram: c.baseTokenProgram,
    tokenProgram: c.quoteTokenProgram,
  });
  return withAccounts(ix, await cancelExtras(view.ext, view.address, m.signer, { revealed, isBuy: true }));
}

export { placementAt, TOKEN_2022_PROGRAM_ADDRESS };
export type { CrossView };
