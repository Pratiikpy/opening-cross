// Unsigned transactions for every user action. The API never holds a key: it compiles the
// message with the user as fee payer, leaves every signature slot empty and returns the wire
// bytes; the wallet signs and sends. Sealed-bid salts come from the client and are never stored.
//
// A cross created by the extended program carries a rules tail (ADR-0450). Every builder below reads it from the cross's account
// and adds the accounts the rules call for; a cross without a tail is built exactly as before.
import {
  type Address,
  type Blockhash,
  type Instruction,
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';
import {
  type CrossView,
  Disclosure,
  type OrderFacts,
  OrderSide,
  type RuledCreation,
  TRANSACTION_LIMIT_BYTES,
  buildCancel,
  buildClaim,
  buildCreateCross,
  buildCreateRuledCross,
  buildFinalizeWithAccounts,
  buildMissingRuledAccounts,
  buildMissingShards,
  buildPlaceOrder,
  buildReveal,
  buildSettleBook,
  getOrderDecoder,
  orderAddress,
  pythFeedAccount,
  readCrossExt,
  readOrderExt,
  wireSize,
} from '@opening-cross/sdk';
import { AuthorityType, getSetAuthorityInstruction } from '@solana-program/token-2022';
import { currentChain, currentNow } from './chain-context.js';

export type Lifetime = { blockhash: Blockhash; lastValidBlockHeight: bigint };
export type UnsignedTx = { transaction: string; signers: Address[] };

export function compile(feePayer: Address, ixs: Instruction[], lifetime: Lifetime): UnsignedTx {
  const tx = compileTransaction(
    pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(createNoopSigner(feePayer), m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
      (m) => appendTransactionMessageInstructions(ixs, m),
    ),
  );
  return { transaction: getBase64EncodedWireTransaction(tx), signers: Object.keys(tx.signatures) as Address[] };
}

/** Thrown for a request that cannot produce a valid transaction; becomes HTTP 400/404/409/422. `detail` is merged into the JSON body (typed reasons). */
export class RequestError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 422, message: string, readonly detail?: Record<string, unknown>) {
    super(message);
  }
}

type Fetch = (a: Address) => Promise<Uint8Array | null>;

async function orderOf(fetch: Fetch, cross: Address, owner: Address, nonce: bigint) {
  const a = await orderAddress(cross, owner, nonce);
  const d = await fetch(a);
  if (!d) throw new RequestError(404, `no open order for owner ${owner} with nonce ${nonce} in cross ${cross}`);
  const order = getOrderDecoder().decode(d);
  return { order, facts: { ext: readOrderExt(d), isBuy: order.side === OrderSide.Buy } satisfies OrderFacts };
}

/** The cross with its rules tail, read from its account (`fetch` answers only for accounts cross_core owns). A cross without a tail comes back unchanged. */
async function withRules(fetch: Fetch, cross: CrossView): Promise<CrossView> {
  const raw = await fetch(cross.address);
  return raw ? { ...cross, ext: readCrossExt(raw) } : cross;
}

/** The same for callers that have no `fetch`: the chain reader of the request (see chain-context.ts), or the cross as given. */
async function withRulesFromContext(cross: CrossView): Promise<CrossView> {
  const read = currentChain();
  if (!read) return cross;
  const acct = await read(cross.address);
  return acct ? { ...cross, ext: readCrossExt(acct.data) } : cross;
}

