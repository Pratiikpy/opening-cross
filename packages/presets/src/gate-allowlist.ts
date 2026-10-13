// The allowlist tree the cross_gate program verifies (`merkle` in programs/cross_gate/src/lib.rs):
//   leaf = sha256(0x00 || mint || owner)      node = sha256(0x01 || min(a, b) || max(a, b))
// Inner nodes are hashed over the byte-wise sorted pair, so a proof is only the list of sibling hashes. An odd node at any
// level is carried up unchanged. The program accepts proofs of at most 32 hashes.
import { sha256 } from '@noble/hashes/sha2.js';
import { type Address, getAddressEncoder, isAddress } from '@solana/kit';

const enc = getAddressEncoder();

export const MAX_PROOF_LENGTH = 32;

const cat = (...parts: readonly Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

export const toHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
export function fromHex(h: string): Uint8Array {
  if (!/^(?:[0-9a-fA-F]{2})*$/.test(h)) throw new Error('not a hex string');
  return Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
}

/** `sha256(0x00 || mint || owner)`: what `claim_pass_merkle` recomputes for the wallet receiving the pass. */
export function allowlistLeaf(mint: Address, owner: Address): Uint8Array {
  return sha256(cat(Uint8Array.of(0), new Uint8Array(enc.encode(mint)), new Uint8Array(enc.encode(owner))));
}

/** `sha256(0x01 || min || max)` over the two children in byte order. */
export function allowlistNode(a: Uint8Array, b: Uint8Array): Uint8Array {
  const [l, r] = compare(a, b) <= 0 ? [a, b] : [b, a];
  return sha256(cat(Uint8Array.of(1), l, r));
}

function compare(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return 0;
}

export type ParsedAllowlist = {
  /** Valid, unique addresses in the order first seen. */
  addresses: Address[];
  /** Entries that repeat an earlier one (kept once). */
  duplicates: string[];
  /** Entries that are not Solana addresses, with their 1-based position in the input. */
  invalid: { entry: string; position: number }[];
};

/** Splits pasted text (newlines, commas, spaces or semicolons) or a list into addresses; reports what it dropped and why. */
export function parseAllowlist(input: string | readonly string[]): ParsedAllowlist {
  const entries = (typeof input === 'string' ? input.split(/[\s,;]+/) : [...input]).map((e) => e.trim()).filter((e) => e.length > 0);
  const seen = new Set<string>();
  const out: ParsedAllowlist = { addresses: [], duplicates: [], invalid: [] };
  entries.forEach((entry, i) => {
    if (!isAddress(entry)) out.invalid.push({ entry, position: i + 1 });
    else if (seen.has(entry)) out.duplicates.push(entry);
    else {
      seen.add(entry);
      out.addresses.push(entry);
    }
  });
  return out;
}

export type Allowlist = {
  mint: Address;
  /** The 32-byte root to pass to `set_allowlist_root`. */
  root: Uint8Array;
  rootHex: string;
  count: number;
  /** Proof for a listed wallet (the sibling hashes `claim_pass_merkle` takes), or null if the wallet is not on the list. */
  proofFor(owner: Address): Uint8Array[] | null;
  has(owner: Address): boolean;
};

/**
 * Builds the tree for a mint. The leaves are sorted by hash, so the same set of addresses always gives the same root
 * whatever order the issuer pasted it in.
 */
export function buildAllowlist(mint: Address, addresses: readonly Address[]): Allowlist {
  const unique = [...new Set(addresses)];
  if (unique.length === 0) throw new Error('an allowlist needs at least one address');
  const leaves = unique.map((owner) => ({ owner, leaf: allowlistLeaf(mint, owner) })).sort((a, b) => compare(a.leaf, b.leaf));
  const levels: Uint8Array[][] = [leaves.map((l) => l.leaf)];
  while (levels[levels.length - 1]!.length > 1) {
    const cur = levels[levels.length - 1]!;
    const next: Uint8Array[] = [];
    for (let i = 0; i < cur.length; i += 2) next.push(i + 1 < cur.length ? allowlistNode(cur[i]!, cur[i + 1]!) : cur[i]!);
    levels.push(next);
  }
  if (levels.length - 1 > MAX_PROOF_LENGTH) throw new Error(`an allowlist this large needs a proof longer than ${MAX_PROOF_LENGTH} hashes`);
  const root = levels[levels.length - 1]![0]!;
  const index = new Map(leaves.map((l, i) => [l.owner as string, i]));
  return {
    mint,
    root,
    rootHex: toHex(root),
    count: unique.length,
    has: (owner) => index.has(owner),
    proofFor(owner) {
      let at = index.get(owner);
      if (at === undefined) return null;
      const proof: Uint8Array[] = [];
      for (let lvl = 0; lvl < levels.length - 1; lvl++) {
        const sibling = levels[lvl]![at ^ 1];
        if (sibling) proof.push(sibling);
        at >>= 1;
      }
      return proof;
    },
  };
}

/** Checks a proof the way the program does. */
export function verifyAllowlistProof(proof: readonly Uint8Array[], root: Uint8Array, leaf: Uint8Array): boolean {
  if (proof.length > MAX_PROOF_LENGTH) return false;
  const top = proof.reduce((acc, p) => allowlistNode(acc, p), leaf);
  return compare(top, root) === 0;
}
