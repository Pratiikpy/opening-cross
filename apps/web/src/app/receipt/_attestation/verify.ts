// Checking a receipt attestation without trusting the API that served it (row S2, ADR-0941). Every function here is pure or takes the one network call it needs as a parameter, so the same
// checks run in the page, in the JSON route and in the tests, and none of them believes a flag the document carries about itself.
import { createHash, createPublicKey, verify } from 'node:crypto';
import { canonicalJson } from '../../../lib/receipt';

export const ATTESTATION_SCHEMA = 'opening-cross/receipt-attestation/v1';
export const MEMO_PREFIX = 'opening-cross/receipts/v1';

export type Body = {
  schema: string;
  cluster: string;
  cross: string;
  receiptSchema: string;
  receiptSha256: string;
  state: string;
  statement: string;
};
export type Attestation = { body: Body; id: string; signer: string; signature: string };
export type ProofStep = { hash: string; side: 'L' | 'R' };
export type Anchor = { root: string; count: number; signature: string; slot: number | null; blockTime: number | null; memo: string; proof: ProofStep[] };
export type View = {
  cluster: string;
  cross: string;
  attestation: Attestation | null;
  note?: string;
  recordedAt?: number;
  attestations?: number;
  publishedSigner?: string | null;
  signerIsPublished?: boolean | null;
  anchor?: Anchor | null;
};

export type Verdict = 'pass' | 'fail' | 'unknown';
export type Check = { id: string; verdict: Verdict; label: string; detail: string };

const sha = (b: Uint8Array | string): Buffer => createHash('sha256').update(b).digest();
const HEX64 = /^[0-9a-f]{64}$/;
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** A Solana address as its 32 bytes, or null when it is not one. */
export function addressBytes(a: string): Buffer | null {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)) return null;
  let n = 0n;
  for (const c of a) n = n * 58n + BigInt(B58.indexOf(c));
  let zeros = 0;
  while (zeros < a.length && a[zeros] === '1') zeros += 1;
  const h = n.toString(16);
  const body = n === 0n ? Buffer.alloc(0) : Buffer.from(h.length % 2 === 1 ? `0${h}` : h, 'hex');
  const out = Buffer.concat([Buffer.alloc(zeros), body]);
  return out.length === 32 ? out : null;
}

const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');

/** Ed25519 verification of `signature` (lowercase hex) over `message` by the key an address names. */
export function verifySignature(signer: string, signature: string, message: string): boolean {
  const key = addressBytes(signer);
  if (!key || !/^[0-9a-f]{128}$/.test(signature)) return false;
  try {
    return verify(null, Buffer.from(message, 'utf8'), createPublicKey({ key: Buffer.concat([SPKI_ED25519, key]), format: 'der', type: 'spki' }), Buffer.from(signature, 'hex'));
  } catch {
    return false;
  }
}

/** The id of an attestation body: the SHA-256 of its canonical JSON. A body holds only strings, so this is the same text RFC 8785 gives. */
export const attestationId = (body: Body): string => sha(canonicalJson(body)).toString('hex');

/** Walks a Merkle proof from an attestation id to a root (leaf prefix 0x00, node prefix 0x01), as packages/promises/src/digest.ts builds it. */
export function proofReachesRoot(id: string, proof: readonly ProofStep[], root: string): boolean {
  if (!HEX64.test(id) || !HEX64.test(root)) return false;
  let h = sha(Buffer.concat([Buffer.from([0]), Buffer.from(id, 'hex')]));
  for (const step of proof) {
    if (!HEX64.test(step.hash) || (step.side !== 'L' && step.side !== 'R')) return false;
    const sib = Buffer.from(step.hash, 'hex');
    h = sha(Buffer.concat([Buffer.from([1]), step.side === 'L' ? sib : h, step.side === 'L' ? h : sib]));
  }
  return h.toString('hex') === root;
}

/** What the anchor transaction was read as on chain. `null` when it could not be read. */
export type ChainMemo = { found: true; success: boolean; memos: string[]; signers: string[]; blockTime: number | null } | { found: false };

/**
 * Reads a transaction from a Solana RPC and returns the Memo texts it carries and who signed it. `rpc` is a JSON-RPC caller; it throws when the endpoint cannot be reached, which the
 * caller reports as "could not be checked", never as a failure of the attestation.
 */
export async function readAnchorTransaction(rpc: (method: string, params: unknown[]) => Promise<unknown>, signature: string): Promise<ChainMemo> {
  type Tx = { blockTime: number | null; meta: { err: unknown } | null; transaction: { message: { accountKeys: { pubkey: string; signer: boolean }[]; instructions: { program?: string; parsed?: unknown }[] } } } | null;
  const tx = (await rpc('getTransaction', [signature, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }])) as Tx;
  if (!tx) return { found: false };
  const memos = tx.transaction.message.instructions.filter((i) => i.program === 'spl-memo' && typeof i.parsed === 'string').map((i) => i.parsed as string);
  return { found: true, success: tx.meta?.err === null, memos, signers: tx.transaction.message.accountKeys.filter((k) => k.signer).map((k) => k.pubkey), blockTime: tx.blockTime };
}

