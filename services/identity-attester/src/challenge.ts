// The one check this attester makes: the requester controls the wallet. The service hands out a short text, the wallet signs it with
// its own key (Wallet Standard signMessage), and the service verifies the Ed25519 signature against the wallet's address. The text
// carries an HMAC so the service keeps no state between the two calls.
//
// This is NOT an identity check. It says nothing about who holds the wallet, where they live or whether they may buy a security.
import { createHmac } from 'node:crypto';
import { type Address, getPublicKeyFromAddress, signatureBytes, verifySignature } from '@solana/kit';

export const CHECK_LABEL = 'devnet test attester: no real identity verification';
/** How long a challenge stays valid, in seconds. */
export const CHALLENGE_TTL_SECONDS = 600;

const mac = (secret: Uint8Array, wallet: Address, issuedAt: number) => createHmac('sha256', secret).update(`oc-attester-challenge|${wallet}|${issuedAt}`).digest('hex');

/** The exact text the wallet signs. */
export function challengeMessage(secret: Uint8Array, wallet: Address, issuedAt: number): string {
  return [
    'Opening Cross devnet test attester',
    `This signature only proves you control the wallet ${wallet}.`,
    'No identity is verified and this is not KYC.',
    `Issued at (unix): ${issuedAt}`,
    `Reference: ${mac(secret, wallet, issuedAt)}`,
  ].join('\n');
}

export type ChallengeVerdict = { ok: true } | { ok: false; reason: 'expired' | 'from the future' | 'bad signature' | 'malformed signature' };

/** Checks the age of the challenge and the wallet's signature over it. `signature` is the 64-byte Ed25519 signature. */
export async function verifyChallenge(i: { secret: Uint8Array; wallet: Address; issuedAt: number; signature: Uint8Array; now: number }): Promise<ChallengeVerdict> {
  if (i.signature.length !== 64) return { ok: false, reason: 'malformed signature' };
  if (i.issuedAt > i.now + 30) return { ok: false, reason: 'from the future' };
  if (i.now - i.issuedAt > CHALLENGE_TTL_SECONDS) return { ok: false, reason: 'expired' };
  const message = new TextEncoder().encode(challengeMessage(i.secret, i.wallet, i.issuedAt));
  const key = await getPublicKeyFromAddress(i.wallet);
  const good = await verifySignature(key, signatureBytes(i.signature), message);
  return good ? { ok: true } : { ok: false, reason: 'bad signature' };
}
