// Disposable keypairs for the holder browser runs, derived from a public label. They hold nothing anywhere and are not secrets: the same
// label gives the same key, so the harness (which has to know every wallet's address to give it token accounts and passes) and the test
// script (which has to sign as that wallet) agree without sharing a file.
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/** The 64-byte secret key (32-byte seed then 32-byte public key) of the harness wallet called `label`, as an array of numbers. */
export function walletSecret(label) {
  const seed = createHash('sha256').update(`opening-bell holder harness wallet: ${label}`).digest();
  const key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: 'der', type: 'pkcs8' });
  const pub = createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32);
  return [...seed, ...pub];
}

/** The wallets the harness funds and the runs sign as. */
export const WALLET_LABELS = ['pass', 'nopass', 'insider', 'limit', 'lock', 'claim', 'pushed', 'refund', 'holder', 'team', 'small', 'stranger', 'beneficiary', 'priority'];
