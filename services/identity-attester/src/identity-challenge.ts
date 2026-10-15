// How a wallet asks the KYC attester to record its own verification. The attester publishes the wallet's country, tier and
// verification status on chain, readable by anyone, so only the holder of the wallet may ask. The service hands out a short
// text, the wallet signs it with its own key (Wallet Standard `signMessage`, no transaction, no cost) and the service checks
// the Ed25519 signature against the wallet's address. The text carries an HMAC so the service keeps no state between the
// two calls. This is a different text, key and purpose from the devnet test attester's challenge (challenge.ts).
import { createHmac } from 'node:crypto';
import { type Address, getPublicKeyFromAddress, signatureBytes, verifySignature } from '@solana/kit';

/** How long a challenge stays valid, in seconds. */
export const IDENTITY_CHALLENGE_TTL_SECONDS = 600;

/** A key of its own, derived from the attester's secret, so the identity-id key never signs anything else. */
const challengeKey = (secret: Uint8Array) => createHmac('sha256', secret).update('oc-identity-challenge-key-v1').digest();
const mac = (secret: Uint8Array, wallet: Address, issuedAt: number) => createHmac('sha256', challengeKey(secret)).update(`${wallet}|${issuedAt}`).digest('hex');

/** The exact text the wallet signs. */
export function identityChallengeMessage(secret: Uint8Array, wallet: Address, issuedAt: number): string {
  return [
    'Opening Bell identity check',
    `Ask the issuer's identity provider to record your verification on chain next to the wallet ${wallet}.`,
    'Your country, investor tier and verification status become readable by anyone who looks up this wallet.',
    'This signature is not a transaction and costs nothing.',
    `Issued at (unix): ${issuedAt}`,
    `Reference: ${mac(secret, wallet, issuedAt)}`,
  ].join('\n');
}

export type IdentityChallengeVerdict = { ok: true } | { ok: false; reason: 'expired' | 'from the future' | 'bad signature' | 'malformed signature' };

/** Checks the age of the challenge and the wallet's signature over it. `signature` is the 64-byte Ed25519 signature. */
export async function verifyIdentityChallenge(i: { secret: Uint8Array; wallet: Address; issuedAt: number; signature: Uint8Array; now: number }): Promise<IdentityChallengeVerdict> {
  if (i.signature.length !== 64) return { ok: false, reason: 'malformed signature' };
  if (i.issuedAt > i.now + 30) return { ok: false, reason: 'from the future' };
  if (i.now - i.issuedAt > IDENTITY_CHALLENGE_TTL_SECONDS) return { ok: false, reason: 'expired' };
  const message = new TextEncoder().encode(identityChallengeMessage(i.secret, i.wallet, i.issuedAt));
  const key = await getPublicKeyFromAddress(i.wallet);
  return (await verifySignature(key, signatureBytes(i.signature), message)) ? { ok: true } : { ok: false, reason: 'bad signature' };
}
