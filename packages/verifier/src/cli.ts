#!/usr/bin/env node
// opening-cross-verify <cross-address> [--rpc <url>]
// Prints the fairness proof as JSON. Exit code 0: the recomputed clearing equals the on-chain record. 1: it does not,
// or the cross has not cleared. 2: the cross could not be read (bad usage, unknown account, unreachable node).
import { type Address, address, fetchEncodedAccount } from '@solana/kit';
import { verifyCross } from './index.js';
import { createRetryingRpc } from './rpc.js';

const args = process.argv.slice(2);
const crossArg = args.find((a) => !a.startsWith('--'));
const rpcIdx = args.indexOf('--rpc');
const url = rpcIdx >= 0 ? args[rpcIdx + 1] : (process.env.RPC_URL ?? 'https://api.devnet.solana.com');
if (!crossArg || !url) {
  console.error('usage: opening-cross-verify <cross-address> [--rpc <url>]');
  process.exit(2);
}
const rpc = createRetryingRpc(url);
const fetcher = async (a: Address) => {
  const acct = await fetchEncodedAccount(rpc, a, { commitment: 'confirmed' });
  return acct.exists ? acct.data : null;
};
try {
  const proof = await verifyCross(fetcher, address(crossArg));
  console.log(JSON.stringify(proof, null, 2));
  process.exit(proof.verified ? 0 : 1);
} catch (e) {
  console.error(`could not verify ${crossArg}: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
  process.exit(2);
}
