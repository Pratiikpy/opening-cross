// The allowlist tree the cross_gate program verifies (`merkle` in programs/cross_gate/src/lib.rs):
//   leaf = sha256(0x00 || mint || owner)      node = sha256(0x01 || min(a, b) || max(a, b))
// Inner nodes are hashed over the byte-wise sorted pair, so a proof is only the list of sibling hashes. An odd node at any
// level is carried up unchanged. The program accepts proofs of at most 32 hashes.
//
// A second leaf kind carries a wallet's terms (`claim_pass_merkle_terms`, ADR-0900):
//   leaf = sha256(0x02 || mint || owner || identity || country u16 || tier u8 || flags u8 || cap u64 || expires i64)
// with the same inner nodes, so an inner node (0x01) is never a plain leaf (0x00) or a terms leaf (0x02).
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

type Keyed = { key: string; leaf: Uint8Array };
type Tree = { root: Uint8Array; levels: Uint8Array[][]; index: Map<string, number> };

/** Sorts the leaves by hash (so the root does not depend on input order) and builds every level. */
function buildTree(items: readonly Keyed[]): Tree {
  const leaves = [...items].sort((x, y) => compare(x.leaf, y.leaf));
  const levels: Uint8Array[][] = [leaves.map((l) => l.leaf)];
  while (levels[levels.length - 1]!.length > 1) {
    const cur = levels[levels.length - 1]!;
    const next: Uint8Array[] = [];
    for (let i = 0; i < cur.length; i += 2) next.push(i + 1 < cur.length ? allowlistNode(cur[i]!, cur[i + 1]!) : cur[i]!);
    levels.push(next);
  }
  if (levels.length - 1 > MAX_PROOF_LENGTH) throw new Error(`an allowlist this large needs a proof longer than ${MAX_PROOF_LENGTH} hashes`);
  return { root: levels[levels.length - 1]![0]!, levels, index: new Map(leaves.map((l, i) => [l.key, i])) };
}

function proofIn(tree: Tree, key: string): Uint8Array[] | null {
  let at = tree.index.get(key);
  if (at === undefined) return null;
  const proof: Uint8Array[] = [];
  for (let lvl = 0; lvl < tree.levels.length - 1; lvl++) {
    const sibling = tree.levels[lvl]![at ^ 1];
    if (sibling) proof.push(sibling);
    at >>= 1;
  }
  return proof;
}

/**
 * Builds the tree for a mint. The leaves are sorted by hash, so the same set of addresses always gives the same root
 * whatever order the issuer pasted it in.
 */
export function buildAllowlist(mint: Address, addresses: readonly Address[]): Allowlist {
  const unique = [...new Set(addresses)];
  if (unique.length === 0) throw new Error('an allowlist needs at least one address');
  const tree = buildTree(unique.map((owner) => ({ key: owner, leaf: allowlistLeaf(mint, owner) })));
  return {
    mint,
    root: tree.root,
    rootHex: toHex(tree.root),
    count: unique.length,
    has: (owner) => tree.index.has(owner),
    proofFor: (owner) => proofIn(tree, owner),
  };
}

/** What a pass carries (`TermsData` in the program), as the terms-bearing allowlist commits to it. */
export type GateTerms = {
  /** 32 opaque bytes, unique per person per attester (all zero = none). */
  identity: Uint8Array;
  /** ISO 3166-1 numeric (0 = unknown). */
  country: number;
  tier: number;
  flags: number;
  /** Quote atoms per cross (0 = the gate's default). */
  cap: bigint;
  /** Unix seconds the pass lapses at (0 = never). */
  expiresTs: bigint;
};

const le = (bytes: 2 | 8, v: bigint, signed = false): Uint8Array => {
  const out = new Uint8Array(bytes);
  const dv = new DataView(out.buffer);
  if (bytes === 2) dv.setUint16(0, Number(v), true);
  else if (signed) dv.setBigInt64(0, v, true);
  else dv.setBigUint64(0, v, true);
  return out;
};

/** `sha256(0x02 || mint || owner || identity || country || tier || flags || cap || expires)`: what `claim_pass_merkle_terms` recomputes. */
export function termsLeaf(mint: Address, owner: Address, t: GateTerms): Uint8Array {
  if (t.identity.length !== 32) throw new Error('identity must be 32 bytes');
  if (!Number.isInteger(t.country) || t.country < 0 || t.country > 999) throw new Error('country must be an ISO 3166-1 numeric code (0 to 999)');
  if (!Number.isInteger(t.tier) || t.tier < 0 || t.tier > 255 || !Number.isInteger(t.flags) || t.flags < 0 || t.flags > 255) throw new Error('tier and flags are one byte each');
  if (t.cap < 0n || t.cap > 0xffff_ffff_ffff_ffffn) throw new Error('cap must fit in a u64');
  return sha256(
    cat(Uint8Array.of(2), new Uint8Array(enc.encode(mint)), new Uint8Array(enc.encode(owner)), t.identity, le(2, BigInt(t.country)), Uint8Array.of(t.tier, t.flags), le(8, t.cap), le(8, t.expiresTs, true)),
  );
}

export type TermsAllowlistEntry = { owner: Address; terms: GateTerms };

export type TermsAllowlist = {
  mint: Address;
  root: Uint8Array;
  rootHex: string;
  count: number;
  /** The proof for a listed wallet (to submit with exactly the terms it was listed with), or null. */
  proofFor(owner: Address): Uint8Array[] | null;
  has(owner: Address): boolean;
};

/** The terms-bearing allowlist: the root for `set_rules` (`allowlistRoot`) and each wallet's proof. One entry per wallet. */
export function buildTermsAllowlist(mint: Address, entries: readonly TermsAllowlistEntry[]): TermsAllowlist {
  if (entries.length === 0) throw new Error('an allowlist needs at least one entry');
  const seen = new Set<string>();
  for (const e of entries) {
    if (seen.has(e.owner)) throw new Error(`${e.owner} is listed twice`);
    seen.add(e.owner);
  }
  const tree = buildTree(entries.map((e) => ({ key: e.owner, leaf: termsLeaf(mint, e.owner, e.terms) })));
  return { mint, root: tree.root, rootHex: toHex(tree.root), count: entries.length, has: (owner) => tree.index.has(owner), proofFor: (owner) => proofIn(tree, owner) };
}

/** Checks a proof the way the program does. */
export function verifyAllowlistProof(proof: readonly Uint8Array[], root: Uint8Array, leaf: Uint8Array): boolean {
  if (proof.length > MAX_PROOF_LENGTH) return false;
  const top = proof.reduce((acc, p) => allowlistNode(acc, p), leaf);
  return compare(top, root) === 0;
}
