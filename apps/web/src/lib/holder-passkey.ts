// A wallet whose key comes from a passkey (I2; ADR-0402). Devnet preview.
//
// The key is never stored. A passkey made with the WebAuthn PRF extension answers a fixed label with 32 secret bytes, but only after
// the person proves themselves (fingerprint, face, device PIN). Those bytes are expanded into an Ed25519 key with HKDF, used for
// one signing request, and dropped. The same passkey gives the same wallet on every device it syncs to (iCloud Keychain, Google
// Password Manager), and a device without that passkey cannot sign. A passkey that is deleted everywhere is a wallet that is gone.
import { createKeyPairFromPrivateKeyBytes, getAddressFromPublicKey, getTransactionDecoder, getTransactionEncoder, partiallySignTransaction, signBytes } from '@solana/kit';

export const PASSKEY_WALLET_NAME = 'Passkey wallet (devnet preview)';
const MARKER_KEY = 'opening-bell.passkey.v1';
const LABEL = 'opening-bell/solana-wallet/v1';
const HKDF_INFO = 'opening-bell/ed25519/v1';

const text = (s: string) => new TextEncoder().encode(s);

/** The PRF input: a fixed 32-byte label, so every device asks the passkey the same question. */
export async function prfSalt(): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', text(LABEL)));
}

/** Expands the passkey's PRF output into a 32-byte Ed25519 seed. */
export async function seedFromPrf(prf: BufferSource): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey('raw', prf, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: text(HKDF_INFO) }, key, 256));
}

export async function keyPairFromPrf(prf: BufferSource) {
  const keyPair = await createKeyPairFromPrivateKeyBytes(await seedFromPrf(prf), false);
  return { keyPair, address: await getAddressFromPublicKey(keyPair.publicKey) };
}

/** Signs a wire-format transaction, filling this key's signature slot and leaving any other signer's slot as it was. */
export async function signWire(keyPair: CryptoKeyPair, wire: Uint8Array): Promise<Uint8Array> {
  const tx = getTransactionDecoder().decode(wire);
  const signed = await partiallySignTransaction([keyPair], tx);
  return Uint8Array.from(getTransactionEncoder().encode(signed));
}

export async function signMessageBytes(keyPair: CryptoKeyPair, message: Uint8Array): Promise<Uint8Array> {
  return Uint8Array.from(await signBytes(keyPair.privateKey, message));
}

// ---------------------------------------------------------------- the browser side

export type PasskeySupport = { ok: true } | { ok: false; reason: string };

export function passkeySupport(env: { credentials?: unknown; secure?: boolean; PublicKeyCredential?: unknown }): PasskeySupport {
  if (!env.secure) return { ok: false, reason: 'Passkeys need a secure (https) page.' };
  if (!env.credentials || !env.PublicKeyCredential) return { ok: false, reason: 'This browser does not support passkeys.' };
  return { ok: true };
}

export const hasPasskeyMarker = (): boolean => {
  try {
    return localStorage.getItem(MARKER_KEY) !== null;
  } catch {
    return false;
  }
};
const setMarker = () => {
  try {
    localStorage.setItem(MARKER_KEY, new Date().toISOString());
  } catch {
    // Not remembered: the next connect asks for an existing passkey first.
  }
};

/** Asks the browser for the passkey's PRF output, after the person verifies themselves. */
async function evaluate(): Promise<Uint8Array<ArrayBuffer>> {
  const salt = await prfSalt();
  const cred = (await navigator.credentials.get({
    publicKey: { challenge: crypto.getRandomValues(new Uint8Array(32)), rpId: location.hostname, userVerification: 'required', timeout: 120_000, extensions: { prf: { eval: { first: salt } } } as AuthenticationExtensionsClientInputs },
  })) as PublicKeyCredential | null;
  const out = (cred?.getClientExtensionResults() as { prf?: { results?: { first?: ArrayBuffer } } } | undefined)?.prf?.results?.first;
  if (!out) throw new Error('This passkey did not give the secret this wallet needs. Use a passkey from a browser or device that supports the PRF extension (Chrome 116 or later, Safari 18 or later).');
  return new Uint8Array(out.slice(0));
}

/** Makes a new passkey for this site and proves it supports the PRF extension. Resolves once the passkey exists. */
async function create(): Promise<void> {
  const cred = (await navigator.credentials.create({
    publicKey: {
      rp: { name: 'Opening Bell', id: location.hostname },
      user: { id: crypto.getRandomValues(new Uint8Array(16)), name: 'Opening Bell wallet', displayName: 'Opening Bell wallet (devnet)' },
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      timeout: 120_000,
      extensions: { prf: {} } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error('No passkey was created.');
  const prf = (cred.getClientExtensionResults() as { prf?: { enabled?: boolean } }).prf;
  if (!prf?.enabled) throw new Error('This browser or device cannot make a passkey with the secret this wallet needs (the PRF extension). Nothing was created.');
  setMarker();
}

export type PasskeyMode = 'auto' | 'existing' | 'new';
let mode: PasskeyMode = 'auto';
/** Chosen on the portfolio card: sign in with a passkey that already exists (another device), or make a new one. */
export const setPasskeyMode = (m: PasskeyMode) => void (mode = m);

/** The key for one request: derived from the passkey after verification, to be dropped when the request is done. */
export async function unlock() {
  const existing = mode === 'existing' || (mode === 'auto' && hasPasskeyMarker());
  if (!existing) {
    await create();
    mode = 'auto';
  }
  return keyPairFromPrf(await evaluate());
}
