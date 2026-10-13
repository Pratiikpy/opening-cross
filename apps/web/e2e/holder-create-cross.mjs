// Opens an escrow cross on devnet without the issuer console, so a holder-side run does not depend on it: the API builds the create
// transactions (POST /v1/tx/create-cross), this script signs them with a keypair file under .keys and sends them.
//
//   KEY_FILE=live-buyer.json OPEN_IN=150 OPEN_FOR=150 node e2e/holder-create-cross.mjs   (prints the cross address on the last line)
//
// Costs about 0.17 SOL of devnet rent. The key is read here and never printed.
import { keyFile, addressOf, sleep } from './holder-lib.mjs';

const API = process.env.API_URL ?? 'https://98-87-59-136.sslip.io';
const RPC = (process.env.RPC_URL ?? 'https://api.devnet.solana.com').split(',')[0];
const BASE_MINT = process.env.BASE_MINT ?? 'HV2P22LJPewKomy7aN4CV1dTd2Dwpsi6Ta76fDAJFXQc';
const QUOTE_MINT = process.env.QUOTE_MINT ?? 'B78M2HhTHtR2wF3oxR4ikkBupc5TgtBbQbukYXwJEizm';
const secret = keyFile(process.env.KEY_FILE ?? 'live-buyer.json');
const owner = addressOf(secret);
const publicKey = Uint8Array.from(secret.slice(32));
const pkcs8 = new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20, ...secret.slice(0, 32)]);
const key = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign']);

const rpc = async (method, params) => {
  for (let i = 0; i < 10; i++) {
    const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    if (r.status === 429) {
      await sleep(1500 * (i + 1));
      continue;
    }
    const j = await r.json();
    if (j.error) throw new Error(`${method}: ${j.error.message}`);
    return j.result;
  }
  throw new Error('rpc kept answering 429');
};
const programOf = async (mint) => (await rpc('getAccountInfo', [mint, { encoding: 'base64' }])).value.owner;

const shortvec = (bytes, at) => {
  let len = 0;
  let size = 0;
  for (;;) {
    const b = bytes[at + size];
    len |= (b & 0x7f) << (7 * size);
    size += 1;
    if ((b & 0x80) === 0) return [len, size];
  }
};
async function sign(wire) {
  const [count, n] = shortvec(wire, 0);
  const message = wire.slice(n + 64 * count);
  const header = (message[0] & 0x80) !== 0 ? 1 : 0;
  const [keys, kn] = shortvec(message, header + 3);
  const start = header + 3 + kn;
  let slot = -1;
  for (let i = 0; i < Math.min(keys, count); i++) if (message.slice(start + 32 * i, start + 32 * (i + 1)).every((x, j) => x === publicKey[j])) slot = i;
  if (slot < 0) throw new Error('this transaction does not need this wallet');
  const out = wire.slice();
  out.set(new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, key, message)), n + 64 * slot);
  return out;
}

const now = Math.floor(Date.now() / 1000);
const openTs = now + Number(process.env.OPEN_IN ?? 150);
const closeTs = openTs + Number(process.env.OPEN_FOR ?? 150);
const body = {
  creator: owner,
  baseMint: BASE_MINT,
  quoteMint: QUOTE_MINT,
  baseTokenProgram: await programOf(BASE_MINT),
  quoteTokenProgram: await programOf(QUOTE_MINT),
  crossId: String(BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000))),
  kind: 'reopen',
  supplyMode: 'escrow',
  disclosure: 'open',
  minPrice: '1000000',
  tick: '10000',
  ticks: 60,
  priceScale: '1000000',
  openTs: String(openTs),
  closeTs: String(closeTs),
  revealEndTs: String(closeTs),
  minMatched: '0',
  maxImbalanceBps: null,
  integratorFeeBps: 0,
  integrator: owner,
  shards: 4,
  maxOrders: 1000,
  proceedsTo: owner,
  schedule: [],
};
const r = await fetch(`${API}/v1/tx/create-cross`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const built = await r.json();
if (!r.ok) throw new Error(`create-cross refused: ${built.error}`);
const b64 = (s) => Uint8Array.from(Buffer.from(s, 'base64'));
for (const [i, t] of built.transactions.entries()) {
  const signed = await sign(b64(t.transaction));
  const sig = await rpc('sendTransaction', [Buffer.from(signed).toString('base64'), { encoding: 'base64', preflightCommitment: 'confirmed' }]);
  for (let w = 0; w < 60; w++) {
    const st = (await rpc('getSignatureStatuses', [[sig]])).value[0];
    if (st?.err) throw new Error(`transaction ${i + 1} failed: ${JSON.stringify(st.err)}`);
    if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) break;
    await sleep(1500);
  }
  console.log(`transaction ${i + 1} of ${built.transactions.length} confirmed`);
}
console.log(built.cross);
