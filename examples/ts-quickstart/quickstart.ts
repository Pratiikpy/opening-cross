// Opening Cross quickstart: one complete sealed-bid cross, written the way an integrator would,
// against the published packages only. It runs on LiteSVM with the program binary from a
// release (CROSS_CORE_SO), so it needs no validator, no RPC and no funds.
//
//   CROSS_CORE_SO=path/to/cross_core.so npm start
import { randomBytes } from 'node:crypto';
import { Clock, FailedTransactionMetadata, LiteSVM } from 'litesvm';
import {
  type Address,
  type Instruction,
  type KeyPairSigner,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  generateKeyPairSigner,
  lamports,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from '@solana/kit';
import { getCreateAccountInstruction } from '@solana-program/system';
import {
  TOKEN_2022_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getInitializeMint2Instruction,
  getMintSize,
  getMintToInstruction,
  getTokenDecoder,
} from '@solana-program/token-2022';
import {
  CROSS_CORE_PROGRAM_ADDRESS,
  CrossKind,
  CrossState,
  Disclosure,
  OrderSide,
  SupplyMode,
  buildClaim,
  buildCreateCross,
  buildFinalize,
  buildPlaceOrder,
  buildReveal,
  buildSettleBook,
  getCrossDecoder,
  getInitProtocolInstruction,
  getOrderDecoder,
  orderAddress,
  protocolAddress,
} from '@opening-cross/sdk';
import { verifyCross } from '@opening-cross/verifier';

const so = process.env.CROSS_CORE_SO;
if (!so) throw new Error('set CROSS_CORE_SO to the cross_core program binary');

const svm = new LiteSVM();
svm.addProgramFromFile(CROSS_CORE_PROGRAM_ADDRESS, so);
const setTime = (unix: bigint) => {
  const c = svm.getClock();
  svm.setClock(new Clock(c.slot + 1n, c.epochStartTimestamp, c.epoch, c.leaderScheduleEpoch, unix));
};
async function send(ixs: Instruction[], payer: KeyPairSigner): Promise<void> {
  svm.expireBlockhash();
  const tx = await signTransactionMessageWithSigners(
    pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(payer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: svm.latestBlockhash() as never, lastValidBlockHeight: 1_000_000n }, m),
      (m) => appendTransactionMessageInstructions(ixs, m),
    ),
  );
  const res = svm.sendTransaction(tx as Parameters<LiteSVM['sendTransaction']>[0]);
  if (res instanceof FailedTransactionMetadata) throw new Error(`${res.toString()}\n${res.meta().logs().join('\n')}`);
}
async function wallet(): Promise<KeyPairSigner> {
  const w = await generateKeyPairSigner();
  svm.airdrop(w.address, lamports(10_000_000_000n));
  return w;
}
const ata = async (owner: Address, mint: Address) => (await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS }))[0];
async function newMint(authority: KeyPairSigner): Promise<Address> {
  const mint = await generateKeyPairSigner();
  const space = getMintSize();
  await send(
    [
      getCreateAccountInstruction({ payer: authority, newAccount: mint, lamports: svm.minimumBalanceForRentExemption(BigInt(space)), space, programAddress: TOKEN_2022_PROGRAM_ADDRESS }),
      getInitializeMint2Instruction({ mint: mint.address, decimals: 6, mintAuthority: authority.address, freezeAuthority: null }),
    ],
    authority,
  );
  return mint.address;
}
async function fund(mint: Address, authority: KeyPairSigner, owner: Address, amount: bigint): Promise<void> {
  const a = await ata(owner, mint);
  const ixs: Instruction[] = [getCreateAssociatedTokenIdempotentInstruction({ payer: authority, ata: a, owner, mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS })];
  if (amount > 0n) ixs.push(getMintToInstruction({ mint, token: a, mintAuthority: authority, amount }, { programAddress: TOKEN_2022_PROGRAM_ADDRESS }));
  await send(ixs, authority);
}
async function balance(owner: Address, mint: Address): Promise<bigint> {
  const x = svm.getAccount(await ata(owner, mint));
  return x.exists ? getTokenDecoder().decode(x.data).amount : 0n;
}
function view(address: Address) {
  const a = svm.getAccount(address);
  if (!a.exists) throw new Error(`account ${address} missing`);
  return { address, data: getCrossDecoder().decode(a.data) };
}

