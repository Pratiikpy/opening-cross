// cross_mandate over HTTP (S4, J2; ADR-0650): an owner funds a vault and names one agent; the agent can only place buy orders inside the owner's
// on-chain limits; the owner can revoke and withdraw at any time. Unsigned transactions and reads. The API holds no key.
//
// The program is proved on LiteSVM and a local validator and is NOT deployed to devnet until the operations key is funded (docs/HUMAN_TASKS.md H27, H43):
// every transaction route answers 409 PROGRAM_NOT_DEPLOYED until it is, and the reads say so.
//
//   POST /v1/tx/mandate-create             { owner, agent, id?, quoteMint, limits, fund?: { amount?, lamports? } }
//   POST /v1/tx/mandate-fund               { owner, mandate, amount?, lamports? }
//   POST /v1/tx/mandate-set-limits         { owner, mandate, limits }
//   POST /v1/tx/mandate-revoke             { owner, mandate }
//   POST /v1/tx/mandate-withdraw           { owner, mandate, amount? }            default: everything in the vault
//   POST /v1/tx/mandate-withdraw-lamports  { owner, mandate, lamports? | all: true }
//   POST /v1/tx/mandate-sweep              { payer, mandate, mint }               the base token a filled order left in the signer PDA, to the owner
//   POST /v1/tx/mandate-place-order        { agent, mandate, cross, price, quantity, nonce?, escrow?, salt? }   the agent signs
//   POST /v1/tx/mandate-cancel-order       { caller, mandate, cross, nonce }      the owner or the agent
//   POST /v1/tx/mandate-reveal-order       { caller, mandate, cross, nonce, price, quantity, salt }
//   POST /v1/mandates/check-transaction    { transaction }                        what an agent host runs before it signs
//   GET  /v1/mandates/:address             the mandate, its vault and signer balances, what the agent can still do
//   GET  /v1/mandates?owner=&agent=&limit= the index
//   GET  /v1/mandates/:address/activity    the events and the orders the mandate placed
//   GET  /v1/owners/:owner/mandates        the owner's mandates with the next free id
//
// `limits` is { maxPerOrder, totalCap, maxShareBps, expiresAt, allow: [{ kind: "base_mint" | "creator" | "cross", key }] } (amounts decimal strings, times Unix seconds).
import type { FastifyInstance, FastifyReply } from 'fastify';
import { type Address, createNoopSigner } from '@solana/kit';
import {
  CREATE_MANDATE_DISCRIMINATOR,
  FUND_DISCRIMINATOR,
  type Limits,
  type Mandate,
  MANDATE_DISCRIMINATOR,
  CANCEL_ORDER_DISCRIMINATOR,
  PLACE_ORDER_DISCRIMINATOR,
  REVEAL_ORDER_DISCRIMINATOR,
  REVOKE_DISCRIMINATOR,
  SET_LIMITS_DISCRIMINATOR,
  SWEEP_DISCRIMINATOR,
  WITHDRAW_DISCRIMINATOR,
  WITHDRAW_LAMPORTS_DISCRIMINATOR,
  getMandateDecoder,
} from '@opening-cross/cross-mandate-client';
import {
  AllowKind,
  CROSS_MANDATE_PROGRAM_ADDRESS,
  CrossState,
  Disclosure,
  MANDATE_AGENT_INSTRUCTIONS,
  MANDATE_MIN_SIGNER_LAMPORTS,
  OrderSide,
  type MandateAddresses,
  ORDER_DISCRIMINATOR,
  SPL_TOKEN_PROGRAM,
  TOKEN_2022_PROGRAM,
  ata,
  buildCreateMandate,
  buildFundMandate,
  buildMandatePlaceOrder,
  buildMandateCancel,
  buildMandateReveal,
  buildRevokeMandate,
  buildSetMandateLimits,
  buildSweepMandate,
  buildWithdrawMandate,
  buildWithdrawMandateLamports,
  checkMandateLimits,
  checkMandateOrder,
  getOrderDecoder,
  inspectMandateAgentTransaction,
  mandateAddresses,
  mandateSupplyReference,
  orderAddress,
  readOrderExt,
  rentExempt,
} from '@opening-cross/sdk';
import { type Lifetime, RequestError } from '../tx.js';
import { addr, hex32, int, i64, json, list, obj, only, opt, u64 } from './_inputs.js';
import { hasActiveTransferHook } from './meteora-tx.js';
import { rpcLamports } from './holder-balances.js';
import {
  type AccountReader,
  type Db,
  type ProgramRelease,
  building,
  failIf,
  mintOf,
  oneTx,
  programRelease,
  readAccount,
  readCross,
  releaseNote,
  requireNew,
  tokenBalance,
} from './programs-support.js';