export type CheckInput = {
  view: View;
  /** The hash of the receipt the page is showing now, or null when it could not be built. */
  liveReceiptSha256: string | null;
  /** The anchor transaction as read from the chain; `undefined` when no read was attempted, `null` when it failed. */
  chain?: ChainMemo | null;
};

/**
 * Every check a reader can repeat, each with a verdict and a sentence. `pass` is never given for something that was not checked: a check that needs the chain says `unknown` until the chain
 * has been read. The attestation as a whole is trustworthy only when none fails and the first four pass.
 */
export function checkAttestation(i: CheckInput): Check[] {
  const a = i.view.attestation;
  if (!a) return [];
  const out: Check[] = [];
  const add = (id: string, verdict: Verdict, label: string, detail: string) => out.push({ id, verdict, label, detail });

  const idOk = attestationId(a.body) === a.id && a.body.schema === ATTESTATION_SCHEMA;
  add('id', idOk ? 'pass' : 'fail', 'The document is intact', idOk ? 'The id is the SHA-256 of the body as written, so no field was changed after signing.' : 'The id does not match the body: a field was changed after signing. Do not rely on this document.');

  const sigOk = verifySignature(a.signer, a.signature, `${a.body.schema}\n${a.id}`);
  add('signature', sigOk ? 'pass' : 'fail', 'The signature verifies', sigOk ? `The Ed25519 signature is valid for key ${a.signer}.` : 'The signature is not valid for the key it names.');

  const published = i.view.signerIsPublished;
  add(
    'signer',
    published === true ? 'pass' : published === false ? 'fail' : 'unknown',
    'The key is the one Opening Cross publishes',
    published === true ? 'It equals the signer the API publishes at /v1/promises/signer, the key that signs the accuracy record.' : published === false ? 'It is not the published signer: the signature only shows that someone holds this key.' : 'The API publishes no signer, so the key cannot be tied to Opening Cross.',
  );

  const same = i.liveReceiptSha256 === null ? null : i.liveReceiptSha256 === a.body.receiptSha256;
  add(
    'receipt',
    same === true ? 'pass' : same === false ? 'fail' : 'unknown',
    'It is the receipt shown on this page',
    same === true ? 'The attested hash equals the SHA-256 of the receipt this page was built from.' : same === false ? 'The receipt now served has a different hash from the one signed. The signed one existed and was checked; the page now shows something else.' : 'The receipt could not be built just now, so it could not be compared.',
  );

  const anchor = i.view.anchor ?? null;
  if (!anchor) {
    add('anchor', 'unknown', 'It is anchored on chain', 'Not yet: attestations are written to the chain in a batch every few minutes. Until then nothing bounds the time it was made.');
    return out;
  }
  const merkle = proofReachesRoot(a.id, anchor.proof, anchor.root);
  add('merkle', merkle ? 'pass' : 'fail', 'It is part of the anchored batch', merkle ? `A Merkle proof of ${anchor.proof.length} step${anchor.proof.length === 1 ? '' : 's'} leads from this attestation to the root ${anchor.root.slice(0, 12)}….` : 'The proof does not lead from this attestation to the root.');

  const expectedMemo = `${MEMO_PREFIX} root=${anchor.root} n=${anchor.count}`;
  if (anchor.memo !== expectedMemo) {
    add('chain', 'fail', 'The anchor transaction carries the root', 'The memo the API reports is not the one that follows from its own root and count.');
  } else if (i.chain === undefined || i.chain === null) {
    add('chain', 'unknown', 'The anchor transaction carries the root', 'The transaction could not be read from the chain just now. Open it in an explorer to check it yourself.');
  } else if (!i.chain.found) {
    add('chain', 'fail', 'The anchor transaction carries the root', 'No such transaction was found on the cluster.');
  } else {
    const carries = i.chain.success && i.chain.memos.includes(expectedMemo);
    const signed = i.chain.signers.includes(a.signer);
    const ok = carries && signed;
    add(
      'chain',
      ok ? 'pass' : 'fail',
      'The anchor transaction carries the root',
      ok
        ? `A confirmed transaction signed by the same key carries the memo${i.chain.blockTime ? `, in a block of ${new Date(i.chain.blockTime * 1000).toISOString().replace('T', ' ').slice(0, 19)} UTC` : ''}. This attestation existed no later than that.`
        : !i.chain.success
          ? 'The transaction failed on chain.'
          : !carries
            ? 'The transaction does not carry this memo.'
            : 'The transaction was not signed by the attestation’s key.',
    );
  }
  return out;
}

/** `trusted` only when nothing failed and the document, signature, key and receipt all passed; the chain anchor may still be pending or unreadable and the answer says so. */
export function summarise(checks: readonly Check[]): { trusted: boolean; failed: boolean; anchored: boolean } {
  const v = (id: string) => checks.find((c) => c.id === id)?.verdict;
  const failed = checks.some((c) => c.verdict === 'fail');
  return { trusted: !failed && (['id', 'signature', 'signer', 'receipt'] as const).every((id) => v(id) === 'pass'), failed, anchored: v('merkle') === 'pass' && v('chain') === 'pass' };
}
