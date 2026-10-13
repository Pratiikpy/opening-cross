// The OCIP-1 specification (docs/spec/OCIP-1.md) is held to the code: every instruction, account type, event and error in the
// program IDLs must appear in it with its discriminator or code, the program ids must be the ones in Anchor.toml, the PDA seeds and
// numeric limits must be the ones in the program sources, and every number in the fenced `ocip:` blocks (worked examples, hash
// vectors, the promise vector, the sample fairness proof) must be reproduced by the code in packages/. Prose is not checked.
// Nothing here needs a validator, a database or LiteSVM; it reads files and runs pure functions, so it runs on Windows.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createKeyPairFromPrivateKeyBytes, getAddressFromPublicKey, getAddressDecoder, type Address } from '@solana/kit';
import { describe, expect, it } from 'vitest';
import { CrossKind, CrossState, Disclosure, NoPrintReason, SupplyMode, getCrossEncoder, getLevelsEncoder } from '@opening-cross/cross-core-client';
import { OrderSide, allowlistLeaf, orderCommitment, shardIndexFor } from '@opening-cross/sdk';
import { type ConformanceCase, bookAddressOf, referenceImplementation, runConformance, verifyCross, loadVectors, CONFORMANCE_SCHEMA, PROOF_SCHEMA } from '@opening-cross/verifier';
import {
  DEFAULT_POLICY,
  SIGNING_DOMAIN,
  type SignedPromise,
  canonicalize,
  hashJcs,
  indicativeTick,
  memoText,
  merkleRoot,
  parseMemo,
  policyHash,
  verifyPromiseId,
  verifyProof,
  verifySigned,
} from '@opening-cross/promises';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');
const SPEC = read('docs/spec/OCIP-1.md');
const SRFC = read('docs/spec/sRFC-0001-process.md');

// ---- reading the document -------------------------------------------------------------------------------------------------

function block<T>(name: string): T {
  const m = new RegExp('```json ocip:' + name + '\\n([\\s\\S]*?)\\n```').exec(SPEC);
  if (!m) throw new Error(`OCIP-1.md has no \`ocip:${name}\` block`);
  return JSON.parse(m[1]!) as T;
}

/** The text between `<!-- ocip:<kind> <args> -->` and the closing marker, or null. */
function marked(kind: string, args: string): string | null {
  const open = `<!-- ocip:${kind} ${args} -->\n`;
  const at = SPEC.indexOf(open);
  if (at < 0) return null;
  const end = SPEC.indexOf(`\n<!-- /ocip:${kind} -->`, at);
  return end < 0 ? null : SPEC.slice(at + open.length, end);
}

// ---- reading the IDLs -----------------------------------------------------------------------------------------------------

type IdlType = string | { array: [IdlType, number] } | { option: IdlType } | { vec: IdlType } | { defined: { name: string } };
type IdlAccountRef = { name: string; writable?: boolean; signer?: boolean; optional?: boolean };
type Idl = {
  address: string;
  instructions: { name: string; discriminator: number[]; accounts: IdlAccountRef[]; args: { name: string; type: IdlType }[] }[];
  accounts?: { name: string; discriminator: number[] }[];
  events?: { name: string; discriminator: number[] }[];
  errors?: { code: number; name: string; msg: string }[];
  types: { name: string; type: { kind: 'struct'; fields: { name: string; type: IdlType }[] } | { kind: 'enum'; variants: { name: string }[] } }[];
};
const loadIdl = (p: string) => JSON.parse(read(p)) as Idl;
const IDLS: Record<string, Idl> = {
  cross_core: loadIdl('idls/cross_core.json'),
  cross_gate: loadIdl('idls/cross_gate.json'),
  cross_settle: loadIdl('packages/cross-settle-client/idl/cross_settle.json'),
  cross_calendar: loadIdl('packages/cross-calendar-client/idl/cross_calendar.json'),
  treasury: loadIdl('idls/treasury.json'),
};
/** Programs whose own types the specification defines (cross_settle's types are Meteora's). */
const OWN_TYPES = ['cross_core', 'cross_gate', 'cross_calendar', 'treasury'];

const hex = (b: ArrayLike<number>) => Buffer.from(Array.from(b)).toString('hex');
const sha = (s: string | Buffer) => createHash('sha256').update(s).digest();
const disc8 = (s: string) => hex(sha(s).subarray(0, 8));

const typeName = (t: IdlType): string => {
  if (typeof t === 'string') return t === 'pubkey' ? 'Pubkey' : t;
  if ('array' in t) return `[${typeName(t.array[0])}; ${t.array[1]}]`;
  if ('option' in t) return `Option<${typeName(t.option)}>`;
  if ('vec' in t) return `Vec<${typeName(t.vec)}>`;
  return t.defined.name;
};
const flagsOf = (a: IdlAccountRef) => `${a.writable ? 'W' : ''}${a.signer ? 'S' : ''}${a.optional ? 'O' : ''}` || '–';

/** Borsh size of a type with every Option present; null when it contains a Vec. */
function sizeOf(t: IdlType, idl: Idl): number | null {
  if (typeof t === 'string') {
    const sizes: Record<string, number> = { bool: 1, u8: 1, i8: 1, u16: 2, i16: 2, u32: 4, i32: 4, u64: 8, i64: 8, u128: 16, i128: 16, pubkey: 32 };
    const n = sizes[t];
    if (n === undefined) throw new Error(`unsized ${t}`);
    return n;
  }
  if ('array' in t) {
    const n = sizeOf(t.array[0], idl);
    return n === null ? null : n * t.array[1];
  }
  if ('option' in t) {
    const n = sizeOf(t.option, idl);
    return n === null ? null : 1 + n;
  }
  if ('vec' in t) return null;
  const def = idl.types.find((x) => x.name === t.defined.name)!;
  if (def.type.kind === 'enum') return 1;
  let total = 0;
  for (const f of def.type.fields) {
    const n = sizeOf(f.type, idl);
    if (n === null) return null;
    total += n;
  }
  return total;
}

