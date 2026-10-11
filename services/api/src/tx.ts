// Unsigned transactions for every user action. The API never holds a key: it compiles the
// message with the user as fee payer, leaves every signature slot empty and returns the wire
// bytes; the wallet signs and sends. Sealed-bid salts come from the client and are never stored.
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
  OrderSide,
  buildCancel,
  buildClaim,
  buildCreateCross,
  buildFinalize,
  buildPlaceOrder,
  buildReveal,
  buildSettleBook,
  getOrderDecoder,
  orderAddress,
} from '@opening-cross/sdk';
import { AuthorityType, getSetAuthorityInstruction } from '@solana-program/token-2022';

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

/** Thrown for a request that cannot produce a valid transaction; becomes HTTP 400/409. */
export class RequestError extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string) {
    super(message);
  }
}

type Fetch = (a: Address) => Promise<Uint8Array | null>;

async function orderOf(fetch: Fetch, cross: Address, owner: Address, nonce: bigint) {
  const a = await orderAddress(cross, owner, nonce);
  const d = await fetch(a);
  if (!d) throw new RequestError(404, `no open order for owner ${owner} with nonce ${nonce} in cross ${cross}`);
  return getOrderDecoder().decode(d);
}

export async function placeOrderTx(fetch: Fetch, cross: CrossView, b: { owner: Address; nonce: bigint; side: OrderSide; price: bigint; quantity: bigint; escrow?: bigint; salt?: Uint8Array }, lt: Lifetime) {
  if (cross.data.disclosure === Disclosure.Sealed && !b.salt) throw new RequestError(400, 'sealed cross: provide a 32-byte hex salt and keep it for the reveal');
  if (await fetch(await orderAddress(cross.address, b.owner, b.nonce))) throw new RequestError(409, `nonce ${b.nonce} is already used by this owner in this cross`);
  const ix = await buildPlaceOrder({ cross, owner: createNoopSigner(b.owner), nonce: b.nonce, side: b.side, price: b.price, quantity: b.quantity, ...(b.escrow !== undefined && { escrow: b.escrow }), ...(b.salt && { salt: b.salt }) });
  return { ...compile(b.owner, [ix], lt), order: await orderAddress(cross.address, b.owner, b.nonce) };
}

export async function cancelTx(fetch: Fetch, cross: CrossView, b: { owner: Address; nonce: bigint }, lt: Lifetime) {
  const o = await orderOf(fetch, cross.address, b.owner, b.nonce);
  const revealed = o.state === 1;
  return compile(b.owner, [await buildCancel(cross, createNoopSigner(b.owner), b.nonce, o.side, revealed)], lt);
}

export async function revealTx(fetch: Fetch, cross: CrossView, b: { owner: Address; nonce: bigint; price: bigint; quantity: bigint; salt: Uint8Array }, lt: Lifetime) {
  const o = await orderOf(fetch, cross.address, b.owner, b.nonce);
  return compile(b.owner, [await buildReveal(cross, createNoopSigner(b.owner), b.nonce, b.price, b.quantity, b.salt)], lt);
}

/** Merges and the clear, one transaction each (shards are large). Anyone may send them. */
export async function settleTxs(cross: CrossView, payer: Address, lt: Lifetime, oraclePrice?: Address) {
  const ixs = await buildSettleBook(cross, oraclePrice ? { oraclePrice } : {}).catch((e: Error) => {
    throw new RequestError(400, e.message);
  });
  return ixs.map((ix) => compile(payer, [ix], lt));
}

export async function claimTx(fetch: Fetch, cross: CrossView, b: { payer: Address; owner: Address; nonce: bigint }, lt: Lifetime) {
  await orderOf(fetch, cross.address, b.owner, b.nonce);
  return compile(b.payer, await buildClaim(cross, createNoopSigner(b.payer), b.owner, b.nonce), lt);
}

export async function finalizeTx(cross: CrossView, payer: Address, lt: Lifetime) {
  return compile(payer, [await buildFinalize(cross, createNoopSigner(payer))], lt);
}

export async function createCrossTxs(input: Omit<Parameters<typeof buildCreateCross>[0], 'creator'> & { creator: Address }, lt: Lifetime) {
  const { cross, create, shards } = await buildCreateCross({ ...input, creator: createNoopSigner(input.creator) });
  // A minting cross must own its base mint's mint authority. Hand it over in the same transaction
  // as the create, signed by the issuer who holds it now, so the issuer signs once.
  const handover: Instruction[] =
    Number(input.supplyMode) === 1 && input.baseMint
      ? [getSetAuthorityInstruction({ owned: input.baseMint, owner: createNoopSigner(input.creator), authorityType: AuthorityType.MintTokens, newAuthority: cross }, { programAddress: input.baseTokenProgram })]
      : [];
  return { cross, transactions: [compile(input.creator, [...handover, create], lt), ...shards.map((s) => compile(input.creator, [s], lt))] };
}

export { OrderSide };
