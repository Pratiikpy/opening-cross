// A real pay-per-call run on devnet: the paid routes behind the real x402 gate, a real payment mint, a buyer that pays with
// `createPayFetch`, settlement on chain, and the buyer's receipt checked. The API here is the repository's own route module on
// a local port (the deployed stack does not carry the paid routes until it is redeployed); the cluster and the tokens are
// devnet's.
//
//   DATABASE_URL=postgres://... tsx scripts/paid-devnet.ts
//
// Keys live under `.keys` (git-ignored). The issuer is the devnet operations key; the buyer is the market-maker run's taker.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import pg from 'pg';
import {
  type Address,
  type Instruction,
  type KeyPairSigner,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  fetchEncodedAccount,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from '@solana/kit';
import { getCreateAccountInstruction, getTransferSolInstruction } from '@solana-program/system';
import { TOKEN_2022_PROGRAM_ADDRESS, findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstruction, getInitializeMint2Instruction, getMintSize, getMintToInstruction, getTokenDecoder } from '@solana-program/token-2022';
import { createPayFetch, createRpc } from '@opening-cross/x402';
import { migrate } from '@opening-cross/indexer';
import { verifyDocument } from '@opening-cross/attest';
import { RequestError } from '../src/tx.js';
import { registerPaid } from '../src/routes/paid.js';
import { paidFromEnv } from '../src/routes/paid-config.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const KEYS = join(resolve(HERE, '../../..'), '.keys');
const RPC = process.env.RPC_URL ?? 'https://api.devnet.solana.com';
const rpc = createSolanaRpc(RPC);
process.env.RPC_URL = RPC; // the order desk's default simulation reads it
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const show = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
const readKey = (p: string) => createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(p, 'utf8')) as number[]));
const ata = async (owner: Address, mint: Address) => (await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS }))[0];

async function send(ixs: Instruction[], payer: KeyPairSigner): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
    const tx = await signTransactionMessageWithSigners(
      pipe(createTransactionMessage({ version: 0 }), (m) => setTransactionMessageFeePayerSigner(payer, m), (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m), (m) => appendTransactionMessageInstructions(ixs, m)),
    );
    const signature = getSignatureFromTransaction(tx);
    await rpc.sendTransaction(getBase64EncodedWireTransaction(tx), { encoding: 'base64', preflightCommitment: 'confirmed' }).send();
    for (let i = 0; i < 40; i++) {
      const st = (await rpc.getSignatureStatuses([signature]).send()).value[0];
      if (st?.err) throw new Error(`transaction ${signature} failed: ${show(st.err)}`);
      if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) return signature;
      await sleep(1_500);
    }
  }
  throw new Error('not confirmed');
}

function newKeyFile(path: string) {
  return (async () => {
    if (existsSync(path)) return;
    const pair = (await webcrypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as CryptoKeyPair;
    const secret = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', pair.privateKey)).subarray(-32);
    const pub = Buffer.from(await webcrypto.subtle.exportKey('raw', pair.publicKey));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify([...Uint8Array.from([...secret, ...pub])]));
  })();
}

const STATE = join(KEYS, 'x402-run.json');
type State = { mint: string; recipient: string; feePayer: string };

async function setup(): Promise<State> {
  if (existsSync(STATE)) return JSON.parse(readFileSync(STATE, 'utf8')) as State;
  const issuer = await readKey(join(KEYS, 'opening-bell-devnet.json'));
  const taker = await readKey(join(KEYS, 'mm-taker-devnet.json'));
  await newKeyFile(join(KEYS, 'x402-recipient.json'));
  await newKeyFile(join(KEYS, 'x402-feepayer.json'));
  await newKeyFile(join(KEYS, 'x402-attestation.json'));
  const recipient = await readKey(join(KEYS, 'x402-recipient.json'));
  const feePayer = await readKey(join(KEYS, 'x402-feepayer.json'));
  const mint = await generateKeyPairSigner();
  const space = BigInt(getMintSize());
  const rent = await rpc.getMinimumBalanceForRentExemption(space).send();
  await send([getCreateAccountInstruction({ payer: issuer, newAccount: mint, lamports: rent, space, programAddress: TOKEN_2022_PROGRAM_ADDRESS }), getInitializeMint2Instruction({ mint: mint.address, decimals: 6, mintAuthority: issuer.address })], issuer);
  const mk = async (owner: Address, amount: bigint) => {
    const to = await ata(owner, mint.address);
    return [getCreateAssociatedTokenIdempotentInstruction({ payer: issuer, ata: to, owner, mint: mint.address, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS }), ...(amount > 0n ? [getMintToInstruction({ mint: mint.address, token: to, mintAuthority: issuer, amount })] : [])];
  };
  await send([...(await mk(recipient.address, 0n)), ...(await mk(taker.address, 5_000_000n)), getTransferSolInstruction({ source: issuer, destination: feePayer.address, amount: 20_000_000n })], issuer);
  const s = { mint: mint.address, recipient: recipient.address, feePayer: feePayer.address };
  writeFileSync(STATE, JSON.stringify(s, null, 2));
  console.log(show({ step: 'setup', ...s }));
  return s;
}

const balanceOf = async (owner: Address, mint: Address) => {
  const a = await fetchEncodedAccount(rpc, await ata(owner, mint), { commitment: 'confirmed' });
  return a.exists ? getTokenDecoder().decode(a.data).amount : 0n;
};

