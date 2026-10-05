#!/usr/bin/env node
// opening-cross-verify <cross-address> [--rpc <url>]
// Prints the fairness proof as JSON and exits non-zero if the cross does not verify.
import { type Address, address, createSolanaRpc, fetchEncodedAccount } from '@solana/kit';
import { verifyCross } from './index.js';

const args = process.argv.slice(2);
const crossArg = args.find((a) => !a.startsWith('--'));
const rpcIdx = args.indexOf('--rpc');
const url = rpcIdx >= 0 ? args[rpcIdx + 1] : (process.env.RPC_URL ?? 'https://api.devnet.solana.com');
if (!crossArg || !url) {
  console.error('usage: opening-cross-verify <cross-address> [--rpc <url>]');
  process.exit(2);
}
const rpc = createSolanaRpc(url);
const fetcher = async (a: Address) => {
  const acct = await fetchEncodedAccount(rpc, a, { commitment: 'confirmed' });
  return acct.exists ? acct.data : null;
};
const proof = await verifyCross(fetcher, address(crossArg));
console.log(JSON.stringify(proof, null, 2));
process.exit(proof.verified ? 0 : 1);
