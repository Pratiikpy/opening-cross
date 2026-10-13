import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { type Address, generateKeyPairSigner, getAddressEncoder, isAddress } from '@solana/kit';
import { GATE_PRESETS, gatePreset, missingForSelection } from '../src/gate.js';
import { allowlistLeaf, allowlistNode, buildAllowlist, parseAllowlist, toHex, verifyAllowlistProof } from '../src/gate-allowlist.js';

const wallets = async (n: number): Promise<Address[]> => Promise.all(Array.from({ length: n }, async () => (await generateKeyPairSigner()).address));
const MINT = '2pE7gApapcdmbk6713VbrWNjEg1iFFrd15SLt1pQwWqr' as Address;
const sha = (...p: Uint8Array[]) => createHash('sha256').update(Buffer.concat(p)).digest('hex');

describe('allowlist tree', () => {
  it('gives every listed wallet a proof the program-style verifier accepts, for every list size', async () => {
    for (const n of [1, 2, 3, 4, 5, 7, 8, 9, 33]) {
      const list = await wallets(n);
      const t = buildAllowlist(MINT, list);
      expect(t.count).toBe(n);
      for (const w of list) expect(verifyAllowlistProof(t.proofFor(w)!, t.root, allowlistLeaf(MINT, w))).toBe(true);
    }
  });

  it('a wallet that is not listed has no proof, and a listed proof does not work for another wallet or mint', async () => {
    const [a, b, c, outsider] = await wallets(4);
    const t = buildAllowlist(MINT, [a!, b!, c!]);
    expect(t.proofFor(outsider!)).toBeNull();
    expect(verifyAllowlistProof(t.proofFor(a!)!, t.root, allowlistLeaf(MINT, outsider!))).toBe(false);
    expect(verifyAllowlistProof(t.proofFor(a!)!, t.root, allowlistLeaf(outsider!, a!))).toBe(false);
  });

  it('the root does not depend on the order the addresses were given in', async () => {
    const list = await wallets(6);
    expect(buildAllowlist(MINT, list).rootHex).toBe(buildAllowlist(MINT, [...list].reverse()).rootHex);
  });

  it('a single address is its own root with an empty proof, as the program accepts', async () => {
    const [a] = await wallets(1);
    const t = buildAllowlist(MINT, [a!]);
    expect(t.proofFor(a!)).toEqual([]);
    expect(t.rootHex).toBe(toHex(allowlistLeaf(MINT, a!)));
  });

  it('leaf and node bytes match the Rust definition, recomputed here with Node crypto', async () => {
    const [a, b] = await wallets(2);
    const enc = getAddressEncoder();
    const la = allowlistLeaf(MINT, a!);
    const lb = allowlistLeaf(MINT, b!);
    expect(toHex(la)).toBe(sha(Uint8Array.of(0), enc.encode(MINT) as Uint8Array, enc.encode(a!) as Uint8Array));
    const [lo, hi] = Buffer.compare(la, lb) <= 0 ? [la, lb] : [lb, la];
    expect(toHex(allowlistNode(la, lb))).toBe(sha(Uint8Array.of(1), lo, hi));
    expect(toHex(allowlistNode(lb, la))).toBe(toHex(allowlistNode(la, lb)));
    // Two-wallet list: the root is that node, and an inner node is never also a leaf (0x00 vs 0x01 prefix).
    expect(buildAllowlist(MINT, [a!, b!]).rootHex).toBe(toHex(allowlistNode(la, lb)));
  });

  it('parses pasted text and reports invalid and repeated entries instead of silently dropping them', async () => {
    const [a, b] = await wallets(2);
    const p = parseAllowlist(`${a}\n${b}, ${a} ; not-an-address\n\n  `);
    expect(p.addresses).toEqual([a, b]);
    expect(p.duplicates).toEqual([a]);
    expect(p.invalid).toEqual([{ entry: 'not-an-address', position: 4 }]);
  });

  it('refuses an empty list', () => {
    expect(() => buildAllowlist(MINT, [])).toThrow(/at least one/);
  });
});

describe('gate presets', () => {
  it('are the three the console offers, each with plain text and no jurisdiction field', () => {
    expect(GATE_PRESETS.map((p) => p.id)).toEqual(['open', 'allowlist', 'attested-wallet']);
    for (const p of GATE_PRESETS) {
      expect(p.summary.length).toBeGreaterThan(20);
      expect(Object.keys(p).join(' ')).not.toMatch(/countr|jurisdiction|accredit|kyc/i);
    }
  });

  it('open creates no gate; the other two create a gated cross with a pass route', () => {
    expect(gatePreset('open')).toMatchObject({ gatedCross: false, mode: null, passRoute: 'none' });
    expect(gatePreset('allowlist')).toMatchObject({ gatedCross: true, mode: 'Allowlist', passRoute: 'allowlist-proof' });
    expect(gatePreset('attested-wallet')).toMatchObject({ gatedCross: true, mode: 'Allowlist', passRoute: 'sas-attestation' });
    expect(gatePreset('nope')).toBeNull();
  });

  it('names what is missing', () => {
    expect(missingForSelection({ preset: 'open' }, isAddress)).toEqual([]);
    expect(missingForSelection({ preset: 'allowlist' }, isAddress)).toHaveLength(2);
    expect(missingForSelection({ preset: 'allowlist', gateMint: MINT, allowlistRootHex: 'ab'.repeat(32) }, isAddress)).toEqual([]);
    expect(missingForSelection({ preset: 'attested-wallet', gateMint: MINT }, isAddress)).toHaveLength(1);
    expect(missingForSelection({ preset: 'attested-wallet', gateMint: MINT, sas: { credential: MINT, schema: MINT } }, isAddress)).toEqual([]);
  });
});
