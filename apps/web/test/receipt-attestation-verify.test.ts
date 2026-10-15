// The checks the receipt page repeats on a signed, anchored receipt (row S2, ADR-0941), against documents signed by the promiser's own code and Merkle proofs built by the promises package,
// so the web verifier and the signer cannot drift apart.
import { describe, expect, it } from 'vitest';
import { generateKeyPairSigner } from '@solana/kit';
import { merkleProof, merkleRoot } from '../../../packages/promises/src/digest';
import { attestationBody, receiptMemoText, signReceiptAttestation } from '../../../services/promiser/src/receipt-attestation';
import {
  type Anchor,
  type ChainMemo,
  type View,
  addressBytes,
  attestationId,
  checkAttestation,
  proofReachesRoot,
  readAnchorTransaction,
  summarise,
  verifySignature,
} from '../src/app/receipt/_attestation/verify';

const CROSS = 'ELVKGevyF2qarSYiZHAkRdAkfKruKSgKL7aS9XTrVBK8';
const SHA = 'a'.repeat(64);
const OTHER_SHA = 'b'.repeat(64);
const BLOCK = 1_800_000_100;

async function fixture() {
  const signer = await generateKeyPairSigner();
  const att = await signReceiptAttestation(attestationBody({ cluster: 'devnet', cross: CROSS, receiptSchema: 'opening-cross/receipt/v1', receiptSha256: SHA, state: 'Finalized' }), signer);
  const sibling = 'c'.repeat(64);
  const ids = [att.id, sibling];
  const root = merkleRoot(ids);
  const anchor: Anchor = { root, count: 2, signature: '5'.repeat(88), slot: 77, blockTime: BLOCK, memo: receiptMemoText({ root, count: 2 }), proof: merkleProof(ids, att.id) as Anchor['proof'] };
  const view: View = { cluster: 'devnet', cross: CROSS, attestation: att, recordedAt: BLOCK - 60, attestations: 1, publishedSigner: signer.address, signerIsPublished: true, anchor };
  const chain: ChainMemo = { found: true, success: true, memos: [anchor.memo], signers: [signer.address], blockTime: BLOCK };
  return { signer, att, view, anchor, chain };
}
const by = (checks: ReturnType<typeof checkAttestation>) => Object.fromEntries(checks.map((c) => [c.id, c.verdict]));

describe('addresses, signatures and proofs', () => {
  it('reads a Solana address as its 32 bytes, including leading zero bytes, and refuses anything else', () => {
    expect(addressBytes('11111111111111111111111111111111')).toEqual(Buffer.alloc(32));
    expect(addressBytes('So11111111111111111111111111111111111111112')?.length).toBe(32);
    expect(addressBytes('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')?.toString('hex')).toBe('c6fa7af3bedbad3a3d65f36aabc97431b1bbe4c2d2f6e0e47ca60203452f5d61');
    for (const bad of ['', 'short', '0OIl'.repeat(10), 'So1111111111111111111111111111111111111111234567890']) expect(addressBytes(bad), bad).toBeNull();
  });

  it('verifies what the promiser signs, and nothing it did not', async () => {
    const { att, signer } = await fixture();
    const msg = `${att.body.schema}\n${att.id}`;
    expect(verifySignature(att.signer, att.signature, msg)).toBe(true);
    expect(verifySignature(att.signer, att.signature, `${msg}x`)).toBe(false);
    expect(verifySignature(att.signer, att.signature.replace(/^./, (c) => (c === '0' ? '1' : '0')), msg)).toBe(false);
    expect(verifySignature((await generateKeyPairSigner()).address, att.signature, msg)).toBe(false);
    expect(verifySignature(att.signer, 'zz', msg)).toBe(false);
    expect(verifySignature('not an address', att.signature, msg)).toBe(false);
    expect(signer.address).toBe(att.signer);
  });

  it('computes the same id as the signer and walks a Merkle proof built by the promises package', async () => {
    const { att, anchor } = await fixture();
    expect(attestationId(att.body)).toBe(att.id);
    expect(proofReachesRoot(att.id, anchor.proof, anchor.root)).toBe(true);
    expect(proofReachesRoot('d'.repeat(64), anchor.proof, anchor.root)).toBe(false);
    expect(proofReachesRoot(att.id, [], anchor.root)).toBe(false);
    expect(proofReachesRoot(att.id, anchor.proof, 'e'.repeat(64))).toBe(false);
    expect(proofReachesRoot(att.id, [{ hash: 'zz', side: 'L' }], anchor.root)).toBe(false);
    // Larger batches, every member provable, odd counts included.
    for (const n of [1, 2, 3, 5, 8, 13]) {
      const ids = Array.from({ length: n }, (_, i) => `${i.toString(16).padStart(2, '0')}`.repeat(32));
      const root = merkleRoot(ids);
      for (const id of ids) expect(proofReachesRoot(id, merkleProof(ids, id) as Anchor['proof'], root), `${n} ${id.slice(0, 4)}`).toBe(true);
    }
  });
});

