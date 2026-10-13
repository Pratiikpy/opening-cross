// A real Blink on devnet: the Action endpoints on a local port reading the live cross, a wallet-like client that does what a
// Blink client does (GET the Action, POST the account, sign the returned transaction with only that account, send it), and the
// order read back from the chain and from the deployed API's index.
//   tsx scripts/blinks-devnet.ts
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { createSolanaRpc, fetchEncodedAccount } from '@solana/kit';
import { createApiClient, createRpcClient, signSendConfirm } from '@opening-cross/client';
import { loadKeypairSigner } from '@opening-cross/client/node';
import { registerBlinks } from '../src/routes/blinks.js';

const KEYS = join(resolve(dirname(fileURLToPath(import.meta.url)), '../../..'), '.keys');
const RPC = process.env.RPC_URL ?? 'https://api.devnet.solana.com';
const API = process.env.API_URL ?? 'https://98-87-59-136.sslip.io';
const rpc = createSolanaRpc(RPC);
const cross = (JSON.parse(readFileSync(join(KEYS, 'mm-run.json'), 'utf8')) as { cross: string }).cross;
const show = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));

const app = Fastify();
registerBlinks(app, {
  account: async (a) => {
    const x = await fetchEncodedAccount(rpc, a, { commitment: 'confirmed' });
    return x.exists ? { data: x.data, owner: x.programAddress } : null;
  },
  lifetime: async () => (await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send()).value as never,
  network: 'devnet',
});
await app.listen({ port: 0, host: '127.0.0.1' });
const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;

const wallet = await loadKeypairSigner(join(KEYS, 'mm-taker-devnet.json'));
const get = await (await fetch(`${base}/v1/blinks/cross/${cross}`)).json();
console.log(show({ step: 'GET action', title: get.title, label: get.label, description: get.description, actions: get.links?.actions?.map((a: { label: string; href: string }) => ({ label: a.label, href: a.href })) }));

// The client fills {price}; "Buy 1" fixes the quantity. A price of 1.55 on a 0.05 grid.
const href = (get.links.actions[0].href as string).replace('{price}', '1.55');
const res = await fetch(`${base}${href}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ account: wallet.address }) });
const post = await res.json();
console.log(show({ step: 'POST order', status: res.status, message: post.message, transactionBytes: String(post.transaction ?? '').length }));
if (res.status !== 200) process.exit(1);

const sigs = await signSendConfirm([{ transaction: post.transaction, signers: [wallet.address] }], { rpc: createRpcClient({ url: RPC }), sign: wallet.sign });
console.log(show({ step: 'signed and sent', signatures: sigs }));

// Read back: the cross's order count from chain, then the deployed API's index.
await new Promise((r) => setTimeout(r, 4_000));
const api = createApiClient({ baseUrl: API });
const detail = await api.getCross(cross);
console.log(show({ step: 'chain', orders: detail.orders }));
for (let i = 0; i < 8; i++) {
  const mine = (await api.ownerOrders(wallet.address)).filter((o) => o.cross_address === cross);
  if (mine.length > 0) {
    console.log(show({ step: 'index', orders: mine.map((o) => ({ side: o.side, price: o.price, quantity: o.quantity, status: o.status, escrow: o.escrow })) }));
    break;
  }
  await new Promise((r) => setTimeout(r, 6_000));
}
await app.close();
