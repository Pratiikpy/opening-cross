// Anchoring. A signature proves who made a promise; it does not prove when. Without an anchor an
// operator could sign after the outcome and write an earlier issuedAt. So the ids of promises issued
// since the last anchor are folded into a Merkle root that is written to the chain in a Memo
// transaction: chain time then bounds the promise from above, and anyone can check inclusion with a
// short proof.
//
// Leaves and inner nodes are hashed under different prefixes (0x00 and 0x01), so an inner node can
// never be passed off as a leaf. An odd node is promoted unchanged, never duplicated, so a tree over
// n ids has exactly one shape and no id can be counted twice.
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, concatBytes, hexToBytes } from '@noble/hashes/utils.js';

export const MEMO_PREFIX = 'opening-cross/promises/v1';
export const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

const leafHash = (id: string): Uint8Array => sha256(concatBytes(new Uint8Array([0]), hexToBytes(id)));
const nodeHash = (l: Uint8Array, r: Uint8Array): Uint8Array => sha256(concatBytes(new Uint8Array([1]), l, r));

export interface ProofStep {
  /** Sibling hash, lowercase hex. */
  readonly hash: string;
  /** Which side the sibling is on. */
  readonly side: 'L' | 'R';
}

function levels(ids: readonly string[]): Uint8Array[][] {
  if (ids.length === 0) throw new RangeError('a digest needs at least one promise');
  const sorted = [...new Set(ids)].sort();
  const out: Uint8Array[][] = [sorted.map(leafHash)];
  while ((out.at(-1) as Uint8Array[]).length > 1) {
    const cur = out.at(-1) as Uint8Array[];
    const next: Uint8Array[] = [];
    for (let i = 0; i < cur.length; i += 2) next.push(i + 1 < cur.length ? nodeHash(cur[i] as Uint8Array, cur[i + 1] as Uint8Array) : (cur[i] as Uint8Array));
    out.push(next);
  }
  return out;
}

/** Merkle root over the (deduplicated, sorted) promise ids, lowercase hex. */
export function merkleRoot(ids: readonly string[]): string {
  return bytesToHex((levels(ids).at(-1) as Uint8Array[])[0] as Uint8Array);
}

/** Inclusion proof for `id` among `ids`. */
export function merkleProof(ids: readonly string[], id: string): ProofStep[] {
  const sorted = [...new Set(ids)].sort();
  let idx = sorted.indexOf(id);
  if (idx < 0) throw new RangeError('the id is not in this digest');
  const ls = levels(ids);
  const proof: ProofStep[] = [];
  for (let l = 0; l < ls.length - 1; l++) {
    const level = ls[l] as Uint8Array[];
    const sib = idx % 2 === 0 ? idx + 1 : idx - 1;
    if (sib < level.length) proof.push({ hash: bytesToHex(level[sib] as Uint8Array), side: idx % 2 === 0 ? 'R' : 'L' });
    idx = idx >> 1;
  }
  return proof;
}

export function verifyProof(id: string, proof: readonly ProofStep[], root: string): boolean {
  try {
    let h = leafHash(id);
    for (const step of proof) h = step.side === 'L' ? nodeHash(hexToBytes(step.hash), h) : nodeHash(h, hexToBytes(step.hash));
    return bytesToHex(h) === root;
  } catch {
    return false;
  }
}

export interface Digest {
  readonly root: string;
  readonly count: number;
}

export const memoText = (d: Digest): string => `${MEMO_PREFIX} root=${d.root} n=${d.count}`;

export function parseMemo(text: string): Digest | null {
  const m = /^opening-cross\/promises\/v1 root=([0-9a-f]{64}) n=(\d+)$/.exec(text);
  return m ? { root: m[1] as string, count: Number(m[2]) } : null;
}
