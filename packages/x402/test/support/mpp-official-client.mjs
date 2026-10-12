// Pays a URL with the official Solana Foundation MPP client (@solana/mpp, which builds on mppx), as a stranger's agent would.
// Run from a directory where `npm install @solana/mpp@0.7.0 @solana/kit mppx` has been done. Reads the wallet from SECRET_KEY
// (JSON array of 64 bytes), the cluster from RPC_URL and the target from argv[2]. Prints one JSON line.
import { createKeyPairSignerFromBytes } from '@solana/kit';
import { Mppx, solana } from '@solana/mpp/client';

const signer = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(process.env.SECRET_KEY)));
const mppx = Mppx.create({ methods: [solana.charge({ signer, rpcUrl: process.env.RPC_URL, ...(process.env.ALLOW_UNKNOWN_TOKEN2022 === '1' ? { allowUnknownToken2022: true } : {}) })], polyfill: false });
const res = await mppx.fetch(process.argv[2]);
const receipt = res.headers.get('payment-receipt');
console.log(JSON.stringify({ status: res.status, body: await res.text(), receipt: receipt ? JSON.parse(Buffer.from(receipt, 'base64url').toString()) : null, wwwAuthenticate: res.headers.get('www-authenticate') }));