export async function placeOrderTx(
  fetch: Fetch,
  cross0: CrossView,
  b: { owner: Address; nonce: bigint; side: OrderSide; price: bigint; quantity: bigint; escrow?: bigint; salt?: Uint8Array; class?: number; lockSecs?: number; now?: bigint },
  lt: Lifetime,
) {
  const cross = await withRules(fetch, cross0);
  if (cross.data.disclosure === Disclosure.Sealed && !b.salt) throw new RequestError(400, 'sealed cross: provide a 32-byte hex salt and keep it for the reveal');
  if (await fetch(await orderAddress(cross.address, b.owner, b.nonce))) throw new RequestError(409, `nonce ${b.nonce} is already used by this owner in this cross`);
  if (!cross.ext && ((b.class ?? 0) !== 0 || (b.lockSecs ?? 0) !== 0)) throw new RequestError(422, 'this cross has no rules, so it takes no allocation class and no lockup', { reason: 'NO_RULES' });
  const ix = await buildPlaceOrder({
    cross,
    owner: createNoopSigner(b.owner),
    nonce: b.nonce,
    side: b.side,
    price: b.price,
    quantity: b.quantity,
    ...(b.escrow !== undefined && { escrow: b.escrow }),
    ...(b.salt && { salt: b.salt }),
    ...(b.class !== undefined && { class: b.class }),
    ...(b.lockSecs !== undefined && { lockSecs: b.lockSecs }),
    ...(b.now !== undefined && { now: b.now }),
  }).catch((e: Error) => {
    throw new RequestError(400, e.message);
  });
  return { ...compile(b.owner, [ix], lt), order: await orderAddress(cross.address, b.owner, b.nonce) };
}

export async function cancelTx(fetch: Fetch, cross0: CrossView, b: { owner: Address; nonce: bigint }, lt: Lifetime) {
  const cross = await withRules(fetch, cross0);
  const { order: o, facts } = await orderOf(fetch, cross.address, b.owner, b.nonce);
  const revealed = o.state === 1;
  return compile(b.owner, [await buildCancel(cross, createNoopSigner(b.owner), b.nonce, o.side, revealed, facts)], lt);
}

export async function revealTx(fetch: Fetch, cross0: CrossView, b: { owner: Address; nonce: bigint; price: bigint; quantity: bigint; salt: Uint8Array }, lt: Lifetime) {
  const cross = await withRules(fetch, cross0);
  const { facts } = await orderOf(fetch, cross.address, b.owner, b.nonce);
  return compile(b.owner, [await buildReveal(cross, createNoopSigner(b.owner), b.nonce, b.price, b.quantity, b.salt, facts)], lt);
}

/** Merges and the clear, one transaction each (shards are large). Anyone may send them. A cross with rules also merges its ending buckets
 *  and reads the accounts its rules name; the extra oracle feeds default to the push-oracle account of each feed id (shard 0). A cross
 *  that still owes a draw is refused with a 400 that says so. */
export async function settleTxs(cross0: CrossView, payer: Address, lt: Lifetime, oraclePrice?: Address, opts: { oracleAccounts?: readonly Address[]; now?: bigint } = {}) {
  const cross = await withRulesFromContext(cross0);
  const x = cross.ext ?? null;
  const oracleAccounts = opts.oracleAccounts ?? (x && x.oracleSet.extraCount > 0 ? await Promise.all(x.oracleSet.extraFeeds.slice(0, x.oracleSet.extraCount).map((f) => pythFeedAccount(Buffer.from(f).toString('hex')))) : undefined);
  const ixs = await buildSettleBook(cross, { ...(oraclePrice ? { oraclePrice } : {}), ...(oracleAccounts ? { oracleAccounts } : {}), ...(opts.now !== undefined ? { now: opts.now } : currentNow() !== null ? { now: currentNow()! } : {}) }).catch((e: Error) => {
    throw new RequestError(400, e.message, /^DrawRequired/.test(e.message) ? { reason: 'DRAW_REQUIRED' } : undefined);
  });
  return ixs.map((ix) => compile(payer, [ix], lt));
}

export async function claimTx(fetch: Fetch, cross0: CrossView, b: { payer: Address; owner: Address; nonce: bigint }, lt: Lifetime) {
  const cross = await withRules(fetch, cross0);
  const { facts } = await orderOf(fetch, cross.address, b.owner, b.nonce);
  return compile(b.payer, await buildClaim(cross, createNoopSigner(b.payer), b.owner, b.nonce, facts), lt);
}

export async function finalizeTx(cross0: CrossView, payer: Address, lt: Lifetime) {
  const cross = await withRulesFromContext(cross0);
  return compile(payer, await buildFinalizeWithAccounts(cross, createNoopSigner(payer)), lt);
}

