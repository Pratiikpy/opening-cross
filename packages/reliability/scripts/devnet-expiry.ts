// A real expiry on devnet. The first transaction is built and then held back until its blockhash is dead; landing it must end in
// "expired" (never "landed", never hanging). The retry path then rebuilds with a fresh blockhash and a higher fee and lands that.
//
//   pnpm exec tsx scripts/devnet-expiry.ts <keypair.json> [endpoint ...]
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
import { FailoverRpc, computeBudgetInstructions, landWithRetries, unitLimitFor } from '../src/index.js';

const [keyfile, ...rest] = process.argv.slice(2);
if (!keyfile) throw new Error('usage: devnet-expiry.ts <keypair.json> [endpoint ...]');
const rpc = new FailoverRpc(rest.length ? rest : ['https://api.devnet.solana.com'], { rounds: 3 });
const signer = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(keyfile, 'utf8')) as number[]));
const to = address('DTB3Jtxb6dy7GvocUbypiJb548ZLGRzVdPrNNCWAKEdC');

async function build(microLamports: bigint, blockhash?: { blockhash: string; lastValidBlockHeight: number }) {
  const value = blockhash ?? (await rpc.call<{ value: { blockhash: string; lastValidBlockHeight: number } }>('getLatestBlockhash', [{ commitment: 'confirmed' }])).value;
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(signer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: value.blockhash as Blockhash, lastValidBlockHeight: BigInt(value.lastValidBlockHeight) }, m),
    (m) => appendTransactionMessageInstructions([...computeBudgetInstructions(unitLimitFor(450), microLamports), getTransferSolInstruction({ source: signer, destination: to, amount: 1n })] as never, m),
  );
  const signed = await signTransactionMessageWithSigners(message);
  return { wire: Uint8Array.from(Buffer.from(getBase64EncodedWireTransaction(signed), 'base64')), lastValidBlockHeight: BigInt(value.lastValidBlockHeight) };
}

const { value: old } = await rpc.call<{ value: { blockhash: string; lastValidBlockHeight: number } }>('getLatestBlockhash', [{ commitment: 'confirmed' }]);
let height = await rpc.call<number>('getBlockHeight');
console.log(`blockhash valid until height ${old.lastValidBlockHeight}; now ${height}; waiting for it to die (~${Math.round(((old.lastValidBlockHeight - height) * 0.4) / 1)} s)`);
while (height <= old.lastValidBlockHeight) {
  await new Promise((r) => setTimeout(r, 5_000));
  height = await rpc.call<number>('getBlockHeight');
}
console.log(`height ${height} is past ${old.lastValidBlockHeight}: the held transaction can no longer land`);

let builds = 0;
const result = await landWithRetries(
  rpc,
  async (fee) => {
    builds += 1;
    return builds === 1 ? build(fee, old) : build(fee);
  },
  { microLamports: 5n, maxMicroLamports: 1_000n, onEvent: (e) => console.log(' ·', e) },
);
console.log(JSON.stringify({ ...result, attempts: result.attempts.map((a) => ({ ...a, microLamports: String(a.microLamports) })) }, null, 1));
process.exit(result.status === 'landed' && result.attempts[0]?.status === 'expired' ? 0 : 1);
