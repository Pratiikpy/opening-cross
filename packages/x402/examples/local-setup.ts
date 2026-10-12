// Prepares a local paid stack on a solana-test-validator: a payment mint, a recipient with its token account, a fee payer, a
// buyer holding the token and no SOL, and an attestation key. Writes the keypairs (Solana CLI format) and prints the
// environment the API needs, one KEY=value per line.
//   X402_TEST_RPC=http://127.0.0.1:8940 tsx examples/local-setup.ts <output directory>
import { webcrypto } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Address, createKeyPairSignerFromBytes, generateKeyPairSigner, getAddressDecoder } from '@solana/kit';
import { airdrop, createAta, createMint, mintTo } from '../test/chain.js';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: tsx examples/local-setup.ts <output directory>');
  process.exit(2);
}
mkdirSync(dir, { recursive: true });

/** A keypair whose secret can be written to a file, which kit's own generator does not allow. */
async function fileKey(name: string) {
  const pair = (await webcrypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as CryptoKeyPair;
  const secret = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', pair.privateKey)).subarray(-32);
  const pub = Buffer.from(await webcrypto.subtle.exportKey('raw', pair.publicKey));
  const bytes = Uint8Array.from([...secret, ...pub]);
  const file = join(dir, `${name}.json`);
  writeFileSync(file, JSON.stringify([...bytes]));
  return { file, address: getAddressDecoder().decode(pub) as Address, signer: await createKeyPairSignerFromBytes(bytes) };
}

const [feePayer, buyer, attestation] = await Promise.all([fileKey('fee-payer'), fileKey('buyer'), fileKey('attestation')]);
const authority = await generateKeyPairSigner();
const recipient = await generateKeyPairSigner();
await Promise.all([airdrop(feePayer.address, 2), airdrop(authority.address, 2)]);
const mint = await createMint(authority, authority.address, 6);
await createAta(authority, recipient.address, mint.address);
await mintTo(authority, authority, mint.address, buyer.address, 10_000_000n);

console.log(`X402_ASSET=${mint.address}`);
console.log(`X402_PAY_TO=${recipient.address}`);
console.log(`X402_FEE_PAYER_KEYPAIR=${feePayer.file}`);
console.log(`X402_ATTESTATION_KEYPAIR=${attestation.file}`);
console.log(`BUYER_KEYPAIR=${buyer.file}`);
console.log(`BUYER_ADDRESS=${buyer.address}`);
