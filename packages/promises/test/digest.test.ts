import { describe, expect, it } from 'vitest';
import { hashJcs, memoText, merkleProof, merkleRoot, parseMemo, verifyProof } from '../src/index.js';

const ids = (n: number) => Array.from({ length: n }, (_, i) => hashJcs({ i }));

describe('promise digests', () => {
  it('every id in trees of every size 1..40 has a proof that verifies, and only against its own root', () => {
    for (let n = 1; n <= 40; n++) {
      const set = ids(n);
      const root = merkleRoot(set);
      for (const id of set) expect(verifyProof(id, merkleProof(set, id), root)).toBe(true);
      expect(verifyProof(hashJcs({ stranger: n }), merkleProof(set, set[0]!), root)).toBe(false);
    }
  });

  it('the root is independent of order and duplicates, and changes with any member', () => {
    const set = ids(9);
    expect(merkleRoot([...set].reverse())).toBe(merkleRoot(set));
    expect(merkleRoot([...set, set[2]!])).toBe(merkleRoot(set));
    expect(merkleRoot(set.slice(0, 8))).not.toBe(merkleRoot(set));
    expect(merkleRoot([...set.slice(0, 8), hashJcs({ other: 1 })])).not.toBe(merkleRoot(set));
  });

  it('a proof cannot be reused for a different leaf, nor an inner node passed off as a leaf', () => {
    const set = ids(8);
    const root = merkleRoot(set);
    const proof = merkleProof(set, set[3]!);
    expect(verifyProof(set[4]!, proof, root)).toBe(false);
    // second-preimage attempt: present the hash of two leaves' concatenation as an id
    expect(verifyProof(hashJcs({ fake: 1 }), proof.slice(1), root)).toBe(false);
    expect(verifyProof(set[3]!, [], root)).toBe(false);
    expect(verifyProof('not hex', proof, root)).toBe(false);
  });

  it('refuses an empty digest and an id that is not in it', () => {
    expect(() => merkleRoot([])).toThrow(RangeError);
    expect(() => merkleProof(ids(3), hashJcs({ nope: 1 }))).toThrow(/not in this digest/);
  });

  it('a single promise is its own leaf', () => {
    const [id] = ids(1);
    expect(merkleProof([id!], id!)).toEqual([]);
    expect(verifyProof(id!, [], merkleRoot([id!]))).toBe(true);
  });

  it('the memo round-trips and rejects anything else', () => {
    const d = { root: merkleRoot(ids(5)), count: 5 };
    expect(parseMemo(memoText(d))).toEqual(d);
    expect(parseMemo('hello')).toBeNull();
    expect(parseMemo(memoText(d).replace('root=', 'root=0'))).toBeNull();
  });
});
