// Pays a URL over x402 (or MPP with PREFER=mpp) from a Solana CLI keypair, within a ceiling, and prints the result.
//   RPC_URL=<rpc> WALLET=<keypair.json> MAX=<base units> [PREFER=mpp] tsx examples/pay.ts <url>
import { readFileSync } from 'node:fs';
import { createKeyPairSignerFromBytes } from '@solana/kit';
import { createPayFetch, createRpc } from '../src/index.js';

const { RPC_URL, WALLET, MAX, PREFER } = process.env;
const url = process.argv[2];
if (!RPC_URL || !WALLET || !MAX || !url) {
  console.error('usage: RPC_URL=<rpc> WALLET=<keypair.json> MAX=<base units> [PREFER=mpp] tsx examples/pay.ts <url>');
  process.exit(2);
}
const signer = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(WALLET, 'utf8')) as number[]));
const pay = createPayFetch({ signer, rpc: createRpc(RPC_URL), limits: { maxAmount: BigInt(MAX) }, ...(PREFER === 'mpp' ? { prefer: 'mpp' as const } : {}) });
const { response, paid } = await pay(url);
console.log(JSON.stringify({ status: response.status, paid: paid && { protocol: paid.protocol, amount: paid.amount.toString(), asset: paid.asset, payTo: paid.payTo, signature: paid.transaction } }));
console.log(await response.text());