const s = await setup();
const run = JSON.parse(readFileSync(join(KEYS, 'mm-run.json'), 'utf8')) as { cross: string };
const finished = (JSON.parse(readFileSync(join(KEYS, 'mm-run-cross1.json'), 'utf8')) as { cross: string }).cross;
const secretFile = join(KEYS, 'x402-secret.hex');
if (!existsSync(secretFile)) writeFileSync(secretFile, Buffer.from(webcrypto.getRandomValues(new Uint8Array(32))).toString('hex'));

const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
await migrate(db);
const { options, gate } = await paidFromEnv(
  { X402_ENABLED: '1', X402_ASSET: s.mint, X402_PAY_TO: s.recipient, X402_FEE_PAYER_KEYPAIR: join(KEYS, 'x402-feepayer.json'), X402_SECRET_FILE: secretFile, RPC_URL: RPC, NETWORK: 'devnet', ATTESTATION_KEYPAIR: join(KEYS, 'x402-attestation.json') },
  db,
);
if (!options || !gate) throw new Error('paid routes did not come up');
// A payment that landed after its request gave up is closed by the reconciler (the API process runs it on a timer).
console.log(show({ step: 'reconcile', ...((await gate.reconcile()) as object) }));
const app = Fastify();
// The same mapping as the API's own handler: a request error is its 4xx, a busy cluster endpoint is a 503 to retry, anything else a 500.
app.setErrorHandler((err, _req, reply) => {
  if (err instanceof RequestError) return reply.code(err.status).send({ error: err.message, ...err.detail });
  const upstream = /429|HTTP error|fetch failed|ETIMEDOUT|ECONNRESET/.test(`${String(err)} ${JSON.stringify((err as { context?: unknown }).context ?? {})}`);
  return upstream ? reply.code(503).header('retry-after', '5').send({ error: 'the Solana RPC endpoint is busy or unreachable; retry in a few seconds' }) : reply.code(500).send({ error: 'internal error' });
});
registerPaid(
  app,
  {
    db,
    network: 'devnet',
    account: async (a) => {
      const x = await fetchEncodedAccount(rpc, a, { commitment: 'confirmed' });
      return x.exists ? { data: x.data, owner: x.programAddress } : null;
    },
    lifetime: async () => (await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send()).value as never,
  },
  options,
);
await app.listen({ port: 0, host: '127.0.0.1' });
const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;

const buyer = await readKey(join(KEYS, 'mm-taker-devnet.json'));
const payFetch = createPayFetch({ signer: buyer, rpc: createRpc(RPC), limits: { maxAmount: 100_000n, assets: [s.mint], payTo: [s.recipient] } });
const before = { recipient: await balanceOf(s.recipient as Address, s.mint as Address), buyer: await balanceOf(buyer.address, s.mint as Address) };

// 1. A careless buyer: junk for the order desk is a 400 before any price is offered.
const junk = await fetch(`${base}/v1/paid/order-desk`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cross: 'nope' }) });
console.log(show({ step: 'junk order-desk', status: junk.status, body: await junk.json() }));

// 2. An unpaid call to a real settled cross: 402 with a real preview.
const unpaid = await fetch(`${base}/v1/paid/verify/${finished}`);
const unpaidBody = (await unpaid.json()) as { preview: unknown; accepts: { amount: string }[] };
console.log(show({ step: 'unpaid verify', status: unpaid.status, amount: unpaidBody.accepts[0]!.amount, preview: unpaidBody.preview }));

// 3. Paid verify of the market-maker run's finished cross.
const v = await payFetch(`${base}/v1/paid/verify/${finished}`);
const vBody = (await v.response.json()) as { receipt: { body: Record<string, unknown>; signer: string; id: string; signature: string } };
const check = await verifyDocument(vBody.receipt as never, (await (await fetch(`${base}/v1/attestations/signer`)).json() as { signer: string }).signer);
console.log(show({ step: 'paid verify', status: v.response.status, paid: v.paid && { protocol: v.paid.protocol, amount: v.paid.amount, transaction: v.paid.transaction }, receipt: vBody.receipt.body, signer: vBody.receipt.signer, signatureCheck: check }));

// 4. Paid order desk on the live cross: the unsigned transaction and the cluster's own simulation.
const body = { cross: run.cross, owner: buyer.address, nonce: String(Date.now()), side: 'buy', price: '1600000', quantity: '10000000' };
const unpaidDesk = await fetch(`${base}/v1/paid/order-desk`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
console.log(show({ step: 'unpaid order-desk', status: unpaidDesk.status, preview: ((await unpaidDesk.json()) as { preview: unknown }).preview }));
const desk = await payFetch(`${base}/v1/paid/order-desk`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const deskBody = (await desk.response.json()) as Record<string, unknown>;
if (desk.response.status !== 200) console.log(show({ error: deskBody }));
console.log(show({ step: 'paid order-desk', status: desk.response.status, paid: desk.paid && { protocol: desk.paid.protocol, amount: desk.paid.amount, transaction: desk.paid.transaction }, preflight: deskBody.preflight, transactionBytes: typeof deskBody.transaction === 'string' ? deskBody.transaction.length : null }));

// 5. The chain agrees: the recipient gained exactly what the two calls cost; the buyer lost the same.
await sleep(2_000);
await sleep(4_000);
const after = { recipient: await balanceOf(s.recipient as Address, s.mint as Address), buyer: await balanceOf(buyer.address, s.mint as Address) };
console.log(show({ step: 'balances', recipientGain: after.recipient - before.recipient, buyerLoss: before.buyer - after.buyer, expected: 10_000n + 20_000n }));

await app.close();
await db.end();
