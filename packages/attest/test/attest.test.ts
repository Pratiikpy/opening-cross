import { describe, expect, it } from 'vitest';
import { generateKeyPair } from '@solana/kit';
import { AttestError, canonicalSha256, documentId, keyPairFromSolanaFile, signDocument, verifyDocument } from '../src/index.js';

const body = { schema: 'opening-cross/verification-receipt/v1', cross: 'C', verified: true, n: 3 };

describe('signed documents', () => {
  it('signs and verifies, and pins the published signer', async () => {
    const kp = await generateKeyPair();
    const s = await signDocument(body, kp);
    expect(await verifyDocument(s)).toEqual({ ok: true });
    expect(await verifyDocument(s, s.signer)).toEqual({ ok: true });
    expect(await verifyDocument(s, 'SomeoneElse1111111111111111111111111111111')).toEqual({ ok: false, reason: 'WRONG_SIGNER' });
  });

  it('detects an edited body, a swapped signer and a signature made for another kind of document', async () => {
    const kp = await generateKeyPair();
    const other = await generateKeyPair();
    const s = await signDocument(body, kp);
    expect(await verifyDocument({ ...s, body: { ...s.body, verified: false } })).toEqual({ ok: false, reason: 'ID_MISMATCH' });
    const forged = await signDocument(body, other);
    expect(await verifyDocument({ ...s, signer: forged.signer })).toEqual({ ok: false, reason: 'BAD_SIGNATURE' });
    // The domain is the schema: the same fields under another schema have another id and another signed message.
    const asAlert = { ...body, schema: 'opening-cross/alert/v1' };
    expect(documentId(asAlert)).not.toBe(s.id);
    expect(await verifyDocument({ ...s, body: asAlert, id: documentId(asAlert) })).toEqual({ ok: false, reason: 'BAD_SIGNATURE' });
    expect(await verifyDocument({ ...s, signature: 'zz' })).toEqual({ ok: false, reason: 'BAD_SIGNATURE' });
  });

  it('refuses a body whose schema is not a versioned opening-cross name, or whose fields are not canonical', async () => {
    const kp = await generateKeyPair();
    await expect(signDocument({ schema: 'whatever' }, kp)).rejects.toThrow(AttestError);
    await expect(signDocument({ schema: 'opening-cross/x/v1', price: 1.5 }, kp)).rejects.toThrow(/integers/);
    expect(await verifyDocument({ body: { schema: 'nope' }, id: 'x', signer: 'y', signature: 'z' })).toEqual({ ok: false, reason: 'MALFORMED' });
  });

  it('reads a Solana keypair file and nothing else', async () => {
    const seed = crypto.getRandomValues(new Uint8Array(32));
    const pkcs8 = new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20, ...seed]);
    const priv = await crypto.subtle.importKey('pkcs8', pkcs8, 'Ed25519', true, ['sign']);
    const jwk = await crypto.subtle.exportKey('jwk', priv);
    const pub = Uint8Array.from(Buffer.from(jwk.x!, 'base64url'));
    const file = JSON.stringify([...seed, ...pub]);
    const { keyPair, address } = await keyPairFromSolanaFile(file);
    const s = await signDocument(body, keyPair);
    expect(s.signer).toBe(address);
    expect(await verifyDocument(s)).toEqual({ ok: true });
    await expect(keyPairFromSolanaFile('[1,2,3]')).rejects.toThrow(/64 bytes/);
  });

  it('hashes canonically', () => {
    expect(canonicalSha256({ b: 1, a: 'x' })).toBe(canonicalSha256({ a: 'x', b: 1 }));
  });
});
