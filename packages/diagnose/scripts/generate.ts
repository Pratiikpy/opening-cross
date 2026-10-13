// Builds src/tables.generated.ts from the sources of truth: the IDLs in this repository, Anchor's own framework error enum,
// and the generated error files of the token, token-2022 and system program clients. Nothing is typed by hand, so a table
// cannot drift from the program it describes. Re-run after an IDL changes:  pnpm --filter @opening-cross/diagnose generate
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');

type Table = Record<number, [string, string]>;
interface Program {
  address: string;
  name: string;
  label: string;
  version: string | null;
  source: string;
  errors: Table;
}

const IDLS: { label: string; file: string }[] = [
  { label: 'Meteora Dynamic Bonding Curve', file: 'idls/dynamic_bonding_curve.json' },
  { label: 'Meteora DAMM v2', file: 'idls/cp_amm.json' },
  { label: 'Meteora DLMM', file: 'idls/lb_clmm.json' },
  { label: 'Meteora Met Lock', file: 'idls/met_lock.json' },
  { label: 'Meteora Zap', file: 'idls/zap.json' },
  { label: 'Raydium CPMM', file: 'idls/raydium_cp_swap.json' },
  { label: 'Opening Cross core', file: 'packages/cross-core-client/idl/cross_core.json' },
  { label: 'Opening Cross gate', file: 'packages/cross-gate-client/idl/cross_gate.json' },
  { label: 'Opening Cross settle', file: 'packages/cross-settle-client/idl/cross_settle.json' },
  { label: 'Opening Cross calendar', file: 'packages/cross-calendar-client/idl/cross_calendar.json' },
  { label: 'Opening Cross treasury', file: 'idls/treasury.json' },
];

const programs: Program[] = [];
for (const { label, file } of IDLS) {
  const idl = JSON.parse(readFileSync(join(root, file), 'utf8')) as { address?: string; metadata?: { name: string; version?: string; address?: string }; errors?: { code: number; name: string; msg?: string }[] };
  const address = idl.address ?? idl.metadata?.address;
  if (!address) throw new Error(`${file} has no program address`);
  const errors: Table = {};
  for (const e of idl.errors ?? []) errors[e.code] = [e.name, e.msg ?? e.name];
  programs.push({ address, name: idl.metadata?.name ?? label, label, version: idl.metadata?.version ?? null, source: file, errors });
}

// SPL programs: the generated clients carry "/** Name: message */ export const X = 0x..;" for every error.
function fromCodama(pkg: string, file: string, address: string, name: string, label: string): Program {
  const dir = join(here, '..', 'node_modules', ...pkg.split('/'));
  const path = join(dir, 'src', 'generated', 'errors', file);
  const text = readFileSync(path, 'utf8');
  const version = (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version: string }).version;
  const errors: Table = {};
  for (const m of text.matchAll(/\/\*\* (\w+): ([^\n]*?) \*\/\s*\nexport const \w+ = (0x[0-9a-f]+);/g)) errors[Number(m[3])] = [m[1]!, m[2]!];
  if (Object.keys(errors).length === 0) throw new Error(`no errors parsed from ${path}`);
  return { address, name, label, version: `${pkg}@${version}`, source: `${pkg}/src/generated/errors/${file}`, errors };
}
programs.push(
  fromCodama('@solana-program/token', 'token.ts', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'spl_token', 'SPL Token'),
  fromCodama('@solana-program/token-2022', 'token2022.ts', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', 'spl_token_2022', 'SPL Token-2022'),
  fromCodama('@solana-program/system', 'system.ts', '11111111111111111111111111111111', 'system', 'System program'),
  fromCodama('@solana-program/token', 'associatedToken.ts', 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', 'spl_associated_token_account', 'Associated Token Account'),
);

// Anchor's framework errors: the enum in anchor/lang/error, with the numbers and #[msg] strings the program emits.
const anchorSrc = readFileSync(join(root, 'research', 'repos', 'build', 'anchor', 'lang', 'error', 'src', 'lib.rs'), 'utf8');
const body = anchorSrc.slice(anchorSrc.indexOf('pub enum ErrorCode'));
const framework: Table = {};
// Variants take the previous code plus one unless they state one; the doc comment above each repeats the number, and the two must agree.
let next = 0;
const VARIANT = /\/\/\/ (\d+) - [^\n]*\n\s*#\[msg\(\s*((?:"(?:[^"\\]|\\[\s\S])*"\s*)+)\)\]\s*(\w+)(?:\s*=\s*(\d+))?/g;
for (const m of body.matchAll(VARIANT)) {
  const code = m[4] !== undefined ? Number(m[4]) : next;
  if (code !== Number(m[1])) throw new Error(`anchor error ${m[3]}: computed code ${code} but its doc comment says ${m[1]}`);
  next = code + 1;
  const msg = [...m[2]!.matchAll(/"((?:[^"\\]|\\[\s\S])*)"/g)].map((x) => x[1]!.replace(/\\\r?\n\s*/g, '')).join('');
  framework[code] = [m[3]!, msg];
}
if (Object.keys(framework).length < 60) throw new Error(`parsed only ${Object.keys(framework).length} anchor errors`);
const anchorVersion = /^version = "([^"]+)"/m.exec(readFileSync(join(root, 'research', 'repos', 'build', 'anchor', 'Cargo.toml'), 'utf8'))?.[1] ?? null;

const out = `// GENERATED by scripts/generate.ts from the IDLs in this repository, Anchor's error enum and the SPL clients. Do not edit.
export type ErrorTable = Record<number, readonly [name: string, message: string]>;
export interface ProgramTable {
  readonly address: string;
  readonly name: string;
  readonly label: string;
  /** The IDL (or client package) version the table was generated from. The deployed program may be newer. */
  readonly version: string | null;
  readonly source: string;
  readonly errors: ErrorTable;
}

export const ANCHOR_VERSION: string | null = ${JSON.stringify(anchorVersion)};

/** Anchor framework errors, codes 100 to 5000, raised by any Anchor program. */
export const ANCHOR_FRAMEWORK: ErrorTable = ${JSON.stringify(framework, null, 1)};

export const PROGRAMS: readonly ProgramTable[] = ${JSON.stringify(programs, null, 1)};
`;
writeFileSync(join(here, '..', 'src', 'tables.generated.ts'), out);
console.log(`wrote ${programs.length} programs (${programs.map((p) => `${p.name}:${Object.keys(p.errors).length}`).join(', ')}) and ${Object.keys(framework).length} Anchor framework errors`);