// 1. Protocol, mints and participants.
const T0 = 1_800_000_000n;
setTime(T0);
const admin = await wallet();
const issuer = await wallet();
await send([getInitProtocolInstruction({ admin, protocol: await protocolAddress(), guardian: admin.address, feeRecipient: admin.address, feeBps: [30, 5, 15, 30] })], admin);
const quote = await newMint(admin);
const base = await newMint(admin);
for (const who of [admin, issuer]) for (const m of [quote, base]) await fund(m, admin, who.address, 0n);
await fund(base, admin, issuer.address, 5_000_000_000n);
// Creating a cross posts a small quote-token dust bond that covers settlement rounding (ADR-0003).
await fund(quote, admin, issuer.address, 10_000_000n);

// 2. The issuer opens a sealed launch selling 5 tokens, priced in quote atoms per whole token.
const { cross, create, shards } = await buildCreateCross({
  creator: issuer,
  baseMint: base,
  quoteMint: quote,
  baseTokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
  quoteTokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
  crossId: 1n,
  kind: CrossKind.Launch,
  supplyMode: SupplyMode.Escrow,
  disclosure: Disclosure.Sealed,
  minPrice: 1_000_000n,
  tick: 100_000n,
  ticks: 20,
  priceScale: 1_000_000n,
  openTs: T0,
  closeTs: T0 + 100n,
  revealEndTs: T0 + 200n,
  referencePrice: null,
  minMatched: 0n,
  maxImbalanceBps: null,
  integratorFeeBps: 0,
  integrator: admin.address,
  gateMint: null,
  shards: 2,
  maxOrders: 64,
  proceedsTo: issuer.address,
  schedule: [],
  oracle: null,
  calendar: null,
  settler: null,
  settleDeadlineTs: 0n,
});
await send([create], issuer);
for (const s of shards) await send([s], issuer);

// 3. The issuer offers the supply and bidders commit sealed bids; no price is visible until reveal.
const bidders = [await wallet(), await wallet(), await wallet()];
for (const b of bidders) await fund(quote, admin, b.address, 10_000_000_000n);
const orders = [
  { owner: issuer, nonce: 0n, side: OrderSide.Sell, price: 1_000_000n, quantity: 5_000_000_000n, salt: randomBytes(32) },
  ...[1_500_000n, 1_300_000n, 1_200_000n].map((price, i) => ({ owner: bidders[i]!, nonce: 0n, side: OrderSide.Buy, price, quantity: 2_000_000_000n, salt: randomBytes(32) })),
];
for (const o of orders) await send([await buildPlaceOrder({ cross: view(cross), ...o })], o.owner);

// 4. After the call period everyone reveals; after the reveal window anyone settles.
setTime(T0 + 101n);
for (const o of orders) {
  const acct = svm.getAccount(await orderAddress(cross, o.owner.address, o.nonce));
  if (!acct.exists) throw new Error('order missing');
  const { index } = getOrderDecoder().decode(acct.data);
  await send([await buildReveal(view(cross), o.owner, o.nonce, index, o.price, o.quantity, o.salt)], o.owner);
}
setTime(T0 + 201n);
for (const ix of await buildSettleBook(view(cross))) await send([ix], admin);
const cleared = view(cross).data;
if (cleared.state !== CrossState.Cleared || cleared.clearing.__option !== 'Some') throw new Error('the cross did not print');
console.log(`cleared at ${cleared.clearing.value.price} quote atoms per token for ${cleared.clearing.value.matched} base atoms`);

// 5. Claims (anyone may crank them; funds always go to each owner), then finalize.
for (const o of orders) await send(await buildClaim(view(cross), admin, o.owner.address, o.nonce), admin);
await send([await buildFinalize(view(cross), admin)], admin);
for (const [i, b] of bidders.entries()) console.log(`bidder at ${orders[i + 1]!.price}: ${await balance(b.address, base)} base atoms, ${await balance(b.address, quote)} quote atoms`);

// 6. Anyone can re-check the result from chain data alone.
const proof = await verifyCross(async (a) => {
  const x = svm.getAccount(a);
  return x.exists ? x.data : null;
}, cross);
console.log(`fairness proof: verified=${proof.verified} state=${proof.state} price=${proof.recomputed.price}`);
if (!proof.verified || view(cross).data.state !== CrossState.Finalized) process.exit(1);
