// A real subscription on devnet. A throwaway issuer wallet (funded from the ops key) buys the starter plan with a test USDC the ops key
// can mint: the billing service builds the unsigned payment, the issuer signs and sends it, the service reads the payment back from the
// chain and records it, and the period it bought, the entitlement and a signed invoice are shown.
//
//   DATABASE_URL=postgres://... OPS_KEYPAIR=<mint authority of BILLING_MINT> tsx scripts/devnet-run.ts
import { readFileSync } from 'node:fs';
import Fastify from 'fastify';
import pg from 'pg';
import {
  type Instruction,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  lamports,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  signature as toSignature,
  address,
  partiallySignTransaction,
} from '@solana/kit';
import { getTransferSolInstruction } from '@solana-program/system';
import { findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstruction, getMintToInstruction, TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import { keyPairFromSolanaFile, verifyDocument } from '@opening-cross/attest';
import { migrate } from '@opening-cross/indexer';
import { jsonRpcChain } from '../src/rpc.js';
import { registerBilling } from '../src/routes.js';

const URLS = (process.env.RPC_URL ?? 'https://api.devnet.solana.com,https://solana-devnet.api.onfinality.io/public').split(',');
const MINT = address(process.env.BILLING_MINT ?? '3p4zaqbp7EgV1pc1wf9aw7YseY5UrvibpmpX7n7AFXZE');
const rpc = createSolanaRpc(URLS[0]!);
const ops = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(process.env.OPS_KEYPAIR ?? '', 'utf8')) as number[]));
const issuer = await generateKeyPairSigner();
const revenue = await generateKeyPairSigner();
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
await migrate(db);
await db.query('DELETE FROM billing_payments');
await db.query('DELETE FROM billing_invoices');

async function sendAndConfirm(ixs: Instruction[], payer: typeof ops) {
  const { value: bh } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
  const tx = await signTransactionMessageWithSigners(pipe(createTransactionMessage({ version: 0 }), (m) => setTransactionMessageFeePayerSigner(payer, m), (m) => setTransactionMessageLifetimeUsingBlockhash(bh, m), (m) => appendTransactionMessageInstructions(ixs, m)));
  await rpc.sendTransaction(getBase64EncodedWireTransaction(tx), { encoding: 'base64', preflightCommitment: 'confirmed' }).send();
  await confirm(getSignatureFromTransaction(tx));
  return getSignatureFromTransaction(tx);
}
async function confirm(sig: string) {
  for (let i = 0; i < 90; i++) {
    const st = (await rpc.getSignatureStatuses([toSignature(sig)]).send()).value[0];
    if (st?.err) throw new Error(`${sig} failed: ${JSON.stringify(st.err, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}`);
    if (st?.confirmationStatus === 'confirmed' || st?.confirmationStatus === 'finalized') return;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`${sig} not confirmed in 90 s`);
}

// Fund the issuer with SOL for fees and mint it the test USDC the starter plan costs, from the ops key (the mint authority).
const [issuerAta] = await findAssociatedTokenPda({ owner: issuer.address, mint: MINT, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS });
await sendAndConfirm(
  [
    getTransferSolInstruction({ source: ops, destination: issuer.address, amount: lamports(20_000_000n) }),
    getCreateAssociatedTokenIdempotentInstruction({ payer: ops, ata: issuerAta, owner: issuer.address, mint: MINT, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS }),
    getMintToInstruction({ mint: MINT, token: issuerAta, mintAuthority: ops, amount: 120_000_000n }),
  ],
  ops,
);
console.log(JSON.stringify({ step: 'issuer funded', issuer: issuer.address, revenueWallet: revenue.address, mint: MINT }));

const signerFile = await keyPairFromSolanaFile(readFileSync(process.env.OPS_KEYPAIR!, 'utf8'));
const app = Fastify();
let clock = Math.floor(Date.now() / 1000);
registerBilling(app, { db }, { mint: MINT, revenueWallet: revenue.address, chain: jsonRpcChain(URLS), signer: signerFile, clock: () => clock });
await app.ready();
const call = async (method: 'GET' | 'POST', url: string, payload?: unknown) => {
  const r = await app.inject({ method, url, ...(payload === undefined ? {} : { payload: payload as never }) });
  return { status: r.statusCode, body: r.json() };
};

const offer = await call('POST', '/v1/billing/subscribe', { plan: 'recurring-starter', issuer: issuer.address });
console.log(JSON.stringify({ step: 'offer', status: offer.status, price: offer.body.price, memo: offer.body.memo, from: offer.body.from, to: offer.body.to }));

// The issuer signs the transaction the service built, exactly as it was built.
const unsigned = getTransactionDecoder().decode(getBase64Encoder().encode(offer.body.transaction));
const signed = await partiallySignTransaction([issuer.keyPair], unsigned);
await rpc.sendTransaction(getBase64EncodedWireTransaction(signed), { encoding: 'base64', preflightCommitment: 'confirmed' }).send();
const sig = getSignatureFromTransaction(signed);
await confirm(sig);
console.log(JSON.stringify({ step: 'payment sent and confirmed', signature: sig }));

const rec = await call('POST', '/v1/billing/payments', { signature: sig });
console.log(JSON.stringify({ step: 'payment reported', status: rec.status, buys: rec.body.buys, payment: rec.body.payment, entitled: rec.body.entitlement?.entitled, current: rec.body.entitlement?.current }));
const again = await call('POST', '/v1/billing/payments', { signature: sig });
console.log(JSON.stringify({ step: 'reported again', status: again.status, fresh: again.body.fresh, periods: again.body.entitlement?.periods?.length }));
console.log(JSON.stringify({ step: 'entitlement', ...(await call('GET', `/v1/billing/entitlements/${issuer.address}`)).body }, (_k, v) => v, 1));
const inv = await call('POST', '/v1/billing/invoices', { issuer: issuer.address });
console.log(JSON.stringify({ step: 'invoice', status: inv.status, kept: inv.body.kept, signer: inv.body.signer, verifies: (await verifyDocument(inv.body)).ok, body: inv.body.body }, null, 1));

// The chain's own view of the payment, independent of the service: the revenue token account's balance.
const bal = await rpc.getTokenAccountsByOwner(revenue.address, { mint: MINT }, { encoding: 'jsonParsed', commitment: 'confirmed' }).send();
console.log(JSON.stringify({ step: 'source of truth', revenueTokenBalance: bal.value.map((a) => (a.account.data as unknown as { parsed: { info: { tokenAmount: { amount: string } } } }).parsed.info.tokenAmount.amount) }));
await app.close();
await db.end();