/** The account transactions a create left undone, one each (shards are large): the main shards and, for a cross with rules, its ending
 *  buckets, class book and lock vault. Anyone may pay for them. */
export async function initShardsTxs(fetch: Fetch, cross0: CrossView, payer: Address, lt: Lifetime) {
  const cross = await withRules(fetch, cross0);
  const exists = async (a: Address) => (await fetch(a)) !== null;
  const signer = createNoopSigner(payer);
  const ixs = [...(await buildMissingShards(cross, signer, exists)), ...(await buildMissingRuledAccounts({ ...cross, ext: cross.ext ?? null }, signer, exists))];
  if (ixs.length === 0) throw new RequestError(409, 'every shard of this cross already exists');
  return { transactions: ixs.map((ix) => compile(payer, [ix], lt)) };
}

export async function createCrossTxs(input: Omit<Parameters<typeof buildCreateCross>[0], 'creator'> & { creator: Address }, lt: Lifetime) {
  const { cross, create, shards, ensureCreatorQuote } = await buildCreateCross({ ...input, creator: createNoopSigner(input.creator) });
  // A minting cross must own its base mint's mint authority. Hand it over in the same transaction
  // as the create, signed by the issuer who holds it now, so the issuer signs once.
  const handover: Instruction[] =
    Number(input.supplyMode) === 1 && input.baseMint
      ? [getSetAuthorityInstruction({ owned: input.baseMint, owner: createNoopSigner(input.creator), authorityType: AuthorityType.MintTokens, newAuthority: cross }, { programAddress: input.baseTokenProgram })]
      : [];
  return { cross, transactions: [compile(input.creator, [ensureCreatorQuote, ...handover, create], lt), ...shards.map((s) => compile(input.creator, [s], lt))] };
}

/** The transactions that create a cross with rules, in the order to send them (each after the one before has landed):
 *  1. the creation and `set_rules` in ONE transaction (the rules are only accepted in the slot the cross is created in), preceded in the
 *     same transaction by the creator's quote account and the mint-authority handover when they fit, otherwise in a transaction of their own;
 *  2. one transaction per main shard, per ending-bucket or extension shard, then the class book and the lock vault the rules call for. */
export async function createRuledCrossTxs(input: Omit<Parameters<typeof buildCreateRuledCross>[0], 'creator'> & { creator: Address }, lt: Lifetime) {
  const creator = createNoopSigner(input.creator);
  const built: RuledCreation = await buildCreateRuledCross({ ...input, creator });
  const handover: Instruction[] =
    Number(input.supplyMode) === 1 && input.baseMint
      ? [getSetAuthorityInstruction({ owned: input.baseMint, owner: creator, authorityType: AuthorityType.MintTokens, newAuthority: built.cross }, { programAddress: input.baseTokenProgram })]
      : [];
  const prefix = [built.ensureCreatorQuote, ...handover];
  const together = [...prefix, ...built.atomic];
  const sizes = { createAndRules: wireSize(input.creator, built.atomic), withPrefix: wireSize(input.creator, together) };
  if (sizes.createAndRules > TRANSACTION_LIMIT_BYTES) {
    throw new RequestError(
      422,
      `The creation and the rules are ${sizes.createAndRules} bytes, over the ${TRANSACTION_LIMIT_BYTES} a transaction holds, and the rules cannot be sent in a later transaction (they are only accepted in the slot the cross is created in). Name fewer insiders or extra oracle feeds.`,
      { reason: 'TX_TOO_LARGE', bytes: sizes.createAndRules, limit: TRANSACTION_LIMIT_BYTES },
    );
  }
  const first = sizes.withPrefix <= TRANSACTION_LIMIT_BYTES ? [compile(input.creator, together, lt)] : [compile(input.creator, prefix, lt), compile(input.creator, built.atomic, lt)];
  const rest = [...built.shards, ...built.auxShards, ...(built.classBook ? [built.classBook] : []), ...(built.lockVault ? [built.lockVault] : [])];
  return { cross: built.cross, transactions: [...first, ...rest.map((ix) => compile(input.creator, [ix], lt))], sizes: { ...sizes, firstTransactions: first.length } };
}

export { OrderSide };
