// The AES envelope against vectors produced by an independent implementation (OpenSSL: aes-*-cbc, zero IV, PKCS padding).
// The reference's own "Encrypted Request Body" example is the Base64 of the text "helloworld" repeated, not real
// ciphertext, so it cannot serve as a vector; see docs/evidence/G-cleanverse-client.md.
import { describe, expect, it } from 'vitest';
import { AesKeyError, decryptText, encryptBody, encryptText, keyFromApiKey } from '../src/aes.js';

const K16 = 'AAECAwQFBgcICQoLDA0ODw==';
const K32 = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
const PLAIN = '{"customerId":"1234561234567892","override":false}';

describe('AES/CBC/PKCS5Padding with a zero IV', () => {
  it('matches OpenSSL for AES-128 and AES-256', () => {
    expect(encryptText(PLAIN, keyFromApiKey(K16))).toBe('/FWI8oUF2hoHYBGzGiOQPbIZp4eNWryfHw7T8FRVyqyvEF3h2HDQWLZJfCmS5xT1bLpr85teY9XxsMcfS07HCg==');
    expect(encryptText(PLAIN, keyFromApiKey(K32))).toBe('HnS4An4Ylfdp8XXc5gx9u4/CTxjpZa/flrKcEV0me+1rAKAqyEmn3gu/DXYwuap5oFBN4ZCiXvSmbrQaHxckLQ==');
  });
  it('a plaintext of exactly one block gains a full padding block', () => {
    const c = encryptText('exactly16bytes!!', keyFromApiKey(K16));
    expect(c).toBe('Szk5H2vQ9bUOD5pBc+J0NUpYrL9GfJndPUlFNF4Kc0c=');
    expect(Buffer.from(c, 'base64').length).toBe(32);
  });
  it('decrypts what it encrypts, including non-ASCII text', () => {
    const key = keyFromApiKey(K16);
    for (const s of ['', 'x', PLAIN, 'Zoë 東京 — €', 'a'.repeat(4097)]) expect(decryptText(encryptText(s, key), key)).toBe(s);
  });
  it('encryptBody wraps the JSON in {"data": ...}', () => {
    const key = keyFromApiKey(K16);
    const b = encryptBody({ a: 1 }, key);
    expect(Object.keys(b)).toEqual(['data']);
    expect(JSON.parse(decryptText(b.data, key))).toEqual({ a: 1 });
  });
  it('refuses keys that are not Base64 or not an AES length', () => {
    for (const bad of ['', 'not base64!', 'AAAA', Buffer.alloc(15).toString('base64'), Buffer.alloc(33).toString('base64'), 'AAECAwQFBgcICQoLDA0ODw']) expect(() => keyFromApiKey(bad), bad).toThrow(AesKeyError);
  });
  it('refuses ciphertext that is malformed, truncated or made with another key', () => {
    const key = keyFromApiKey(K16);
    const other = keyFromApiKey(Buffer.alloc(16, 7).toString('base64'));
    const good = encryptText(PLAIN, key);
    expect(() => decryptText('', key)).toThrow();
    expect(() => decryptText('***', key)).toThrow();
    expect(() => decryptText(Buffer.from('short').toString('base64'), key)).toThrow();
    expect(() => decryptText(good, other)).toThrow();
  });
});