function sourceConsts(path: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of read(path).matchAll(/pub const ([A-Z_]+): (?:usize|u8|u16|u64|i64) = ([0-9_ *]+);/g)) {
    out[m[1]!] = m[2]!.split('*').reduce((a, x) => a * Number(x.trim().replaceAll('_', '')), 1);
  }
  return out;
}

// ---- the tests ------------------------------------------------------------------------------------------------------------

describe('OCIP-1 status and structure', () => {
  it('states the honest status', () => {
    expect(SPEC).toMatch(/Solana devnet only\. Nothing is deployed to mainnet\. There has been no external audit\./);
    expect(SPEC).toMatch(/No external audit/i);
    expect(SPEC).toMatch(/Single-key upgrade authority/);
    expect(SRFC).toMatch(/has not yet been used for a change/);
  });

  it('every § reference points at a heading that exists', () => {
    const headings = new Set([...SPEC.matchAll(/^#{2,4} (\d+(?:\.\d+)*)\.?\s/gm)].map((m) => m[1]!));
    expect(headings.size).toBeGreaterThan(40);
    const dangling = new Set<string>();
    for (const m of SPEC.matchAll(/§(\d+(?:\.\d+)*)/g)) if (!headings.has(m[1]!)) dangling.add(m[1]!);
    for (const m of SRFC.matchAll(/OCIP-1 §(\d+(?:\.\d+)*)/g)) if (!headings.has(m[1]!)) dangling.add(`sRFC: ${m[1]}`);
    expect([...dangling], 'section numbers cited but not defined').toEqual([]);
  });

  it('links and repository paths it names exist', () => {
    const missing: string[] = [];
    for (const [doc, text] of [['docs/spec/OCIP-1.md', SPEC], ['docs/spec/sRFC-0001-process.md', SRFC]] as const) {
      for (const m of text.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
        const target = m[1]!;
        if (/^[a-z]+:/.test(target)) continue;
        if (!existsSync(resolve(ROOT, dirname(doc), target))) missing.push(`${doc} -> ${target}`);
      }
      for (const m of text.matchAll(/`((?:docs|programs|packages|crates|services|tests|examples|apps|idls)\/[A-Za-z0-9_./-]+)`/g)) {
        const p = m[1]!.replace(/[.,:;]+$/, '');
        if (p.includes('*') || p.includes('<')) continue;
        if (!existsSync(resolve(ROOT, p))) missing.push(`${doc} names ${p}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('the sRFC process has the status values it says and is cited by the spec', () => {
    const statuses = JSON.parse(/```json ocip:srfc-statuses\n([\s\S]*?)\n```/.exec(SRFC)![1]!) as string[];
    expect(statuses).toEqual(['Draft', 'Review', 'Accepted', 'Final', 'Rejected', 'Withdrawn', 'Superseded']);
    for (const s of statuses) expect(SRFC).toContain(`| ${s} |`);
    expect(SPEC).toContain('sRFC-0001-process.md');
    expect(SRFC).toContain('tests/core/test/ocip-spec.test.ts');
  });
});

describe('OCIP-1 programs and constants', () => {
  it('program ids equal Anchor.toml (both clusters), declare_id! and the IDL address', () => {
    const programs = block<Record<string, string>>('programs');
    const toml = read('Anchor.toml');
    for (const cluster of ['localnet', 'devnet']) {
      const section = new RegExp(`\\[programs\\.${cluster}\\]([\\s\\S]*?)(\\n\\[|$)`).exec(toml)?.[1] ?? '';
      const ids = Object.fromEntries([...section.matchAll(/^(\w+)\s*=\s*"([1-9A-HJ-NP-Za-km-z]{32,44})"/gm)].map((m) => [m[1]!, m[2]!]));
      expect(Object.keys(ids).sort(), `${cluster} programs`).toEqual(['cross_calendar', 'cross_core', 'cross_gate', 'cross_settle', 'treasury']);
      for (const [name, id] of Object.entries(ids)) expect(programs[name], `${name} on ${cluster}`).toBe(id);
    }
    for (const name of Object.keys(IDLS)) {
      const src = read(`programs/${name}/src/lib.rs`);
      expect(src, `${name} declare_id!`).toContain(`declare_id!("${programs[name]}")`);
      expect(IDLS[name]!.address, `${name} IDL address`).toBe(programs[name]);
    }
    // The devnet-raydium build of cross_settle is a separate id behind a feature flag.
    expect(read('programs/cross_settle/src/lib.rs')).toContain(`declare_id!("${programs['cross_settle@devnet-raydium']}")`);
    expect(Object.keys(programs).sort()).toEqual(['cross_calendar', 'cross_core', 'cross_gate', 'cross_settle', 'cross_settle@devnet-raydium', 'treasury']);
  });

  it('the external program ids it names appear in the sources or IDLs that use them', () => {
    const external = block<Record<string, string>>('external-programs');
    const haystack = [
      'programs/cross_core/src/oracle.rs', 'programs/cross_gate/src/lib.rs', 'programs/cross_settle/src/lib.rs', 'crates/sas-attestation/src/lib.rs', 'packages/promises/src/digest.ts',
      'idls/dynamic_bonding_curve.json', 'idls/cp_amm.json', 'idls/lb_clmm.json', 'idls/raydium_cp_swap.json',
    ].map(read).join('\n');
    for (const [name, id] of Object.entries(external)) expect(haystack, name).toContain(id);
  });

  it('PDA seed constants equal the program sources, and every seed is in the table', () => {
    const seeds = block<Record<string, Record<string, string>>>('seeds');
    const files: Record<string, string[]> = {
      cross_core: ['programs/cross_core/src/state.rs'],
      cross_gate: ['programs/cross_gate/src/lib.rs'],
      cross_calendar: ['programs/cross_calendar/src/lib.rs'],
      cross_settle: ['programs/cross_settle/src/lib.rs'],
      treasury: ['programs/treasury/src/lib.rs'],
    };
    expect(Object.keys(seeds).sort()).toEqual(Object.keys(files).sort());
    for (const [prog, paths] of Object.entries(files)) {
      const found: Record<string, string> = {};
      for (const p of paths) for (const m of read(p).matchAll(/pub const ([A-Z_]+_SEED): &\[u8\] = b"([^"]*)";/g)) found[m[1]!] = m[2]!;
      expect(seeds[prog], `${prog} seeds`).toEqual(found);
      for (const value of Object.values(found)) expect(SPEC, `${prog} seed ${value}`).toContain(`\`"${value}"\``);
    }
  });

  it('numeric limits equal the sources', () => {
    const constants = block<Record<string, number>>('constants');
    const found = { ...sourceConsts('programs/cross_core/src/state.rs'), ...sourceConsts('programs/cross_calendar/src/lib.rs') };
    for (const [name, value] of Object.entries(constants)) expect(found[name], name).toBe(value);
  });
});

describe('OCIP-1 interface coverage against the IDLs', () => {
  it('lists every instruction with its discriminator, and explains each non-default one', () => {
    const explicit = block<Record<string, string[]>>('explicit-discriminators');
    for (const [prog, idl] of Object.entries(IDLS)) {
      const nonDefault: string[] = [];
      for (const ix of idl.instructions) {
        const dflt = disc8(`global:${ix.name}`) === hex(ix.discriminator);
        if (!dflt) nonDefault.push(ix.name);
        const row = `| \`${prog}\` | \`${ix.name}\` | \`${hex(ix.discriminator)}\` | ${dflt ? 'Anchor default' : 'explicit'} |`;
        expect(SPEC, `${prog}.${ix.name}`).toContain(row);
      }
      expect(nonDefault.sort(), `${prog} explicit discriminators`).toEqual([...(explicit[prog] ?? [])].sort());
    }
  });

  it('lists every account type with its discriminator and allocated size', () => {
    const calendar = sourceConsts('programs/cross_calendar/src/lib.rs');
    const sessions = 4 + 16 * calendar.MAX_SESSIONS!;
    const feeds = 4 + 32 * calendar.MAX_FEEDS!;
    for (const [prog, idl] of Object.entries(IDLS)) {
      for (const a of idl.accounts ?? []) {
        expect(hex(a.discriminator), `${a.name} discriminator`).toBe(disc8(`account:${a.name}`));
        let size: number;
        if (a.name === 'Calendar') size = 8 + 32 + 8 + 8 + sessions + feeds + (1 + sessions + feeds + 8) + (1 + 32 + 8) + 1;
        else {
          size = 8;
          const def = idl.types.find((t) => t.name === a.name)!;
          if (def.type.kind !== 'struct') throw new Error('account is not a struct');
          for (const f of def.type.fields) size += sizeOf(f.type, idl)!;
        }
        expect(SPEC, `${prog}.${a.name}`).toContain(`| \`${prog}\` | \`${a.name}\` | \`${hex(a.discriminator)}\` | ${size} |`);
      }
    }
  });

  it('lists the fields of every account in order', () => {
    for (const prog of OWN_TYPES) {
      const idl = IDLS[prog]!;
      for (const a of idl.accounts ?? []) {
        const text = marked('account', a.name);
        expect(text, `${a.name} field table`).not.toBeNull();
        const rows = [...text!.matchAll(/^\| (\d+) \| `([^`]+)` \| `([^`]+)` \|/gm)].map((m) => [m[2]!, m[3]!]);
        const def = idl.types.find((t) => t.name === a.name)!;
        if (def.type.kind !== 'struct') throw new Error('account is not a struct');
        expect(rows, a.name).toEqual(def.type.fields.map((f) => [f.name, typeName(f.type)]));
      }
    }
  });

  it('defines every enumeration with its variant indices', () => {
    for (const prog of OWN_TYPES) {
      for (const t of IDLS[prog]!.types) {
        if (t.type.kind !== 'enum') continue;
        const line = `- \`${t.name}\`: ` + t.type.variants.map((v, i) => `${i} \`${v.name}\``).join(', ');
        expect(SPEC, `${prog}.${t.name}`).toContain(line);
      }
    }
  });

  it('mentions every type the four own programs define', () => {
    const missing: string[] = [];
    for (const prog of OWN_TYPES) {
      for (const t of IDLS[prog]!.types) {
        const named = new RegExp('`[^`\\n]*\\b' + t.name + '\\b[^`\\n]*`').test(SPEC);
        if (!named) missing.push(`${prog}.${t.name}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('gives the accounts, flags and arguments of every cross_core and cross_settle instruction', () => {
    for (const prog of ['cross_core', 'cross_settle']) {
      for (const ix of IDLS[prog]!.instructions) {
        const text = marked('ix', `${prog} ${ix.name}`);
        expect(text, `${prog}.${ix.name} account table`).not.toBeNull();
        const args = ix.args.length ? ix.args.map((a) => `\`${a.name}: ${typeName(a.type)}\``).join(', ') : 'none';
        expect(text, `${ix.name} arguments`).toContain(`Arguments: ${args}.`);
        expect(text, `${ix.name} discriminator`).toContain(`\`${hex(ix.discriminator)}\``);
        const full = [...text!.matchAll(/^\| (\d+) \| `(\w+)` \| (\S+) \|/gm)].map((m) => [m[2]!, m[3]!]);
        if (full.length > 0) {
          expect(full, `${ix.name} accounts`).toEqual(ix.accounts.map((a) => [a.name, flagsOf(a)]));
        } else {
          const list = /Accounts in order: (.*)\.$/m.exec(text!)![1]!;
          const compact = [...list.matchAll(/`(\w+)`(?: \((\w+)\))?/g)].map((m) => [m[1]!, m[2] ?? '–']);
          expect(compact, `${ix.name} accounts`).toEqual(ix.accounts.map((a) => [a.name, flagsOf(a)]));
        }
      }
    }
  });

  it('argument and nested types used by instructions are tabulated', () => {
    for (const name of ['CreateCrossParams', 'CommitOrderArgs', 'SupplyLevel', 'OracleGuard', 'ClearingSummary', 'TreasuryParams']) {
      const prog = name === 'TreasuryParams' ? 'treasury' : 'cross_core';
      const def = IDLS[prog]!.types.find((t) => t.name === name)!;
      if (def.type.kind !== 'struct') throw new Error('not a struct');
      const text = marked('struct', name);
      expect(text, name).not.toBeNull();
      const rows = [...text!.matchAll(/^\| `([^`]+)` \| `([^`]+)` \|$/gm)].map((m) => [m[1]!, m[2]!]);
      expect(rows, name).toEqual(def.type.fields.map((f) => [f.name, typeName(f.type)]));
    }
  });

  it('lists every event with its discriminator and fields', () => {
    for (const [prog, idl] of Object.entries(IDLS)) {
      const text = marked('events', prog);
      expect(text, `${prog} events`).not.toBeNull();
      const rows = new Map([...text!.matchAll(/^\| `(\w+)` \| `([0-9a-f]{16})` \| (.*) \|$/gm)].map((m) => [m[1]!, { disc: m[2]!, fields: m[3]! }]));
      expect([...rows.keys()].sort(), `${prog} event names`).toEqual((idl.events ?? []).map((e) => e.name).sort());
      for (const e of idl.events ?? []) {
        expect(hex(e.discriminator), `${e.name} discriminator`).toBe(disc8(`event:${e.name}`));
        const def = idl.types.find((t) => t.name === e.name)!;
        if (def.type.kind !== 'struct') throw new Error('event is not a struct');
        expect(rows.get(e.name), `${prog}.${e.name}`).toEqual({ disc: hex(e.discriminator), fields: def.type.fields.map((f) => `\`${f.name}: ${typeName(f.type)}\``).join(', ') });
      }
    }
  });

  it('lists every error code, name and message', () => {
    for (const [prog, idl] of Object.entries(IDLS)) {
      const text = marked('errors', prog);
      expect(text, `${prog} errors`).not.toBeNull();
      const rows = [...text!.matchAll(/^\| (\d+) \| `(\w+)` \| (.*) \|$/gm)].map((m) => ({ code: Number(m[1]), name: m[2]!, msg: m[3]! }));
      expect(rows, prog).toEqual((idl.errors ?? []).map((e) => ({ code: e.code, name: e.name, msg: e.msg })));
    }
  });
});

// ---- worked examples ------------------------------------------------------------------------------------------------------

type Economics = {
  priceScale: string;
  kind: string;
  supplyMode: 'escrow' | 'mint';
  protocolScheduleBps: number[];
  integratorFeeBps: number;
  protocolFeeBps: number;
  maxOrders: number;
  dustBond: string;
  orders: Record<string, unknown>[];
  totals: Record<string, string>;
  finalize: Record<string, string>;
};
type Example = { id: string; title: string; case: ConformanceCase; economics: Economics | null };

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/** The payments of §7.5 and §7.6, written from the specification text. */
function economicsOf(c: ConformanceCase, e: Economics): Economics {
  if (!c.expect.printed) throw new Error('not printed');
  const scale = BigInt(e.priceScale);
  const P = BigInt(c.expect.price);
  const kindIndex = ['Launch', 'Reopen', 'Tender', 'Recurring'].indexOf(e.kind);
  const protocolBps = Math.min(e.protocolScheduleBps[kindIndex]!, Math.floor(e.integratorFeeBps / 4));
  const totalBps = BigInt(protocolBps + e.integratorFeeBps);
  const maxPrice = BigInt(c.grid.min) + BigInt(c.grid.ticks - 1) * BigInt(c.grid.tick);
  const bond = ceilDiv(BigInt(e.maxOrders) * maxPrice, scale);
  let buyerPaid = 0n, baseBought = 0n, baseSold = 0n, sellerPaid = 0n, feesAccrued = 0n;
  const orders = c.orders.map((o, i) => {
    const fill = BigInt(c.expect.printed ? c.expect.fills[i]! : '0');
    const q = BigInt(o.quantity);
    if (o.side === 'buy') {
      const escrow = ceilDiv(q * BigInt(o.price), scale);
      const pays = ceilDiv(fill * P, scale);
      buyerPaid += pays;
      baseBought += fill;
      return { side: 'buy', fill: String(fill), escrowQuote: String(escrow), pays: String(pays), refundQuote: String(escrow - pays), receivesBase: String(fill) };
    }
    if (e.supplyMode === 'mint') return { side: 'sell', schedule: true };
    const gross = (fill * P) / scale;
    const fee = (gross * totalBps) / 10000n;
    baseSold += fill;
    sellerPaid += gross;
    feesAccrued += fee;
    return { side: 'sell', fill: String(fill), escrowBase: String(q), grossQuote: String(gross), feeQuote: String(fee), receivesQuote: String(gross - fee), returnedBase: String(q - fill) };
  });
  const fees = e.supplyMode === 'mint' ? (buyerPaid * totalBps) / 10000n : feesAccrued;
  const protocolFee = totalBps === 0n ? 0n : (fees * BigInt(protocolBps)) / totalBps;
  return {
    ...e,
    protocolFeeBps: protocolBps,
    dustBond: String(bond),
    orders,
    totals: { buyerPaid: String(buyerPaid), baseBought: String(baseBought), baseSold: String(baseSold), sellerPaid: String(sellerPaid), feesAccrued: String(feesAccrued) },
    finalize: {
      protocolFee: String(protocolFee),
      integratorFee: String(fees - protocolFee),
      proceedsQuote: String(e.supplyMode === 'mint' ? bond + buyerPaid - fees : bond + buyerPaid - sellerPaid),
      dustBase: String(e.supplyMode === 'mint' ? 0n : baseSold - baseBought),
    },
  };
}

describe('OCIP-1 worked examples (§7.9)', () => {
  const { schema, examples } = block<{ schema: string; examples: Example[] }>('examples');

  it('are in the declared format and cover each rule', () => {
    expect(schema).toBe('opening-cross/ocip-examples/v1');
    expect(examples.map((x) => x.id)).toEqual(['E1', 'E2', 'E3a', 'E3b', 'E4a', 'E4b', 'E4c', 'E5']);
    const reasons = examples.flatMap((x) => (x.case.expect.printed ? [] : [x.case.expect.noPrintReason])).sort();
    expect(reasons).toEqual(['BelowMinimumVolume', 'ImbalanceTooHigh', 'NoCross']);
  });

  it('clearing, rationing and guards equal the independent reference implementation (and its conformance runner)', () => {
    const cases = examples.map((x) => x.case);
    expect(runConformance({ schema: CONFORMANCE_SCHEMA, cases } as never, referenceImplementation)).toEqual([]);
    // A runner that accepts everything would also return []: confirm it can fail on these exact cases.
    const wrong = runConformance({ schema: CONFORMANCE_SCHEMA, cases } as never, (c) => ({ ...(referenceImplementation(c) as object), price: '1' }) as never);
    expect(wrong.length).toBeGreaterThan(0);
  });

  it('payments, fees, dust and proceeds equal the formulas of §7.5 and §7.6', () => {
    const withMoney = examples.filter((x) => x.economics);
    expect(withMoney.map((x) => x.id)).toEqual(['E1', 'E2']);
    for (const x of withMoney) expect(x.economics, x.id).toEqual(economicsOf(x.case, x.economics!));
  });

  it('the numbers quoted in the prose are the ones in the examples', () => {
    const [e1, e2] = [examples[0]!, examples[1]!];
    expect(e1.case.expect).toMatchObject({ price: '900000', matched: '600000000', rationed: 'buy' });
    expect(e1.case.expect.printed && e1.case.expect.fills.slice(-2)).toEqual(['51375000', '98624999']);
    expect(e1.economics!.totals.baseBought).toBe('599999999');
    expect(e1.economics!.protocolFeeBps).toBe(25);
    expect(e1.economics!.finalize).toMatchObject({ protocolFee: '1350000', integratorFee: '5400000' });
    expect(e2.case.expect).toMatchObject({ price: '100', matched: '12', rationed: 'sell' });
    expect(e2.economics!.totals).toMatchObject({ baseSold: '13', baseBought: '12', feesAccrued: '13' });
    expect(e2.economics!.finalize).toMatchObject({ protocolFee: '0', integratorFee: '13', dustBase: '1' });
    expect(e2.economics!.dustBond).toBe('11000');
    const price = (id: string) => (examples.find((x) => x.id === id)!.case.expect as { price: string }).price;
    expect([price('E3a'), price('E3b')]).toEqual(['100', '110']);
  });
});

// ---- hash vectors ---------------------------------------------------------------------------------------------------------

type Hashes = {
  commit: { cross: Address; owner: Address; nonce: string; side: string; price: string; quantity: string; saltHex: string; crossHex: string; ownerHex: string; commitmentHex: string };
  shard: { owner: Address; nonce: string; shards: number; index: number }[];
  leaf: { mint: Address; owner: Address; mintHex: string; ownerHex: string; leafHex: string };
};
const le64 = (n: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
};

describe('OCIP-1 hash vectors (§8)', () => {
  const h = block<Hashes>('hashes');

  it('the commitment is the SHA-256 of the 121-byte preimage of §8.2, and equals the SDK', () => {
    const c = h.commit;
    const preimage = Buffer.concat([Buffer.from(c.crossHex, 'hex'), Buffer.from(c.ownerHex, 'hex'), le64(BigInt(c.nonce)), Buffer.from([c.side === 'buy' ? 0 : 1]), le64(BigInt(c.price)), le64(BigInt(c.quantity)), Buffer.from(c.saltHex, 'hex')]);
    expect(preimage.length).toBe(121);
    expect(hex(sha(preimage))).toBe(c.commitmentHex);
    const addr = (x: string) => getAddressDecoder().decode(Buffer.from(x, 'hex')) as Address;
    expect(addr(c.crossHex)).toBe(c.cross);
    expect(addr(c.ownerHex)).toBe(c.owner);
    const side = c.side === 'buy' ? OrderSide.Buy : OrderSide.Sell;
    expect(hex(orderCommitment(c.cross, c.owner, BigInt(c.nonce), side, BigInt(c.price), BigInt(c.quantity), Buffer.from(c.saltHex, 'hex')))).toBe(c.commitmentHex);
  });

  it('shard assignment is u32_le(SHA-256(owner || nonce_le8)[0..4]) mod shards, and equals the SDK', () => {
    expect(h.shard.length).toBeGreaterThanOrEqual(5);
    for (const s of h.shard) {
      const ownerBytes = Buffer.from(h.commit.ownerHex, 'hex');
      expect(s.owner).toBe(h.commit.owner);
      const d = sha(Buffer.concat([ownerBytes, le64(BigInt(s.nonce))]));
      expect(d.readUInt32LE(0) % s.shards, `nonce ${s.nonce}`).toBe(s.index);
      expect(shardIndexFor(s.owner, BigInt(s.nonce), s.shards)).toBe(s.index);
    }
  });

  it('the allowlist leaf is SHA-256(0x00 || mint || owner), and equals the SDK', () => {
    const l = h.leaf;
    expect(hex(sha(Buffer.concat([Buffer.from([0]), Buffer.from(l.mintHex, 'hex'), Buffer.from(l.ownerHex, 'hex')])))).toBe(l.leafHex);
    expect(hex(allowlistLeaf(l.mint, l.owner))).toBe(l.leafHex);
  });
});

describe('OCIP-1 settlement vectors (§9)', () => {
  const v = block<{ sqrtPriceQ64: { price: string; priceScale: string; sqrtPriceQ64: string }[]; depositMatchesPrice: { baseAmount: string; quoteAmount: string; price: string; priceScale: string; matches: boolean }[] }>('settle-vectors');

  it('sqrt_price_q64 is floor(sqrt(floor(price * 2^128 / scale)))', () => {
    const isqrt = (n: bigint): bigint => {
      if (n < 2n) return n;
      let x = 1n << BigInt(Math.ceil(n.toString(2).length / 2));
      for (;;) {
        const y = (x + n / x) >> 1n;
        if (y >= x) return x;
        x = y;
      }
    };
    for (const s of v.sqrtPriceQ64) {
      const r = isqrt((BigInt(s.price) << 128n) / BigInt(s.priceScale));
      expect(String(r)).toBe(s.sqrtPriceQ64);
      const x = (BigInt(s.price) << 128n) / BigInt(s.priceScale);
      expect(r * r <= x && (r + 1n) * (r + 1n) > x).toBe(true);
    }
    // The values the Rust unit test asserts: price 1 -> 2^64, price 4 -> 2 * 2^64.
    expect(v.sqrtPriceQ64.find((s) => s.price === '1')?.sqrtPriceQ64).toBe(String(1n << 64n));
    expect(v.sqrtPriceQ64.find((s) => s.price === '4')?.sqrtPriceQ64).toBe(String(2n << 64n));
  });

  it('deposit_matches_price accepts exactly the floor and the ceiling of base * P* / scale', () => {
    for (const d of v.depositMatchesPrice) {
      const exact = BigInt(d.baseAmount) * BigInt(d.price);
      const scale = BigInt(d.priceScale);
      const lo = exact / scale;
      const hi = ceilDiv(exact, scale);
      const q = BigInt(d.quoteAmount);
      expect(q >= lo && q <= hi).toBe(d.matches);
    }
  });
});

// ---- promises --------------------------------------------------------------------------------------------------------------

type PromiseVector = {
  seedHex: string;
  signer: string;
  signingDomain: string;
  inputs: { grid: { minPrice: string; tick: string; ticks: number; priceScale: string }; referenceTick: number | null; levels: [number, string, string][] };
  canonicalBody: string;
  signed: SignedPromise;
  digest: { ids: string[]; root: string; memo: string; proofForSecond: { hash: string; side: 'L' | 'R' }[] };
};

describe('OCIP-1 promise vector (§15)', () => {
  const v = block<PromiseVector>('promise-vector');
  const p = v.signed.promise;

  it('the id is the SHA-256 of the canonical body, and the canonical body is the JCS form', () => {
    const { id, ...body } = p;
    expect(canonicalize(body as never)).toBe(v.canonicalBody);
    expect(hex(sha(v.canonicalBody))).toBe(id);
    expect(verifyPromiseId(p)).toBe(true);
    expect(v.signingDomain).toBe(SIGNING_DOMAIN);
    expect(SIGNING_DOMAIN).toBe('opening-cross/promise/v1\n');
  });

  it('the signature verifies for the signer, which is the address of the published test key; tampering and a wrong signer are caught', async () => {
    expect(await verifySigned(v.signed, v.signer)).toEqual({ ok: true });
    const kp = await createKeyPairFromPrivateKeyBytes(Uint8Array.from(Buffer.from(v.seedHex, 'hex')));
    expect(await getAddressFromPublicKey(kp.publicKey)).toBe(v.signer);
    expect(v.signed.signature).toMatch(/^[0-9a-f]{128}$/);
    const altered = { ...v.signed, promise: { ...p, issuedAt: p.issuedAt + 1 } };
    expect(await verifySigned(altered, v.signer)).toEqual({ ok: false, reason: 'ID_MISMATCH' });
    const wrong = await getAddressFromPublicKey((await createKeyPairFromPrivateKeyBytes(new Uint8Array(32).fill(7))).publicKey);
    expect(await verifySigned(v.signed, wrong)).toEqual({ ok: false, reason: 'WRONG_SIGNER' });
  });

  it('the inputs hash to inputsHash and give the claimed point, and the policy hash is the default policy', () => {
    expect(hashJcs(v.inputs as never)).toBe(p.inputsHash);
    const buy = new Array<bigint>(v.inputs.grid.ticks).fill(0n);
    const sell = new Array<bigint>(v.inputs.grid.ticks).fill(0n);
    for (const [t, b, s] of v.inputs.levels) {
      buy[t] = BigInt(b);
      sell[t] = BigInt(s);
    }
    expect(indicativeTick({ grid: v.inputs.grid, buy, sell, referenceTick: v.inputs.referenceTick })).toBe(p.claim.pointTick);
    expect(policyHash(DEFAULT_POLICY)).toBe(p.policyHash);
    expect(DEFAULT_POLICY).toEqual({ nominalCoverageBps: 9000, minCalibrationSamples: 30, minDistinctDays: 2, minHeldOutSamples: 20, bucketBoundsBps: [3333, 6667] });
    expect(p.claim.status).toBe('PROVISIONAL');
    expect(p.claim.nominalCoverageBps).toBeNull();
    expect([p.claim.loTick, p.claim.pointTick, p.claim.hiTick]).toEqual([p.claim.pointTick, p.claim.pointTick, p.claim.pointTick]);
  });

  it('the anchor digest, memo and inclusion proof are reproduced', () => {
    expect(merkleRoot(v.digest.ids)).toBe(v.digest.root);
    expect(memoText({ root: v.digest.root, count: v.digest.ids.length })).toBe(v.digest.memo);
    expect(parseMemo(v.digest.memo)).toEqual({ root: v.digest.root, count: 3 });
    expect(verifyProof(v.digest.ids[1]!, v.digest.proofForSecond, v.digest.root)).toBe(true);
    expect(verifyProof(v.digest.ids[0]!, v.digest.proofForSecond, v.digest.root)).toBe(false);
  });
});

// ---- the fairness proof ---------------------------------------------------------------------------------------------------

const DUMMY = getAddressDecoder().decode(new Uint8Array(32).fill(9)) as Address;
const TOKENKEG = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' as Address;
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' as Address;

type Level = { price: bigint; buy: bigint; sell: bigint; buyOrders: number; sellOrders: number };
type OnChain = {
  state: CrossState;
  clearing: { price: bigint; matched: bigint; demand: bigint; supply: bigint; rationed: number } | null;
  noPrintReason: NoPrintReason | null;
  minMatched?: bigint;
  maxImbalanceBps?: number | null;
  referencePrice?: bigint | null;
  oracle?: boolean;
};

/** Encodes a cross and its book as the program would store them, then runs the verifier over them. */
async function proofFor(cross: Address, levels: Level[], c: OnChain) {
  const minPrice = 1_000_000n;
  const tick = 50_000n;
  const encoded = getCrossEncoder().encode({
    creator: DUMMY, crossId: 1n, kind: CrossKind.Launch, supplyMode: SupplyMode.Mint, disclosure: Disclosure.Open, state: c.state,
    baseMint: DUMMY, quoteMint: DUMMY, baseTokenProgram: TOKEN_2022, quoteTokenProgram: TOKENKEG, baseDecimals: 6, quoteDecimals: 6, proceedsTo: DUMMY,
    minPrice, tick, ticks: 40, priceScale: 1_000_000n, openTs: 0n, closeTs: 0n, revealEndTs: 0n, referencePrice: c.referencePrice ?? null, minMatched: c.minMatched ?? 0n,
    maxImbalanceBps: c.maxImbalanceBps ?? null, protocolFeeBps: 0, integratorFeeBps: 0, integrator: DUMMY, feeRecipient: DUMMY, gateMint: null, shards: 1, maxOrders: 1000, dustBond: 0n,
    ordersTotal: 1, ordersOpen: 0, mergedMask: 1,
    clearing: c.clearing && { ...c.clearing, marginalQuantity: 0n, marginalRemaining: 0n, marginalOrders: 0 },
    noPrintReason: c.noPrintReason, buyerPaid: 0n, baseBought: 0n, baseSold: 0n, sellerPaid: 0n, feesAccrued: 0n,
    oracle: c.oracle ? { feedId: new Uint8Array(32), maxDivergenceBps: 100, maxStalenessSecs: 60 } : null, calendar: null, settler: null, settleDeadlineTs: 0n, baseBound: true,
    bump: 255, quoteVaultBump: 255, baseVaultBump: 255, bookBump: 255,
  } as never);
  const buy = new Array<bigint>(256).fill(0n);
  const sell = new Array<bigint>(256).fill(0n);
  const buyOrders = new Array<number>(256).fill(0);
  const sellOrders = new Array<number>(256).fill(0);
  for (const l of levels) {
    const i = Number((l.price - minPrice) / tick);
    buy[i] = l.buy;
    sell[i] = l.sell;
    buyOrders[i] = l.buyOrders;
    sellOrders[i] = l.sellOrders;
  }
  const book = getLevelsEncoder().encode({ cross: DUMMY, buy, sell, buyOrders, sellOrders, index: 0, pad: new Uint8Array(7) });
  const bookAddress = await bookAddressOf(cross);
  return verifyCross(async (a) => (a === cross ? new Uint8Array(encoded) : a === bookAddress ? new Uint8Array(book) : null), cross);
}

// 10 tokens sold at 1.20, 4 bought at 1.30: volume 4 at every price from 1.20 to 1.30, so the lowest price, 1.20, clears.
const SMALL_BOOK: Level[] = [
  { price: 1_200_000n, buy: 0n, sell: 10n, buyOrders: 0, sellOrders: 1 },
  { price: 1_300_000n, buy: 4n, sell: 0n, buyOrders: 1, sellOrders: 0 },
];
const PRINTED = { price: 1_200_000n, matched: 4n, demand: 4n, supply: 10n, rationed: 2 };

describe('OCIP-1 fairness proof (§13)', () => {
  const sample = block<{ schema: string; cross: Address; book: { price: string; buy: string; sell: string; buyOrders: number; sellOrders: number }[] } & Record<string, unknown>>('proof-sample');

  it('the sample proof is exactly what the verifier emits for accounts holding the sample book', async () => {
    const levels = sample.book.map((l) => ({ price: BigInt(l.price), buy: BigInt(l.buy), sell: BigInt(l.sell), buyOrders: l.buyOrders, sellOrders: l.sellOrders }));
    const proof = await proofFor(sample.cross, levels, { state: CrossState.Finalized, clearing: { price: 1_200_000n, matched: 600_000_000n, demand: 600_000_000n, supply: 1_000_000_000n, rationed: 2 }, noPrintReason: null });
    expect(JSON.parse(JSON.stringify(proof))).toEqual(sample);
    expect(proof.schema).toBe(PROOF_SCHEMA);
  });

  it('the proof table of §13.3 names exactly the keys the verifier emits', () => {
    const section = SPEC.slice(SPEC.indexOf('### 13.3 The fairness proof'), SPEC.indexOf('### 13.4'));
    const documented = new Set<string>();
    for (const line of section.split('\n')) {
      if (!line.startsWith('| `')) continue;
      const cell = line.split('|')[1]!;
      for (const m of cell.matchAll(/`([^`]+)`/g)) documented.add(m[1]!.replace(/\[\]$/, ''));
    }
    const emitted = new Set<string>();
    const flat = (o: Record<string, unknown>, prefix: string) => {
      for (const [k, v] of Object.entries(o)) {
        const path = prefix ? `${prefix}.${k}` : k;
        if (v && typeof v === 'object' && !Array.isArray(v)) flat(v as Record<string, unknown>, path);
        else emitted.add(path);
      }
    };
    flat(sample, '');
    expect([...emitted].sort()).toEqual([...documented].sort());
    // The row fields of book[] are described in the table row for book[].
    for (const f of ['price', 'buy', 'sell', 'buyOrders', 'sellOrders']) expect(section).toContain(`\`${f}\``);
  });

  it('verified follows §13.2 step 7 for each on-chain outcome', async () => {
    const x = getAddressDecoder().decode(new Uint8Array(32).fill(3)) as Address;
    const live = await proofFor(x, SMALL_BOOK, { state: CrossState.Live, clearing: null, noPrintReason: null });
    expect(live).toMatchObject({ state: 'Live', verified: false, recomputed: { printed: false } });
    expect(live.notes).toContain('The cross has not cleared yet; nothing to verify.');

    // Printed on chain with the recomputed result: verified. With another price: not.
    const ok = await proofFor(x, SMALL_BOOK, { state: CrossState.Cleared, clearing: PRINTED, noPrintReason: null });
    expect(ok).toMatchObject({ verified: true, recomputed: { printed: true, price: '1200000', matched: '4', rationed: 'sell' }, onchain: { printed: true, rationed: 'sell', noPrintReason: null } });
    const forged = await proofFor(x, SMALL_BOOK, { state: CrossState.Cleared, clearing: { ...PRINTED, price: 1_250_000n }, noPrintReason: null });
    expect(forged.verified).toBe(false);

    // No print on chain with the reason the recomputation also finds.
    const noCross = await proofFor(x, [{ price: 1_300_000n, buy: 4n, sell: 0n, buyOrders: 1, sellOrders: 0 }], { state: CrossState.NoPrint, clearing: null, noPrintReason: NoPrintReason.NoCross });
    expect(noCross).toMatchObject({ verified: true, onchain: { printed: false, noPrintReason: 0 }, recomputed: { printed: false, noPrintReason: 'NoCross' } });
    const volume = await proofFor(x, SMALL_BOOK, { state: CrossState.NoPrint, clearing: null, noPrintReason: NoPrintReason.BelowMinimumVolume, minMatched: 5n });
    expect(volume).toMatchObject({ verified: true, recomputed: { noPrintReason: 'BelowMinimumVolume' } });
    const imbalance = await proofFor(x, SMALL_BOOK, { state: CrossState.NoPrint, clearing: null, noPrintReason: NoPrintReason.ImbalanceTooHigh, maxImbalanceBps: 14_999 });
    expect(imbalance).toMatchObject({ verified: true, recomputed: { noPrintReason: 'ImbalanceTooHigh' } });
    // A no print that the book does not justify is not verified.
    const unjustified = await proofFor(x, SMALL_BOOK, { state: CrossState.NoPrint, clearing: null, noPrintReason: NoPrintReason.NoCross });
    expect(unjustified.verified).toBe(false);

    // Oracle verdicts cannot be reproduced from the book: verified when the cross did not print, with a note.
    const oracle = await proofFor(x, SMALL_BOOK, { state: CrossState.NoPrint, clearing: null, noPrintReason: NoPrintReason.OracleDivergence, oracle: true });
    expect(oracle.verified).toBe(true);
    expect(oracle.notes.join(' ')).toContain('the book alone cannot reproduce this verdict');

    // An abandoned settlement keeps its clearing: verified when the recomputation prints.
    const abandoned = await proofFor(x, SMALL_BOOK, { state: CrossState.NoPrint, clearing: PRINTED, noPrintReason: NoPrintReason.SettlementExpired });
    expect(abandoned).toMatchObject({ verified: true, onchain: { printed: true, noPrintReason: 3 } });
    expect(abandoned.notes.join(' ')).toContain('every order was refunded');
  });

  it('the conformance block matches the committed vector file', () => {
    const c = block<{ schema: string; file: string; cases: number; generator: string }>('conformance');
    const vectors = loadVectors(resolve(ROOT, c.file));
    expect(vectors.schema).toBe(c.schema);
    expect(vectors.cases.length).toBe(c.cases);
    expect((vectors as unknown as { generator: string }).generator).toBe(c.generator);
    expect(vectors.cases.filter((x) => x.name.startsWith('random #')).length).toBe(500);
    expect(vectors.cases.length - 500).toBe(25);
    expect(runConformance(vectors, referenceImplementation)).toEqual([]);
  });
});

// ---- the API appendix -----------------------------------------------------------------------------------------------------

describe('OCIP-1 Appendix A (non-normative)', () => {
  it('lists exactly the routes services/api registers, with the same method', () => {
    const server = read('services/api/src/server.ts');
    const real: string[] = [];
    for (const m of server.matchAll(/app\.(get|post)\(\s*'(\/v1\/[^']*)'(\s*,\s*\{\s*websocket:\s*true\s*\})?/g)) real.push(`${m[3] ? 'WS' : m[1]!.toUpperCase()} ${m[2]}`);
    const table = /<!-- ocip-routes:begin -->([\s\S]*?)<!-- ocip-routes:end -->/.exec(SPEC)![1]!;
    const listed = [...table.matchAll(/^\| (GET|POST|WS) \| `([^`]+)` \|/gm)].map((m) => `${m[1]} ${m[2]}`);
    expect(listed.length).toBeGreaterThan(30);
    expect(new Set(listed).size).toBe(listed.length);
    expect([...listed].sort()).toEqual([...real].sort());
  });
});
