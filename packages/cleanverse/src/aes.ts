// The request envelope of the Cleanverse cooperate API: AES/CBC/PKCS5Padding, a fixed IV of 16 zero bytes, the key is the
// Base64-decoded api-key, the ciphertext is Base64 in a `data` field. PKCS5 and PKCS7 padding are identical for a 16-byte
// block, which is what node:crypto applies by default.
import { createCipheriv, createDecipheriv } from 'node:crypto';

const IV = Buffer.alloc(16, 0);
const ALGORITHM: Record<number, string> = { 16: 'aes-128-cbc', 24: 'aes-192-cbc', 32: 'aes-256-cbc' };

export class AesKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AesKeyError';
  }
}

/** The AES key from the Base64 api-key. Throws unless it decodes to 16, 24 or 32 bytes. */
export function keyFromApiKey(apiKeyBase64: string): Buffer {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(apiKeyBase64) || apiKeyBase64.length % 4 !== 0) throw new AesKeyError('the api-key must be Base64 text');
  const key = Buffer.from(apiKeyBase64, 'base64');
  if (!ALGORITHM[key.length]) throw new AesKeyError(`the api-key decodes to ${key.length} bytes; AES needs 16, 24 or 32`);
  return key;
}

/** Encrypts a UTF-8 string and returns the Base64 ciphertext. */
export function encryptText(plaintext: string, key: Buffer): string {
  const c = createCipheriv(ALGORITHM[key.length]!, key, IV);
  return Buffer.concat([c.update(plaintext, 'utf8'), c.final()]).toString('base64');
}

/** Decrypts Base64 ciphertext to a UTF-8 string; throws on bad Base64, bad padding or a wrong key. */
export function decryptText(ciphertextBase64: string, key: Buffer): string {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(ciphertextBase64) || ciphertextBase64.length % 4 !== 0) throw new Error('ciphertext is not Base64');
  const raw = Buffer.from(ciphertextBase64, 'base64');
  if (raw.length === 0 || raw.length % 16 !== 0) throw new Error('ciphertext is not a whole number of AES blocks');
  const d = createDecipheriv(ALGORITHM[key.length]!, key, IV);
  return Buffer.concat([d.update(raw), d.final()]).toString('utf8');
}

/** `{"data":"<ciphertext>"}` for a plaintext JSON value. */
export function encryptBody(value: unknown, key: Buffer): { data: string } {
  return { data: encryptText(JSON.stringify(value), key) };
}
