// Builds src/tables.generated.ts from the sources of truth: the IDLs in this repository, Anchor's own framework error enum,
// and the generated error files of the token, token-2022 and system program clients. Nothing is typed by hand, so a table
// cannot drift from the program it describes. Re-run after an IDL changes:  pnpm --filter @opening-cross/diagnose generate
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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
  { label: 'Opening Cross mandate', file: 'packages/cross-mandate-client/idl/cross_mandate.json' },
  { label: 'Opening Cross conviction', file: 'packages/cross-conviction-client/idl/cross_conviction.json' },
  { label: 'Opening Cross basket', file: 'packages/cross-basket-client/idl/cross_basket.json' },
  { label: 'Opening Cross listing', file: 'packages/cross-listing-client/idl/cross_listing.json' },
  { label: 'Opening Cross bounty', file: 'packages/cross-bounty-client/idl/cross_bounty.json' },
  { label: 'Opening Cross backing', file: 'packages/cross-backing-client/idl/cross_backing.json' },
  { label: 'Opening Cross graduate', file: 'packages/cross-graduate-client/idl/cross_graduate.json' },
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

// ---------------------------------------------------------------------------------------------------- version-matched docs
// For each program that has published documentation or source we hold, record what that documentation and source describe, and
// which release they are, so a diagnosis can say whether the words it links to match the IDL it was generated from (L5). Nothing is
// assumed to match: the release named by the docs' changelog and by the source's Cargo.toml is compared with the IDL's version.
interface DocsTarget {
  idlLabel: string;
  /** The developer-guides slug in the local capture of docs.meteora.ag. */
  docs: string | null;
  repo: { dir: string; github: string; errorFile: string; cargo: string } | null;
}
const DOCS_TARGETS: DocsTarget[] = [
  { idlLabel: 'Meteora Dynamic Bonding Curve', docs: 'dbc', repo: { dir: 'dynamic-bonding-curve', github: 'MeteoraAg/dynamic-bonding-curve', errorFile: 'programs/dynamic-bonding-curve/src/error.rs', cargo: 'programs/dynamic-bonding-curve/Cargo.toml' } },
  { idlLabel: 'Meteora DAMM v2', docs: 'damm-v2', repo: { dir: 'damm-v2', github: 'MeteoraAg/damm-v2', errorFile: 'programs/cp-amm/src/error.rs', cargo: 'programs/cp-amm/Cargo.toml' } },
  { idlLabel: 'Meteora DLMM', docs: 'dlmm', repo: null },
  { idlLabel: 'Meteora Zap', docs: 'zap', repo: null },
  { idlLabel: 'Raydium CPMM', docs: null, repo: { dir: 'raydium-cp-swap', github: 'raydium-io/raydium-cp-swap', errorFile: 'programs/cp-swap/src/error.rs', cargo: 'programs/cp-swap/Cargo.toml' } },
];

interface DocsEntry {
  /** The documentation pages for this program, from the local capture of docs.meteora.ag (urls.txt). */
  pages: { title: string; url: string }[];
  /** The release the documentation's changelog lists first, or null when the program has no changelog page. */
  docsRelease: string | null;
  /** The source the table's line numbers point into, pinned to a commit. */
  source: { repo: string; commit: string; release: string | null; file: string } | null;
  /** Per error code: the documentation's words (cause, or where it is raised) and the line of its definition in the source. */
  errors: Record<number, { cause?: string; raisedIn?: string; line?: number }>;
}

const urls = new Set(readFileSync(join(root, 'meteora-resources', 'urls.txt'), 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
const docUrl = (path: string): string | null => (urls.has(`https://docs.meteora.ag/${path}.md`) ? `https://docs.meteora.ag/${path}` : null);
const git = (dir: string, ...args: string[]): string => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

function docsErrors(slug: string): Record<number, { name: string; cause?: string; raisedIn?: string }> {
  const file = join(root, 'meteora-resources', 'docs', `developer-guides__${slug}__program__errors.md`);
  const out: Record<number, { name: string; cause?: string; raisedIn?: string }> = {};
  let columns: string[] = [];
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.startsWith('|')) {
      columns = [];
      continue;
    }
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (/^code$/i.test(cells[0] ?? '')) {
      columns = cells.map((c) => c.toLowerCase());
      continue;
    }
    const code = /^`(\d+)`$/.exec(cells[0] ?? '');
    if (!code || columns.length === 0) continue;
    const col = (re: RegExp) => {
      const i = columns.findIndex((c) => re.test(c));
      return i >= 0 ? cells[i] : undefined;
    };
    const name = (col(/^(name|error)$/) ?? '').replace(/`/g, '');
    const cause = col(/cause|why/);
    const raised = col(/instruction/);
    // A page may list an error in more than one table (where it is raised, and why it occurs): the rows for a code are merged.
    const html = (v: string) => v.replace(/<\/li><li>/g, ', ').replace(/<[^>]+>/g, '').replace(/\\_/g, '_').replace(/`/g, '').trim();
    out[Number(code[1])] = { ...(out[Number(code[1])] ?? {}), name, ...(cause ? { cause } : {}), ...(raised ? { raisedIn: html(raised) } : {}) };
  }
  if (Object.keys(out).length === 0) throw new Error(`no error rows parsed from ${file}`);
  return out;
}

