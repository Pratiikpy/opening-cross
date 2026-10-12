// Returns the SOL left in the throwaway creator wallets of the adapter proofs (kept in .keys/adapter-creators, git-ignored)
// to the devnet promiser key.
import { readFileSync, readdirSync } from 'node:fs';
import { createKeyPairSignerFromBytes } from '@solana/kit';
import { getTransferSolInstruction } from '@solana-program/system';
import { ROOT } from './lib.js';
import { lamports, promiserSigner, send } from './adapter-lib.js';

const dir = `${ROOT}.keys/adapter-creators`;
const promiser = await promiserSigner();
let total = 0n;
for (const f of readdirSync(dir).filter((n) => n.endsWith('.json'))) {
  const signer = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(`${dir}/${f}`, 'utf8'))));
  const amount = (await lamports(signer.address)) - 5_000n;
  if (amount <= 0n) continue;
  await send([getTransferSolInstruction({ source: signer, destination: promiser.address, amount })], signer);
  total += amount;
  console.log(`swept ${Number(amount) / 1e9} SOL from ${signer.address}`);
}
console.log(`total swept ${Number(total) / 1e9} SOL; promiser now ${Number(await lamports(promiser.address)) / 1e9} SOL`);