export type MandateTxDeps = {
  account: AccountReader;
  lifetime: () => Promise<Lifetime>;
  db?: Db;
  /** Unix seconds; defaults to the wall clock. Tests inject one. */
  clock?: () => number;
  /** Replaces the release check (tests); by default the program's own bytes are read. */
  gate?: ProgramRelease;
  /** Lamports of an account; defaults to JSON-RPC against RPC_URL. */
  lamports?: (a: Address) => Promise<bigint>;
};

const send = (reply: FastifyReply, v: unknown, status = 200) => reply.code(status).type('application/json').send(json(v));
const KINDS: Record<string, AllowKind> = { base_mint: AllowKind.BaseMint, creator: AllowKind.Creator, cross: AllowKind.Cross };
const KIND_NAMES = ['base_mint', 'creator', 'cross'];
const MAX_NONCE_PROBES = 64;

export function parseLimits(raw: unknown): Limits {
  const l = obj(raw, 'limits');
  only(l, ['maxPerOrder', 'totalCap', 'maxShareBps', 'expiresAt', 'allow'], 'limits');
  const allow = list(l.allow, 'limits.allow', 64, (x, i) => {
    const r = obj(x, `limits.allow[${i}]`);
    only(r, ['kind', 'key'], `limits.allow[${i}]`);
    const kind = typeof r.kind === 'string' ? KINDS[r.kind] : typeof r.kind === 'number' && Number.isInteger(r.kind) && r.kind >= 0 && r.kind <= 2 ? (r.kind as AllowKind) : undefined;
    if (kind === undefined) throw new RequestError(400, `limits.allow[${i}].kind must be "base_mint", "creator" or "cross"`);
    return { kind, key: addr(r.key, `limits.allow[${i}].key`) };
  });
  return { maxPerOrder: u64(l.maxPerOrder, 'limits.maxPerOrder'), totalCap: u64(l.totalCap, 'limits.totalCap'), maxShareBps: int(l.maxShareBps, 'limits.maxShareBps', 0xffff), expiresAt: i64(l.expiresAt, 'limits.expiresAt'), allow };
}

const limitsJson = (m: Pick<Mandate, 'maxPerOrder' | 'totalCap' | 'maxShareBps' | 'expiresAt' | 'allow'>) => ({
  maxPerOrder: m.maxPerOrder,
  totalCap: m.totalCap,
  maxShareBps: m.maxShareBps,
  expiresAt: m.expiresAt,
  allow: m.allow.map((r) => ({ kind: KIND_NAMES[r.kind], key: r.key })),
});

