// Seeds a local validator for the web app's end-to-end run: protocol, quote mint, two live crosses
// (an open-book launch and a sealed-bid launch, both minting from an issuer supply schedule) and
// disposable funded test wallets. Writes everything the browser test needs to OUT (outside the
// repository: it contains throwaway secret keys for localnet only).
//
//   RPC_URL=http://127.0.0.1:8899 WS_URL=ws://127.0.0.1:8900 CALL_SECS=150 REVEAL_SECS=90 OUT=/tmp/oc-e2e.json tsx src/seed.ts
import { writeFileSync } from 'node:fs';
import {
  type Address,
  type Instruction,
  type KeyPairSigner,
  airdropFactory,
  appendTransactionMessageInstructions,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  generateKeyPairSigner,
  lamports,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from '@solana/kit';
import { getCreateAccountInstruction } from '@solana-program/system';
import {
  AuthorityType,
  TOKEN_2022_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getInitializeMint2Instruction,
  getMintSize,
  getMintToInstruction,
  getSetAuthorityInstruction,
} from '@solana-program/token-2022';
import { CrossKind, Disclosure, SupplyMode, buildCreateCross, crossAddress, getInitProtocolInstruction, protocolAddress } from '@opening-cross/sdk';

const RPC_URL = process.env.RPC_URL ?? 'http://127.0.0.1:8899';
const rpc = createSolanaRpc(RPC_URL);
const subs = createSolanaRpcSubscriptions(process.env.WS_URL ?? 'ws://127.0.0.1:8900');
const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions: subs });
const airdrop = airdropFactory({ rpc, rpcSubscriptions: subs });
const CALL = BigInt(process.env.CALL_SECS ?? 150);
const REVEAL = BigInt(process.env.REVEAL_SECS ?? 90);

async function send(ixs: Instruction[], payer: KeyPairSigner) {
  const { value: bh } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
  const tx = await signTransactionMessageWithSigners(pipe(createTransactionMessage({ version: 0 }), (m) => setTransactionMessageFeePayerSigner(payer, m), (m) => setTransactionMessageLifetimeUsingBlockhash(bh, m), (m) => appendTransactionMessageInstructions(ixs, m)));
  await sendAndConfirm(tx as Parameters<typeof sendAndConfirm>[0], { commitment: 'confirmed' });
}
async function wallet(sol = 20n) {
  const w = await generateKeyPairSigner(true);
  await airdrop({ recipientAddress: w.address, lamports: lamports(sol * 1_000_000_000n), commitment: 'confirmed' });
  return w;
}
async function mint(authority: KeyPairSigner, decimals: number): Promise<Address> {
  const m = await generateKeyPairSigner();
  const space = getMintSize();
  const rent = await rpc.getMinimumBalanceForRentExemption(BigInt(space)).send();
  await send([getCreateAccountInstruction({ payer: authority, newAccount: m, lamports: rent, space, programAddress: TOKEN_2022_PROGRAM_ADDRESS }), getInitializeMint2Instruction({ mint: m.address, decimals, mintAuthority: authority.address, freezeAuthority: null })], authority);
  return m.address;
}
async function fund(m: Address, authority: KeyPairSigner, owner: Address, amount: bigint) {
  const [ata] = await findAssociatedTokenPda({ owner, mint: m, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS });
  const ixs: Instruction[] = [getCreateAssociatedTokenIdempotentInstruction({ payer: authority, ata, owner, mint: m, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS })];
  if (amount > 0n) ixs.push(getMintToInstruction({ mint: m, token: ata, mintAuthority: authority, amount }, { programAddress: TOKEN_2022_PROGRAM_ADDRESS }));
  await send(ixs, authority);
}
const secret = async (k: KeyPairSigner) => Array.from(new Uint8Array([...new Uint8Array(await crypto.subtle.exportKey('pkcs8', k.keyPair.privateKey)).slice(16), ...new Uint8Array(await crypto.subtle.exportKey('raw', k.keyPair.publicKey))]));

const admin = await wallet();
const issuer = await wallet();
await send([getInitProtocolInstruction({ admin, protocol: await protocolAddress(), guardian: admin.address, feeRecipient: admin.address, feeBps: [30, 5, 15, 30] })], admin);
const quote = await mint(admin, 6);
for (const w of [admin, issuer]) await fund(quote, admin, w.address, w === issuer ? 1_000_000_000n : 0n);

const now = BigInt((await rpc.getBlockTime(await rpc.getSlot().send()).send()) ?? Math.floor(Date.now() / 1000));
const crosses: Record<string, string> = {};
for (const [id, disclosure] of [[1n, Disclosure.Open], [2n, Disclosure.Sealed]] as const) {
  const base = await mint(admin, 6);
  const cross = await crossAddress(issuer.address, id);
  for (const w of [admin, issuer]) await fund(base, admin, w.address, 0n);
  await send([getSetAuthorityInstruction({ owned: base, owner: admin, authorityType: AuthorityType.MintTokens, newAuthority: cross }, { programAddress: TOKEN_2022_PROGRAM_ADDRESS })], admin);
  const close = now + CALL;
  const built = await buildCreateCross({
    creator: issuer, baseMint: base, quoteMint: quote, baseTokenProgram: TOKEN_2022_PROGRAM_ADDRESS, quoteTokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    crossId: id, kind: CrossKind.Launch, supplyMode: SupplyMode.Mint, disclosure,
    minPrice: 1_000_000n, tick: 50_000n, ticks: 40, priceScale: 1_000_000n, openTs: now, closeTs: close, revealEndTs: disclosure === Disclosure.Sealed ? close + REVEAL : close,
    referencePrice: null, minMatched: 0n, maxImbalanceBps: null, integratorFeeBps: 20, integrator: admin.address, gateMint: null,
    shards: 2, maxOrders: 64, proceedsTo: issuer.address,
    // The issuer offers 1,000 tokens at 1.20 and 1,000 more at 1.50.
    schedule: [{ price: 1_200_000n, quantity: 1_000_000_000n }, { price: 1_500_000n, quantity: 1_000_000_000n }],
    oracle: null, calendar: null, settler: null, settleDeadlineTs: 0n,
  });
  await send([built.create], issuer);
  for (const s of built.shards) await send([s], issuer);
  crosses[disclosure === Disclosure.Open ? 'open' : 'sealed'] = built.cross;
}

const buyer = await wallet();
const buyer2 = await wallet();
// A second issuer for the console test: holds the mint authority of a fresh token and some quote.
const issuer2 = await wallet();
const issuerBase = await mint(issuer2, 6);
await fund(quote, admin, issuer2.address, 1_000_000_000n);
for (const b of [buyer, buyer2]) await fund(quote, admin, b.address, 5_000_000_000n);

const out = { rpc: RPC_URL, quoteMint: quote, crosses, now: now.toString(), closeTs: (now + CALL).toString(), revealEndTs: (now + CALL + REVEAL).toString(), wallets: { buyer: { address: buyer.address, secret: await secret(buyer) }, buyer2: { address: buyer2.address, secret: await secret(buyer2) }, issuer: { address: issuer2.address, secret: await secret(issuer2) } }, issuerBaseMint: issuerBase };
writeFileSync(process.env.OUT ?? '/tmp/oc-e2e.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify({ ...out, wallets: { buyer: buyer.address, buyer2: buyer2.address, issuer: issuer2.address } }, null, 2));
process.exit(0);