describe('checks on an attestation', () => {
  it('passes every check on a good one, and calls it trusted and anchored', async () => {
    const f = await fixture();
    const checks = checkAttestation({ view: f.view, liveReceiptSha256: SHA, chain: f.chain });
    expect(by(checks)).toEqual({ id: 'pass', signature: 'pass', signer: 'pass', receipt: 'pass', merkle: 'pass', chain: 'pass' });
    expect(summarise(checks)).toEqual({ trusted: true, failed: false, anchored: true });
    expect(checks.find((c) => c.id === 'chain')!.detail).toContain('2027-01-15 08:01:40 UTC');
  });

  it('is signed but not anchored until the batch is written, and says what that costs', async () => {
    const f = await fixture();
    const checks = checkAttestation({ view: { ...f.view, anchor: null }, liveReceiptSha256: SHA });
    expect(by(checks)).toEqual({ id: 'pass', signature: 'pass', signer: 'pass', receipt: 'pass', anchor: 'unknown' });
    expect(summarise(checks)).toEqual({ trusted: true, failed: false, anchored: false });
    expect(checks.find((c) => c.id === 'anchor')!.detail).toContain('nothing bounds the time');
  });

  it('never says pass for what it could not check: no chain read, no live receipt, no published signer', async () => {
    const f = await fixture();
    expect(by(checkAttestation({ view: f.view, liveReceiptSha256: SHA, chain: null })).chain).toBe('unknown');
    expect(by(checkAttestation({ view: f.view, liveReceiptSha256: SHA })).chain).toBe('unknown');
    expect(by(checkAttestation({ view: f.view, liveReceiptSha256: null, chain: f.chain })).receipt).toBe('unknown');
    const noSigner = checkAttestation({ view: { ...f.view, publishedSigner: null, signerIsPublished: null }, liveReceiptSha256: SHA, chain: f.chain });
    expect(by(noSigner).signer).toBe('unknown');
    expect(summarise(noSigner).trusted).toBe(false);
  });

  it('fails loudly on a changed field, a forged signature, a foreign key, a receipt that moved and a wrong proof', async () => {
    const f = await fixture();
    const run = (v: Partial<View>, live: string | null = SHA, chain: ChainMemo | null = f.chain) => checkAttestation({ view: { ...f.view, ...v }, liveReceiptSha256: live, chain });
    const tampered = run({ attestation: { ...f.att, body: { ...f.att.body, receiptSha256: OTHER_SHA } } });
    expect(by(tampered).id).toBe('fail');
    expect(by(tampered).signature).toBe('pass'); // the signature is over the old id: the id check is what catches the edit
    expect(summarise(tampered).failed).toBe(true);
    expect(by(run({ attestation: { ...f.att, signature: '00'.repeat(64) } })).signature).toBe('fail');
    const other = await generateKeyPairSigner();
    expect(by(run({ attestation: { ...f.att, signer: other.address } })).signature).toBe('fail');
    expect(by(run({ publishedSigner: other.address, signerIsPublished: false })).signer).toBe('fail');
    expect(by(run({}, OTHER_SHA)).receipt).toBe('fail');
    expect(by(run({ anchor: { ...f.anchor, root: 'e'.repeat(64) } })).merkle).toBe('fail');
    expect(by(run({ anchor: { ...f.anchor, memo: 'opening-cross/receipts/v1 root=nope n=2' } })).chain).toBe('fail');
    expect(by(run({ anchor: { ...f.anchor, count: 3 } })).chain).toBe('fail'); // memo no longer follows from root and count
  });

  it('fails when the anchor transaction is missing, failed, carries another memo or was signed by another key', async () => {
    const f = await fixture();
    const chainFor = (c: ChainMemo) => by(checkAttestation({ view: f.view, liveReceiptSha256: SHA, chain: c })).chain;
    expect(chainFor({ found: false })).toBe('fail');
    expect(chainFor({ found: true, success: false, memos: [f.anchor.memo], signers: [f.att.signer], blockTime: BLOCK })).toBe('fail');
    expect(chainFor({ found: true, success: true, memos: ['something else'], signers: [f.att.signer], blockTime: BLOCK })).toBe('fail');
    expect(chainFor({ found: true, success: true, memos: [f.anchor.memo], signers: [(await generateKeyPairSigner()).address], blockTime: BLOCK })).toBe('fail');
    expect(chainFor({ found: true, success: true, memos: ['x', f.anchor.memo], signers: ['y', f.att.signer], blockTime: null })).toBe('pass');
  });

  it('has nothing to check without an attestation', () => {
    expect(checkAttestation({ view: { cluster: 'devnet', cross: CROSS, attestation: null }, liveReceiptSha256: SHA })).toEqual([]);
    expect(summarise([])).toEqual({ trusted: false, failed: false, anchored: false });
  });
});

describe('reading the anchor transaction', () => {
  const tx = (over: Record<string, unknown> = {}) => ({
    blockTime: BLOCK,
    meta: { err: null },
    transaction: { message: { accountKeys: [{ pubkey: 'Payer1111111111111111111111111111111111111', signer: true }, { pubkey: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', signer: false }], instructions: [{ program: 'spl-memo', parsed: 'the memo' }, { program: 'system', parsed: { type: 'transfer' } }] } },
    ...over,
  });
  it('returns the memo texts and the signers of a confirmed transaction', async () => {
    const seen: unknown[][] = [];
    const m = await readAnchorTransaction(async (method, params) => (seen.push([method, ...params]), tx()), 'SIG');
    expect(m).toEqual({ found: true, success: true, memos: ['the memo'], signers: ['Payer1111111111111111111111111111111111111'], blockTime: BLOCK });
    expect(seen[0]![0]).toBe('getTransaction');
    expect(await readAnchorTransaction(async () => null, 'SIG')).toEqual({ found: false });
    expect(await readAnchorTransaction(async () => tx({ meta: { err: { InstructionError: [0, 'x'] } } }), 'SIG')).toMatchObject({ success: false });
    await expect(readAnchorTransaction(async () => Promise.reject(new Error('429')), 'SIG')).rejects.toThrow('429');
  });
});