export function registerMandateTx(app: FastifyInstance, d: MandateTxDeps): void {
  const now = () => BigInt(d.clock?.() ?? Math.floor(Date.now() / 1000));
  const gate = d.gate ?? programRelease({ account: d.account, ...(d.clock && { clock: d.clock }) });
  const lamports = d.lamports ?? rpcLamports;
  const need = (name: string, discriminator: Uint8Array) => requireNew(gate, 'crossMandate', { name, discriminator });

  async function readMandate(address: Address) {
    const { value } = await readAccount(d.account, address, { owner: CROSS_MANDATE_PROGRAM_ADDRESS, disc: MANDATE_DISCRIMINATOR as Uint8Array, decode: (b) => getMandateDecoder().decode(b), what: 'mandate', reason: 'NO_SUCH_MANDATE' });
    const addresses = await mandateAddresses(value.owner, value.id, value.quoteMint, value.quoteTokenProgram);
    if (addresses.mandate !== address) throw new RequestError(404, `${address} is not a mandate at its own address`, { reason: 'NO_SUCH_MANDATE' });
    return { data: value, ...addresses };
  }
  const signerLamports = (signer: Address) => lamports(signer).catch(() => undefined);
  const owned = (m: { data: Mandate }, who: Address, field: string) => {
    if (m.data.owner !== who) throw new RequestError(422, `${field} ${who} is not the owner of this mandate (${m.data.owner}).`, { reason: 'NOT_THE_OWNER', owner: m.data.owner });
  };
  async function quoteMint(mint: Address) {
    const m = await mintOf(d.account, mint, 'quoteMint');
    if (m.tokenProgram === TOKEN_2022_PROGRAM && hasActiveTransferHook(m.data)) {
      throw new RequestError(422, `The quote mint ${mint} runs a transfer hook on every transfer. A mandate's vault is built here without hook accounts, so a deposit or an order could fail. Refused.`, { reason: 'MINT_HAS_TRANSFER_HOOK', mint });
    }
    return m.tokenProgram;
  }
  const tx = async (payer: Address, ixs: Parameters<typeof oneTx>[1], what: string) => oneTx(payer, ixs, await d.lifetime(), what);
  const quoteAmount = async (owner: Address, mint: Address, program: Address) => tokenBalance(d.account, await ata(owner, mint, program));

  // ---------------------------------------------------------------- the owner
  app.post('/v1/tx/mandate-create', async (req, reply) => {
    const b = obj(req.body);
    only(b, ['owner', 'agent', 'id', 'quoteMint', 'limits', 'fund'], 'mandate-create');
    const owner = addr(b.owner, 'owner');
    const agent = addr(b.agent, 'agent');
    const mint = addr(b.quoteMint, 'quoteMint');
    const limits = parseLimits(b.limits);
    const fund = b.fund === undefined || b.fund === null ? null : obj(b.fund, 'fund');
    if (fund) only(fund, ['amount', 'lamports'], 'fund');
    const amount = fund ? opt(fund.amount, (v) => u64(v, 'fund.amount')) ?? 0n : 0n;
    const sol = fund ? opt(fund.lamports, (v) => u64(v, 'fund.lamports')) ?? 0n : 0n;
    const release = await need('create_mandate', CREATE_MANDATE_DISCRIMINATOR as Uint8Array);
    const program = await quoteMint(mint);
    let id = opt(b.id, (v) => u64(v, 'id'));
    if (id === null) {
      for (let i = 0n; i < BigInt(MAX_NONCE_PROBES) && id === null; i++) if (!(await d.account((await mandateAddresses(owner, i, mint, program)).mandate))) id = i;
      if (id === null) throw new RequestError(409, `The owner already has ${MAX_NONCE_PROBES} mandates from id 0; name an id.`, { reason: 'ID_RANGE_FULL' });
    } else if (await d.account((await mandateAddresses(owner, id, mint, program)).mandate)) {
      throw new RequestError(409, `The owner already has a mandate with id ${id}.`, { reason: 'ALREADY_EXISTS', id });
    }
    const created = await building(() => buildCreateMandate({ owner: createNoopSigner(owner), agent, id: id!, quoteMint: mint, quoteTokenProgram: program, limits, now: now() }));
    const ixs = [created.instruction];
    if (amount > 0n || sol > 0n) {
      if (amount > 0n) {
        const have = await quoteAmount(owner, mint, program);
        if (have === null) throw new RequestError(409, `The owner has no token account for ${mint}, so there is nothing to fund the vault with.`, { reason: 'NO_QUOTE_ACCOUNT', mint });
        if (have < amount) throw new RequestError(422, `The owner holds ${have} of the quote token; ${amount} was asked for.`, { reason: 'INSUFFICIENT_QUOTE', have, need: amount });
      }
      ixs.push(await buildFundMandate({ owner: createNoopSigner(owner), mandate: created, quoteMint: mint, quoteTokenProgram: program, amount, lamports: sol }));
    }
    const built = await tx(owner, ixs, 'mandate creation');
    return send(reply, { ...built, id, mandate: created.mandate, signer: created.signer, vault: created.vault, funded: { amount, lamports: sol }, minSignerLamports: MANDATE_MIN_SIGNER_LAMPORTS, release, note: sol === 0n ? `The agent places an order only while the signer account holds at least ${MANDATE_MIN_SIGNER_LAMPORTS} lamports (the rent of the largest order); fund it with lamports.` : undefined });
  });

  app.post('/v1/tx/mandate-fund', async (req, reply) => {
    const b = obj(req.body);
    only(b, ['owner', 'mandate', 'amount', 'lamports'], 'mandate-fund');
    const owner = addr(b.owner, 'owner');
    const amount = opt(b.amount, (v) => u64(v, 'amount')) ?? 0n;
    const sol = opt(b.lamports, (v) => u64(v, 'lamports')) ?? 0n;
    const release = await need('fund', FUND_DISCRIMINATOR as Uint8Array);
    const m = await readMandate(addr(b.mandate, 'mandate'));
    owned(m, owner, 'owner');
    if (amount > 0n) {
      const have = await quoteAmount(owner, m.data.quoteMint, m.data.quoteTokenProgram);
      if (have === null) throw new RequestError(409, `The owner has no token account for ${m.data.quoteMint}.`, { reason: 'NO_QUOTE_ACCOUNT', mint: m.data.quoteMint });
      if (have < amount) throw new RequestError(422, `The owner holds ${have} of the quote token; ${amount} was asked for.`, { reason: 'INSUFFICIENT_QUOTE', have, need: amount });
    }
    const ix = await building(() => buildFundMandate({ owner: createNoopSigner(owner), mandate: m, quoteMint: m.data.quoteMint, quoteTokenProgram: m.data.quoteTokenProgram, amount, lamports: sol }));
    return send(reply, { ...(await tx(owner, [ix], 'mandate funding')), mandate: m.mandate, vault: m.vault, signer: m.signer, funded: { amount, lamports: sol }, release });
  });

  app.post('/v1/tx/mandate-set-limits', async (req, reply) => {
    const b = obj(req.body);
    only(b, ['owner', 'mandate', 'limits'], 'mandate-set-limits');
    const owner = addr(b.owner, 'owner');
    const limits = parseLimits(b.limits);
    const release = await need('set_limits', SET_LIMITS_DISCRIMINATOR as Uint8Array);
    const m = await readMandate(addr(b.mandate, 'mandate'));
    owned(m, owner, 'owner');
    if (m.data.revoked) throw new RequestError(409, 'This mandate was revoked; a revoked mandate stays revoked and its limits cannot change.', { reason: 'REVOKED' });
    failIf(checkMandateLimits(limits, now()), 'The limits are not valid');
    const ix = buildSetMandateLimits({ owner: createNoopSigner(owner), mandate: m.mandate, limits, now: now() });
    return send(reply, { ...(await tx(owner, [ix], 'limits change')), mandate: m.mandate, limits: limitsJson(limits), committed: m.data.committed, release });
  });

  app.post('/v1/tx/mandate-revoke', async (req, reply) => {
    const b = obj(req.body);
    only(b, ['owner', 'mandate'], 'mandate-revoke');
    const owner = addr(b.owner, 'owner');
    const release = await need('revoke', REVOKE_DISCRIMINATOR as Uint8Array);
    const m = await readMandate(addr(b.mandate, 'mandate'));
    owned(m, owner, 'owner');
    if (m.data.revoked) throw new RequestError(409, 'This mandate is already revoked.', { reason: 'REVOKED' });
    return send(reply, {
      ...(await tx(owner, [buildRevokeMandate({ owner: createNoopSigner(owner), mandate: m.mandate })], 'revocation')),
      mandate: m.mandate,
      permanent: true,
      note: 'Revocation is immediate and permanent. Orders already placed can still be cancelled while their cross takes cancels and are claimed after it; the vault can be withdrawn at any time.',
      release,
    });
  });

  app.post('/v1/tx/mandate-withdraw', async (req, reply) => {
    const b = obj(req.body);
    only(b, ['owner', 'mandate', 'amount'], 'mandate-withdraw');
    const owner = addr(b.owner, 'owner');
    const release = await need('withdraw', WITHDRAW_DISCRIMINATOR as Uint8Array);
    const m = await readMandate(addr(b.mandate, 'mandate'));
    owned(m, owner, 'owner');
    const held = (await tokenBalance(d.account, m.vault)) ?? 0n;
    const amount = opt(b.amount, (v) => u64(v, 'amount')) ?? held;
    if (amount === 0n) throw new RequestError(409, 'The vault holds nothing to withdraw.', { reason: 'NOTHING_TO_WITHDRAW' });
    if (amount > held) throw new RequestError(422, `The vault holds ${held}; ${amount} was asked for.`, { reason: 'OVER_VAULT', held, asked: amount });
    const ixs = await building(() => buildWithdrawMandate({ owner: createNoopSigner(owner), mandate: m, quoteMint: m.data.quoteMint, quoteTokenProgram: m.data.quoteTokenProgram, amount, createDestination: true }));
    return send(reply, { ...(await tx(owner, ixs, 'withdrawal')), mandate: m.mandate, amount, remaining: held - amount, release });
  });

  app.post('/v1/tx/mandate-withdraw-lamports', async (req, reply) => {
    const b = obj(req.body);
    only(b, ['owner', 'mandate', 'lamports', 'all'], 'mandate-withdraw-lamports');
    const owner = addr(b.owner, 'owner');
    const release = await need('withdraw_lamports', WITHDRAW_LAMPORTS_DISCRIMINATOR as Uint8Array);
    const m = await readMandate(addr(b.mandate, 'mandate'));
    owned(m, owner, 'owner');
    const held = await signerLamports(m.signer);
    const all = b.all === true;
    if (all && held === undefined) throw new RequestError(409, 'The signer account balance could not be read just now; name the lamports or retry.', { reason: 'BALANCE_UNAVAILABLE' });
    const sol = all ? held! : u64(b.lamports, 'lamports');
    if (sol === 0n) throw new RequestError(409, 'The signer account holds no SOL.', { reason: 'NOTHING_TO_WITHDRAW' });
    if (held !== undefined) {
      if (sol > held) throw new RequestError(422, `The signer account holds ${held} lamports; ${sol} was asked for.`, { reason: 'OVER_BALANCE', held, asked: sol });
      const left = held - sol;
      if (left !== 0n && left < rentExempt(0)) throw new RequestError(422, `The signer account must keep ${rentExempt(0)} lamports (the rent of an empty account) or be emptied; this would leave ${left}.`, { reason: 'BELOW_RENT_EXEMPT', left, minimum: rentExempt(0) });
    }
    return send(reply, { ...(await tx(owner, [buildWithdrawMandateLamports({ owner: createNoopSigner(owner), mandate: m, lamports: sol })], 'SOL withdrawal')), mandate: m.mandate, lamports: sol, release });
  });

  app.post('/v1/tx/mandate-sweep', async (req, reply) => {
    const b = obj(req.body);
    only(b, ['payer', 'mandate', 'mint'], 'mandate-sweep');
    const payer = addr(b.payer, 'payer');
    const mint = addr(b.mint, 'mint');
    const release = await need('sweep', SWEEP_DISCRIMINATOR as Uint8Array);
    const m = await readMandate(addr(b.mandate, 'mandate'));
    if (mint === m.data.quoteMint) throw new RequestError(422, 'The quote token never goes through sweep: it stays in the vault until the owner withdraws it.', { reason: 'QUOTE_STAYS_IN_VAULT' });
    const { tokenProgram } = await mintOf(d.account, mint);
    const held = (await tokenBalance(d.account, await ata(m.signer, mint, tokenProgram))) ?? 0n;
    if (held === 0n) throw new RequestError(409, 'The mandate holds none of this token.', { reason: 'NOTHING_TO_SWEEP' });
    const ixs = await building(() => buildSweepMandate({ payer: createNoopSigner(payer), owner: m.data.owner, mandate: m, mint, tokenProgram }));
    return send(reply, { ...(await tx(payer, ixs, 'sweep')), mandate: m.mandate, mint, amount: held, to: m.data.owner, release });
  });

  // ---------------------------------------------------------------- the agent
  app.post('/v1/tx/mandate-place-order', async (req, reply) => {
    const b = obj(req.body);
    only(b, ['agent', 'mandate', 'cross', 'price', 'quantity', 'nonce', 'escrow', 'salt'], 'mandate-place-order');
    const agent = addr(b.agent, 'agent');
    const price = u64(b.price, 'price');
    const quantity = u64(b.quantity, 'quantity');
    const salt = b.salt === undefined || b.salt === null ? undefined : hex32(b.salt, 'salt');
    const release = await need('place_order', PLACE_ORDER_DISCRIMINATOR as Uint8Array);
    const m = await readMandate(addr(b.mandate, 'mandate'));
    if (m.data.agent !== agent) throw new RequestError(422, `${agent} is not this mandate's agent (${m.data.agent}); only the agent can place orders.`, { reason: 'NOT_THE_AGENT', agent: m.data.agent });
    const cross = await readCross(d.account, addr(b.cross, 'cross'));
    if (cross.data.state !== CrossState.Live) throw new RequestError(409, 'The cross is not taking orders.', { reason: 'NOT_LIVE', state: CrossState[cross.data.state] });
    if (cross.data.disclosure === Disclosure.Sealed && !salt) throw new RequestError(400, 'sealed cross: provide a 32-byte hex salt and keep it for the reveal');
    let nonce = opt(b.nonce, (v) => u64(v, 'nonce'));
    if (nonce === null) {
      for (let i = 0n; i < BigInt(MAX_NONCE_PROBES) && nonce === null; i++) if (!(await d.account(await orderAddress(cross.address, m.signer, i)))) nonce = i;
      if (nonce === null) throw new RequestError(409, `The mandate has ${MAX_NONCE_PROBES} orders in this cross from nonce 0; name a nonce.`, { reason: 'NONCE_RANGE_FULL' });
    } else if (await d.account(await orderAddress(cross.address, m.signer, nonce))) {
      throw new RequestError(409, `nonce ${nonce} is already used by this mandate in this cross`, { reason: 'NONCE_USED', nonce });
    }
    const vaultBalance = (await tokenBalance(d.account, m.vault)) ?? 0n;
    const sol = await signerLamports(m.signer);
    const escrow = opt(b.escrow, (v) => u64(v, 'escrow')) ?? undefined;
    const t = now();
    const built = await building(() =>
      buildMandatePlaceOrder({ agent: createNoopSigner(agent), mandate: m, cross, nonce: nonce!, price, quantity, now: t, vaultBalance, ...(escrow !== undefined && { escrow }), ...(salt && { salt }), ...(sol !== undefined && { signerLamports: sol }) }),
    );
    const warnings: string[] = [];
    if (cross.data.gateMint.__option === 'Some') warnings.push('This cross is gated: the mandate\'s signer account needs a gate pass, which only the gate\'s attester can issue. The transaction is built, but the cross will refuse the order without one.');
    if (cross.ext && cross.ext.identity.capQuote > 0n) warnings.push('This cross limits each identity-verified wallet; a mandate\'s signer account has no identity, so the cross may refuse the order.');
    if (sol === undefined) warnings.push('The signer account balance could not be read, so the rent check was not made here.');
    return send(reply, {
      ...(await tx(agent, [built.instruction], 'order')),
      order: built.order,
      nonce,
      escrow: built.escrow,
      commitment: Buffer.from(built.commitment).toString('hex'),
      mandate: m.mandate,
      cross: cross.address,
      remainingAfter: { vault: vaultBalance - built.escrow, totalCap: m.data.totalCap - m.data.committed - built.escrow },
      release,
      warnings,
    });
  });

  async function orderFacts(cross: Awaited<ReturnType<typeof readCross>>, signer: Address, nonce: bigint) {
    const address = await orderAddress(cross.address, signer, nonce);
    const acct = await d.account(address);
    if (!acct || !(ORDER_DISCRIMINATOR as Uint8Array).every((x, i) => acct.data[i] === x)) throw new RequestError(404, `the mandate has no order with nonce ${nonce} in cross ${cross.address}`, { reason: 'NO_SUCH_ORDER' });
    const order = getOrderDecoder().decode(acct.data);
    return { order, facts: { ext: readOrderExt(acct.data), isBuy: order.side === OrderSide.Buy } };
  }
  const isParty = (m: { data: Mandate }, who: Address) => {
    if (who !== m.data.owner && who !== m.data.agent) throw new RequestError(422, `${who} is neither the owner nor the agent of this mandate.`, { reason: 'NOT_OWNER_OR_AGENT' });
  };

  app.post('/v1/tx/mandate-cancel-order', async (req, reply) => {
    const b = obj(req.body);
    only(b, ['caller', 'mandate', 'cross', 'nonce'], 'mandate-cancel-order');
    const caller = addr(b.caller, 'caller');
    const nonce = u64(b.nonce, 'nonce');
    const release = await need('cancel_order', CANCEL_ORDER_DISCRIMINATOR as Uint8Array);
    const m = await readMandate(addr(b.mandate, 'mandate'));
    isParty(m, caller);
    const cross = await readCross(d.account, addr(b.cross, 'cross'));
    const { order, facts } = await orderFacts(cross, m.signer, nonce);
    const ix = await building(() => buildMandateCancel({ caller: createNoopSigner(caller), mandate: m, cross, nonce, revealed: order.state === 1, order: facts }));
    return send(reply, { ...(await tx(caller, [ix], 'cancel')), mandate: m.mandate, cross: cross.address, order: await orderAddress(cross.address, m.signer, nonce), refundTo: m.vault, release });
  });

  app.post('/v1/tx/mandate-reveal-order', async (req, reply) => {
    const b = obj(req.body);
    only(b, ['caller', 'mandate', 'cross', 'nonce', 'price', 'quantity', 'salt'], 'mandate-reveal-order');
    const caller = addr(b.caller, 'caller');
    const nonce = u64(b.nonce, 'nonce');
    const release = await need('reveal_order', REVEAL_ORDER_DISCRIMINATOR as Uint8Array);
    const m = await readMandate(addr(b.mandate, 'mandate'));
    isParty(m, caller);
    const cross = await readCross(d.account, addr(b.cross, 'cross'));
    const { facts } = await orderFacts(cross, m.signer, nonce);
    const ix = await building(() => buildMandateReveal({ caller: createNoopSigner(caller), mandate: m, cross, nonce, price: u64(b.price, 'price'), quantity: u64(b.quantity, 'quantity'), salt: hex32(b.salt, 'salt'), order: facts }));
    return send(reply, { ...(await tx(caller, [ix], 'reveal')), mandate: m.mandate, cross: cross.address, release });
  });

  // ---------------------------------------------------------------- the guard an agent host runs before it signs
  app.post('/v1/mandates/check-transaction', async (req, reply) => {
    const b = obj(req.body);
    only(b, ['transaction'], 'check-transaction');
    if (typeof b.transaction !== 'string' || b.transaction.length === 0 || b.transaction.length > 4_000) throw new RequestError(400, 'transaction must be a base64 transaction');
    const verdict = inspectMandateAgentTransaction(b.transaction);
    return send(reply, { ...verdict, allowed: MANDATE_AGENT_INSTRUCTIONS, note: 'An agent key signs only transactions whose every instruction is a compute-budget instruction or one of cross_mandate\'s place_order, cancel_order and reveal_order. Nothing else can move the mandate\'s funds.' });
  });

  // ---------------------------------------------------------------- reads
  app.get('/v1/mandates/:address', async (req, reply) => {
    const address = addr((req.params as { address: string }).address, 'address');
    const release = await releaseNote(gate, 'crossMandate');
    if (release.deployed === false) throw new RequestError(404, `mandate ${address} not found: ${release.note}`, { reason: 'PROGRAM_NOT_DEPLOYED', release });
    const m = await readMandate(address);
    const t = now();
    const vault = (await tokenBalance(d.account, m.vault)) ?? 0n;
    const sol = await signerLamports(m.signer);
    const expired = t >= m.data.expiresAt;
    const status = m.data.revoked ? 'revoked' : expired ? 'expired' : 'active';
    const blockers: string[] = [];
    if (m.data.revoked) blockers.push('revoked');
    if (expired) blockers.push('expired');
    if (vault === 0n) blockers.push('vault empty');
    if (m.data.committed >= m.data.totalCap) blockers.push('lifetime cap reached');
    if (sol !== undefined && sol < MANDATE_MIN_SIGNER_LAMPORTS) blockers.push('signer account needs SOL for order rent');
    return send(reply, {
      mandate: m.mandate,
      owner: m.data.owner,
      agent: m.data.agent,
      id: m.data.id,
      quoteMint: m.data.quoteMint,
      quoteTokenProgram: m.data.quoteTokenProgram,
      limits: limitsJson(m.data),
      committed: m.data.committed,
      capRemaining: m.data.totalCap > m.data.committed ? m.data.totalCap - m.data.committed : 0n,
      status,
      signer: m.signer,
      vault: m.vault,
      vaultBalance: vault,
      signerLamports: sol ?? null,
      minSignerLamports: MANDATE_MIN_SIGNER_LAMPORTS,
      canPlaceOrder: blockers.length === 0,
      blockers,
      release,
    });
  });

  app.get('/v1/mandates', async (req, reply) => {
    const q = req.query as { owner?: string; agent?: string; limit?: string };
    const owner = q.owner === undefined ? null : addr(q.owner, 'owner');
    const agent = q.agent === undefined ? null : addr(q.agent, 'agent');
    const limit = q.limit === undefined ? 50 : Math.min(200, Math.max(1, Number.parseInt(q.limit, 10) || 50));
    const release = await releaseNote(gate, 'crossMandate');
    const rows = d.db ? (await d.db.query(`SELECT * FROM mandates WHERE ($1::text IS NULL OR owner = $1) AND ($2::text IS NULL OR agent = $2) ORDER BY created_slot DESC LIMIT $3`, [owner, agent, limit])).rows : [];
    const t = Number(now());
    return send(reply, { mandates: rows.map((r) => mandateRow(r, t)), release, ...(release.deployed === false && { note: release.note }) });
  });

  app.get('/v1/owners/:owner/mandates', async (req, reply) => {
    const owner = addr((req.params as { owner: string }).owner, 'owner');
    const release = await releaseNote(gate, 'crossMandate');
    const rows = d.db ? (await d.db.query(`SELECT * FROM mandates WHERE owner = $1 ORDER BY created_slot DESC LIMIT 200`, [owner])).rows : [];
    const t = Number(now());
    return send(reply, { owner, mandates: rows.map((r) => mandateRow(r, t)), release, ...(release.deployed === false && { note: release.note }) });
  });

  app.get('/v1/mandates/:address/activity', async (req, reply) => {
    const address = addr((req.params as { address: string }).address, 'address');
    const release = await releaseNote(gate, 'crossMandate');
    const events = d.db ? (await d.db.query(`SELECT signature, seq, slot, extract(epoch from block_time)::bigint AS block_time, name, payload FROM program_events WHERE program = 'cross_mandate' AND subject = $1 ORDER BY slot DESC, seq DESC LIMIT 200`, [address])).rows : [];
    const orders = d.db ? (await d.db.query(`SELECT order_address, cross_address, escrow, slot FROM mandate_orders WHERE mandate = $1 ORDER BY slot DESC LIMIT 200`, [address])).rows : [];
    return send(reply, { mandate: address, events, orders, release });
  });
}

function mandateRow(r: Record<string, unknown>, now: number) {
  const expiresAt = Number(r.expires_at);
  return {
    mandate: r.address,
    owner: r.owner,
    agent: r.agent,
    quoteMint: r.quote_mint,
    limits: { maxPerOrder: String(r.max_per_order), totalCap: String(r.total_cap), maxShareBps: Number(r.max_share_bps), expiresAt, allow: ((r.allow ?? []) as { kind: number; key: string }[]).map((a) => ({ kind: KIND_NAMES[a.kind], key: a.key })) },
    committed: String(r.committed),
    funded: String(r.funded),
    withdrawn: String(r.withdrawn),
    orders: Number(r.orders),
    status: r.revoked ? 'revoked' : now >= expiresAt ? 'expired' : 'active',
    createdSlot: String(r.created_slot),
  };
}
