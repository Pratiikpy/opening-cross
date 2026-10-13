import { describe, expect, it } from 'vitest';
import { createKeyPairSignerFromPrivateKeyBytes, getAddressFromPublicKey, getBase64EncodedWireTransaction, verifySignature } from '@solana/kit';
import { PASSKEY_WALLET_NAME, keyPairFromPrf, passkeySupport, prfSalt, seedFromPrf, signMessageBytes, signWire } from '../src/lib/holder-passkey';
import { createNoopSigner, compileTransaction, createTransactionMessage, appendTransactionMessageInstruction, setTransactionMessageFeePayerSigner, setTransactionMessageLifetimeUsingBlockhash, pipe, getBase64Encoder, getTransactionDecoder, address } from '@solana/kit';

const prf = (n: number) => new Uint8Array(32).fill(n);

describe('passkey wallet key derivation', () => {
  it('derives the same wallet from the same passkey secret and a different one from another', async () => {
    const a1 = await keyPairFromPrf(prf(1));
    const a2 = await keyPairFromPrf(prf(1));
    const b = await keyPairFromPrf(prf(2));
    expect(a1.address).toBe(a2.address);
    expect(a1.address).not.toBe(b.address);
    expect(a1.address).toBe(await getAddressFromPublicKey(a1.keyPair.publicKey));
  });

  it('expands the secret to 32 bytes that are not the secret itself, and asks every device the same question', async () => {
    const seed = await seedFromPrf(prf(7));
    expect(seed.length).toBe(32);
    expect(Array.from(seed)).not.toEqual(Array.from(prf(7)));
    expect(Array.from(await prfSalt())).toEqual(Array.from(await prfSalt()));
    expect((await prfSalt()).length).toBe(32);
  });

  it('gives a key that cannot be exported, so the secret never leaves WebCrypto', async () => {
    const { keyPair } = await keyPairFromPrf(prf(3));
    await expect(crypto.subtle.exportKey('pkcs8', keyPair.privateKey)).rejects.toThrow();
  });

  it('signs a message that its address verifies, and no other address does', async () => {
    const k = await keyPairFromPrf(prf(4));
    const other = await keyPairFromPrf(prf(5));
    const msg = new TextEncoder().encode('Opening Bell comment\ncross: x');
    const sig = await signMessageBytes(k.keyPair, msg);
    expect(sig.length).toBe(64);
    expect(await verifySignature(k.keyPair.publicKey, sig as never, msg)).toBe(true);
    expect(await verifySignature(other.keyPair.publicKey, sig as never, msg)).toBe(false);
  });

  it('fills only its own signature slot of a transaction and keeps another signer’s', async () => {
    const mine = await keyPairFromPrf(prf(6));
    const sponsor = await createKeyPairSignerFromPrivateKeyBytes(prf(9));
    const ix = { programAddress: address('11111111111111111111111111111111'), accounts: [{ address: address(mine.address), role: 3 }], data: new Uint8Array([2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]) };
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(createNoopSigner(sponsor.address), m),
      (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: '4NCYB3kRT8sCNodPNuCZo8VkwveZSHhg7R7mrRBFM1Uy' as never, lastValidBlockHeight: 1n }, m),
      (m) => appendTransactionMessageInstruction(ix as never, m),
    );
    const wire = Uint8Array.from(getBase64Encoder().encode(getBase64EncodedWireTransaction(compileTransaction(message))));
    const signed = await signWire(mine.keyPair, wire);
    const tx = getTransactionDecoder().decode(signed);
    expect(tx.signatures[mine.address]).toBeTruthy();
    expect(tx.signatures[sponsor.address]).toBeNull();
    expect(await verifySignature(mine.keyPair.publicKey, tx.signatures[mine.address]!, tx.messageBytes)).toBe(true);
  });
});

describe('passkey support', () => {
  it('needs a secure page and a browser with credentials', () => {
    expect(passkeySupport({ secure: false, credentials: {}, PublicKeyCredential: {} })).toMatchObject({ ok: false });
    expect(passkeySupport({ secure: true })).toMatchObject({ ok: false });
    expect(passkeySupport({ secure: true, credentials: {}, PublicKeyCredential: {} })).toEqual({ ok: true });
    expect(PASSKEY_WALLET_NAME).toContain('devnet preview');
  });
});
