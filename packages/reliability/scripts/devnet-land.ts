// A real landing on devnet: failover over the endpoints given, a priority fee estimated from the cluster, a transfer built
// with the compute-budget instructions, signed, and landed by sending it through every route. Prints what happened.
//
//   pnpm exec tsx scripts/devnet-land.ts <keypair.json> [endpoint ...]
import { readFileSync } from 'node:fs';
import { getTransferSolInstruction } from '@solana-program/system';
import {
  address,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Blockhash,
} from '@solana/kit';
import { FailoverRpc, computeBudgetInstructions, estimatePriorityFee, landWithRetries, priorityFeeLamports, unitLimitFor } from '../src/index.js';

const [keyfile, ...rest] = process.argv.slice(2);
if (!keyfile) throw new Error('usage: devnet-land.ts <keypair.json> [endpoint ...]');
const urls = rest.length ? rest : ['https://api.devnet.solana.com'];
const signer = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(keyfile, 'utf8')) as number[]));
const rpc = new FailoverRpc(urls, { rounds: 3 });

const slots = await rpc.probe();
console.log('slots', Object.fromEntries([...slots].map(([u, s]) => [new URL(u).host, s])));

const to = address('DTB3Jtxb6dy7GvocUbypiJb548ZLGRzVdPrNNCWAKEdC');
const fee = await estimatePriorityFee(rpc, [signer.address, to], { percentile: 0.75, floor: 1n, computeUnits: 5_000 });
console.log('priority fee estimate', { ...fee, microLamports: String(fee.microLamports) });

const built = async (microLamports: bigint) => {
  const { value } = await rpc.call<{ value: { blockhash: string; lastValidBlockHeight: number } }>('getLatestBlockhash', [{ commitment: 'confirmed' }]);
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(signer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: value.blockhash as Blockhash, lastValidBlockHeight: BigInt(value.lastValidBlockHeight) }, m),
    (m) => appendTransactionMessageInstructions([...computeBudgetInstructions(unitLimitFor(450), microLamports), getTransferSolInstruction({ source: signer, destination: to, amount: 1n })] as never, m),
  );
  const signed = await signTransactionMessageWithSigners(message);
  return { wire: Uint8Array.from(Buffer.from(getBase64EncodedWireTransaction(signed), 'base64')), lastValidBlockHeight: BigInt(value.lastValidBlockHeight) };
};

const result = await landWithRetries(rpc, built, { microLamports: fee.microLamports, maxMicroLamports: 50_000n, onEvent: (e) => console.log(' ·', e) });
console.log('result', { ...result, attempts: result.attempts.map((a) => ({ ...a, microLamports: String(a.microLamports) })) });
console.log('priority fee paid', String(priorityFeeLamports(unitLimitFor(450), result.attempts.at(-1)!.microLamports)), 'lamports');
console.log('endpoint health', rpc.pool.snapshot().map((s) => ({ host: new URL(s.url).host, calls: s.calls, rateLimited: s.rateLimited, failures: s.failures, latencyMs: Math.round(s.latencyMs), successRate: +s.successRate.toFixed(2) })));
process.exit(result.status === 'landed' ? 0 : 1);