/** Variants of an Anchor `#[error_code]` enum in order, with the line each is defined on. Codes start at 6000. */
function sourceErrors(file: string): { name: string; line: number }[] {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  const start = lines.findIndex((l) => /#\[error_code/.test(l));
  if (start < 0) throw new Error(`${file} has no #[error_code] enum`);
  const found: { name: string; line: number }[] = [];
  let inEnum = false;
  for (let i = start; i < lines.length; i++) {
    const l = lines[i]!.trim();
    if (/^pub enum \w+/.test(l)) {
      inEnum = true;
      continue;
    }
    if (!inEnum || l === '' || l.startsWith('//') || l.startsWith('#[')) continue;
    if (l.startsWith('}')) break;
    const m = /^(\w+)\s*(=\s*\d+)?\s*,?\s*(\/\/.*)?$/.exec(l);
    if (m) found.push({ name: m[1]!, line: i + 1 });
  }
  return found;
}

const DOCS: Record<string, DocsEntry> = {};
const docsNotes: string[] = [];
for (const t of DOCS_TARGETS) {
  const prog = programs.find((p) => p.label === t.idlLabel);
  if (!prog) throw new Error(`no program table for ${t.idlLabel}`);
  const entry: DocsEntry = { pages: [], docsRelease: null, source: null, errors: {} };
  if (t.docs) {
    const errorsUrl = docUrl(`developer-guides/${t.docs}/program/errors`);
    const changelogUrl = docUrl(`developer-guides/${t.docs}/changelog`);
    if (errorsUrl) entry.pages.push({ title: `${prog.label}: program errors`, url: errorsUrl });
    if (changelogUrl) entry.pages.push({ title: `${prog.label}: changelog`, url: changelogUrl });
    const changelog = join(root, 'meteora-resources', 'docs', `developer-guides__${t.docs}__changelog.md`);
    if (existsSync(changelog)) entry.docsRelease = /<Update label="[^"]*?(\d+\.\d+\.\d+)"/.exec(readFileSync(changelog, 'utf8'))?.[1] ?? null;
    for (const [code, row] of Object.entries(docsErrors(t.docs))) {
      const idlName = prog.errors[Number(code)]?.[0];
      // The documentation's words are attached only where it names the same error under the same code as the IDL.
      if (idlName === row.name) entry.errors[Number(code)] = { ...(row.cause ? { cause: row.cause } : {}), ...(row.raisedIn ? { raisedIn: row.raisedIn } : {}) };
      else docsNotes.push(`${prog.label}: docs say ${code} is ${row.name}, the IDL says ${idlName ?? 'nothing'}`);
    }
  }
  if (t.repo) {
    const dir = join(root, 'research', 'repos', t.repo.dir);
    const commit = git(dir, 'rev-parse', 'HEAD');
    const release = /^version\s*=\s*"([^"]+)"/m.exec(readFileSync(join(dir, t.repo.cargo), 'utf8'))?.[1] ?? null;
    entry.source = { repo: t.repo.github, commit, release, file: t.repo.errorFile };
    sourceErrors(join(dir, t.repo.errorFile)).forEach((v, i) => {
      const code = 6000 + i;
      // A line is attached only where the source's variant has the IDL's name at the IDL's code.
      if (prog.errors[code]?.[0] === v.name) entry.errors[code] = { ...(entry.errors[code] ?? {}), line: v.line };
      else docsNotes.push(`${prog.label}: source has ${v.name} at ${code}, the IDL says ${prog.errors[code]?.[0] ?? 'nothing'}`);
    });
  }
  DOCS[prog.address] = entry;
}
console.log(`docs: ${Object.keys(DOCS).length} programs, ${docsNotes.length} disagreements${docsNotes.length ? `\n  ${docsNotes.join('\n  ')}` : ''}`);

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

export interface ProgramDocs {
  /** Documentation pages for the program, from the local capture of its published docs. */
  readonly pages: readonly { readonly title: string; readonly url: string }[];
  /** The release the documentation's changelog lists first. */
  readonly docsRelease: string | null;
  /** The source the line numbers point into, pinned to a commit of the program's repository. */
  readonly source: { readonly repo: string; readonly commit: string; readonly release: string | null; readonly file: string } | null;
  /** What the documentation says about an error and where the source defines it, only where both name the error the IDL does. */
  readonly errors: Record<number, { readonly cause?: string; readonly raisedIn?: string; readonly line?: number }>;
}

/** Keyed by program address. */
export const DOCS: Record<string, ProgramDocs> = ${JSON.stringify(DOCS, null, 1)};
`;
writeFileSync(join(here, '..', 'src', 'tables.generated.ts'), out);
console.log(`wrote ${programs.length} programs (${programs.map((p) => `${p.name}:${Object.keys(p.errors).length}`).join(', ')}) and ${Object.keys(framework).length} Anchor framework errors`);
