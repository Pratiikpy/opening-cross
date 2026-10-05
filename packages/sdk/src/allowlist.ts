// Allowlist Merkle trees for cross_gate (`claim_pass_merkle`). Mirrors `cross_gate::merkle`:
// leaves are sha256(0x00 ‖ mint ‖ owner); inner nodes sha256(0x01 ‖ min ‖ max) over sorted pairs.
import { sha256 } from '@noble/hashes/sha2.js';
import { type Address, getAddressEncoder } from '@solana/kit';

const enc = getAddressEncoder();
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const cmp = (a: Uint8Array, b: Uint8Array) => { for (let i = 0; i < 32; i++) if (a[i] !== b[i]) return a[i]! - b[i]!; return 0; };

export function allowlistLeaf(mint: Address, owner: Address): Uint8Array {
  return sha256(cat(new Uint8Array([0]), enc.encode(mint) as Uint8Array, enc.encode(owner) as Uint8Array));
}

function node(a: Uint8Array, b: Uint8Array): Uint8Array {
  const [l, r] = cmp(a, b) <= 0 ? [a, b] : [b, a];
  return sha256(cat(new Uint8Array([1]), l, r));
}

/** Root plus a proof per owner. An odd node at any level is carried up unchanged. */
export function buildAllowlist(mint: Address, owners: Address[]): { root: Uint8Array; proofs: Map<Address, Uint8Array[]> } {
  if (owners.length === 0) throw new Error('empty allowlist');
  let level = owners.map((o) => ({ hash: allowlistLeaf(mint, o), members: [o] }));
  const proofs = new Map<Address, Uint8Array[]>(owners.map((o) => [o, []]));
  while (level.length > 1) {
    const next: typeof level = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i]!;
      const b = level[i + 1];
      if (!b) { next.push(a); continue; }
      for (const m of a.members) proofs.get(m)!.push(b.hash);
      for (const m of b.members) proofs.get(m)!.push(a.hash);
      next.push({ hash: node(a.hash, b.hash), members: [...a.members, ...b.members] });
    }
    level = next;
  }
  return { root: level[0]!.hash, proofs };
}
