// Keeps the machine-checked parts of docs/spec/OCIP-1.md equal to the program IDLs.
//
//   node scripts/ocip-sync.mjs          rewrite the spec in place
//   node scripts/ocip-sync.mjs --check  exit 1 if the spec would change
//
// What it writes: the instruction index and the account index (§4.1, §3.5), the event and error tables of every
// program (§12), the lines of every enumeration (§3.4 and §19.6), and, between the `ocip-gen` markers, the account
// tables, nested-type tables and per-instruction blocks of every item the hand-written text does not already
// tabulate. Hand-written prose is never touched. `tests/core/test/ocip-spec.test.ts` is the check that these tables
// and the IDLs agree; this script exists so that a change to a program is one command and not an afternoon.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');
const SPEC_PATH = 'docs/spec/OCIP-1.md';
const raw = read(SPEC_PATH);
// The file may be checked out with CRLF line endings: edit it with LF and put the original endings back.
const crlf = raw.includes('\r\n');
let spec = raw.replace(/\r\n/g, '\n');
const original = spec;
/** The spec without the machine-written regions: what a hand-written block or line already covers. */
const GEN_REGION = /<!-- ocip-gen:([^ ]+) -->\n[\s\S]*?\n<!-- \/ocip-gen:\1 -->/g;
const handWritten = spec.replace(GEN_REGION, '');

const IDL_PATHS = {
  cross_core: 'idls/cross_core.json',
  cross_gate: 'idls/cross_gate.json',
  cross_settle: 'packages/cross-settle-client/idl/cross_settle.json',
  cross_calendar: 'packages/cross-calendar-client/idl/cross_calendar.json',
  treasury: 'idls/treasury.json',
};
const PROGRAMS = Object.keys(IDL_PATHS);
const OWN_TYPES = ['cross_core', 'cross_gate', 'cross_calendar', 'treasury'];
const IDLS = Object.fromEntries(PROGRAMS.map((p) => [p, JSON.parse(read(IDL_PATHS[p]))]));

const hex = (b) => Buffer.from(b).toString('hex');
const sha = (s) => createHash('sha256').update(s).digest();
const disc8 = (s) => hex(sha(s).subarray(0, 8));

function typeName(t) {
  if (typeof t === 'string') return t === 'pubkey' ? 'Pubkey' : t;
  if ('array' in t) return `[${typeName(t.array[0])}; ${t.array[1]}]`;
  if ('option' in t) return `Option<${typeName(t.option)}>`;
  if ('vec' in t) return `Vec<${typeName(t.vec)}>`;
  return t.defined.name;
}
const flagsOf = (a) => `${a.writable ? 'W' : ''}${a.signer ? 'S' : ''}${a.optional ? 'O' : ''}` || '–';

/** Borsh size of a type with every Option present; null when it contains a Vec. */
function sizeOf(t, idl) {
  if (typeof t === 'string') {
    const sizes = { bool: 1, u8: 1, i8: 1, u16: 2, i16: 2, u32: 4, i32: 4, u64: 8, i64: 8, u128: 16, i128: 16, pubkey: 32 };
    if (sizes[t] === undefined) throw new Error(`unsized ${t}`);
    return sizes[t];
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
  const def = idl.types.find((x) => x.name === t.defined.name);
  if (def.type.kind === 'enum') return 1;
  let total = 0;
  for (const f of def.type.fields) {
    const n = sizeOf(f.type, idl);
    if (n === null) return null;
    total += n;
  }
  return total;
}

function sourceConsts(path) {
  const out = {};
  for (const m of read(path).matchAll(/pub const ([A-Z_]+): (?:usize|u8|u16|u64|i64) = ([0-9_ *]+);/g)) {
    out[m[1]] = m[2].split('*').reduce((a, x) => a * Number(x.trim().replaceAll('_', '')), 1);
  }
  return out;
}
const calendarConsts = sourceConsts('programs/cross_calendar/src/lib.rs');

function accountSize(prog, name) {
  const idl = IDLS[prog];
  if (name === 'Calendar') {
    const sessions = 4 + 16 * calendarConsts.MAX_SESSIONS;
    const feeds = 4 + 32 * calendarConsts.MAX_FEEDS;
    return 8 + 32 + 8 + 8 + sessions + feeds + (1 + sessions + feeds + 8) + (1 + 32 + 8) + 1;
  }
  const def = idl.types.find((t) => t.name === name);
  let size = 8;
  for (const f of def.type.fields) {
    const n = sizeOf(f.type, idl);
    if (n === null) throw new Error(`account ${prog}.${name} has a variable-size field ${f.name}; document its size by hand`);
    size += n;
  }
  return size;
}

// ---------------------------------------------------------------- spec editing helpers

function replaceTableRows(headerLine, rows) {
  const lines = spec.split('\n');
  const at = lines.findIndex((l) => l === headerLine);
  if (at < 0) throw new Error(`table header not found: ${headerLine}`);
  let end = at + 2;
  while (end < lines.length && lines[end].startsWith('|')) end++;
  lines.splice(at + 2, end - (at + 2), ...rows);
  spec = lines.join('\n');
}

function replaceMarked(kind, args, fn) {
  const open = `<!-- ocip:${kind} ${args} -->\n`;
  const at = spec.indexOf(open);
  if (at < 0) throw new Error(`block not found: ocip:${kind} ${args}`);
  const close = `\n<!-- /ocip:${kind} -->`;
  const end = spec.indexOf(close, at);
  if (end < 0) throw new Error(`block not closed: ocip:${kind} ${args}`);
  const body = spec.slice(at + open.length, end);
  spec = spec.slice(0, at + open.length) + fn(body) + spec.slice(end);
}

const hasMarked = (kind, args) => handWritten.includes(`<!-- ocip:${kind} ${args} -->\n`);

function replaceGenerated(name, text) {
  const open = `<!-- ocip-gen:${name} -->\n`;
  const at = spec.indexOf(open);
  if (at < 0) throw new Error(`generated region not found: ${name}`);
  const close = `\n<!-- /ocip-gen:${name} -->`;
  const end = spec.indexOf(close, at);
  if (end < 0) throw new Error(`generated region not closed: ${name}`);
  spec = spec.slice(0, at + open.length) + text.replace(/\n+$/, '') + spec.slice(end);
}

// ---------------------------------------------------------------- the tables

// §4.1 instruction index
{
  const rows = [];
  for (const prog of PROGRAMS) {
    for (const ix of [...IDLS[prog].instructions].sort((a, b) => a.name.localeCompare(b.name))) {
      const dflt = disc8(`global:${ix.name}`) === hex(ix.discriminator);
      rows.push(`| \`${prog}\` | \`${ix.name}\` | \`${hex(ix.discriminator)}\` | ${dflt ? 'Anchor default' : 'explicit'} |`);
    }
  }
  replaceTableRows('| Program | Instruction | Discriminator | Rule |', rows);
}

// §3.5 account index
{
  const rows = [];
  for (const prog of PROGRAMS) {
    for (const a of [...(IDLS[prog].accounts ?? [])].sort((x, y) => x.name.localeCompare(y.name))) {
      rows.push(`| \`${prog}\` | \`${a.name}\` | \`${hex(a.discriminator)}\` | ${accountSize(prog, a.name)} |`);
    }
  }
  replaceTableRows('| Program | Account | Discriminator | Allocated size |', rows);
}

// §12 events and errors
for (const prog of PROGRAMS) {
  const idl = IDLS[prog];
  replaceMarked('events', prog, (body) => {
    const head = body.slice(0, body.indexOf('|---|---|---|\n') + '|---|---|---|\n'.length);
    const rows = [...(idl.events ?? [])]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((e) => {
        const def = idl.types.find((t) => t.name === e.name);
        return `| \`${e.name}\` | \`${hex(e.discriminator)}\` | ${def.type.fields.map((f) => `\`${f.name}: ${typeName(f.type)}\``).join(', ')} |`;
      });
    return head + rows.join('\n');
  });
  replaceMarked('errors', prog, (body) => {
    const head = body.slice(0, body.indexOf('|---|---|---|\n') + '|---|---|---|\n'.length);
    const rows = (idl.errors ?? []).map((e) => `| ${e.code} | \`${e.name}\` | ${e.msg} |`);
    return head + rows.join('\n');
  });
}

// ---------------------------------------------------------------- enumerations

{
  const lines = [];
  for (const prog of OWN_TYPES) {
    for (const t of IDLS[prog].types) {
      if (t.type.kind !== 'enum') continue;
      const line = `- \`${t.name}\`: ` + t.type.variants.map((v, i) => `${i} \`${v.name}\``).join(', ');
      const re = new RegExp('^- `' + t.name + '`: .*$', 'm');
      if (re.test(handWritten)) spec = spec.replace(re, () => line);
      else lines.push(`${line}`);
    }
  }
  replaceGenerated('enums', lines.length ? lines.join('\n') : '(none)');
}

// ---------------------------------------------------------------- account field tables and nested types

function fieldRows(prog, def) {
  const idl = IDLS[prog];
  let offset = 8;
  return def.type.fields.map((f, i) => {
    const n = sizeOf(f.type, idl);
    const row = `| ${i + 1} | \`${f.name}\` | \`${typeName(f.type)}\` | ${n === null ? '–' : n} | ${offset === null ? '–' : offset} |`;
    offset = n === null || offset === null ? null : offset + n;
    return row;
  });
}

{
  const out = [];
  for (const prog of OWN_TYPES) {
    for (const a of IDLS[prog].accounts ?? []) {
      if (hasMarked('account', a.name)) continue;
      const def = IDLS[prog].types.find((t) => t.name === a.name);
      out.push(`#### \`${a.name}\` (\`${prog}\`)`, '', `<!-- ocip:account ${a.name} -->`, '| # | Field | Type | Size | Offset |', '|---|---|---|---|---|', ...fieldRows(prog, def), '<!-- /ocip:account -->', '');
    }
  }
  replaceGenerated('accounts', out.length ? out.join('\n') : '(none)');
}

{
  const out = [];
  for (const prog of OWN_TYPES) {
    const idl = IDLS[prog];
    const accountNames = new Set((idl.accounts ?? []).map((a) => a.name));
    const eventNames = new Set((idl.events ?? []).map((e) => e.name));
    for (const t of idl.types) {
      if (t.type.kind !== 'struct' || accountNames.has(t.name) || eventNames.has(t.name)) continue;
      if (hasMarked('struct', t.name)) continue;
      out.push(`<!-- ocip:struct ${t.name} -->`, `**\`${t.name}\`** (\`${prog}\`)`, '', '| Field | Type |', '|---|---|', ...t.type.fields.map((f) => `| \`${f.name}\` | \`${typeName(f.type)}\` |`), '<!-- /ocip:struct -->', '');
    }
  }
  replaceGenerated('structs', out.length ? out.join('\n') : '(none)');
}

// ---------------------------------------------------------------- instruction blocks

function seedText(seed) {
  if (seed.kind === 'const') {
    const b = Buffer.from(seed.value);
    return /^[\x20-\x7e]+$/.test(b.toString('latin1')) ? `"${b.toString('latin1')}"` : `0x${b.toString('hex')}`;
  }
  return seed.path;
}

function noteOf(a) {
  if (a.address) return `address \`${a.address}\``;
  if (a.pda) return `PDA [${a.pda.seeds.map(seedText).join(', ')}]` + (a.pda.program ? ' (other program)' : '');
  return '';
}

function ixBlock(prog, ix) {
  const args = ix.args.length ? ix.args.map((a) => `\`${a.name}: ${typeName(a.type)}\``).join(', ') : 'none';
  const docs = (ix.docs ?? []).map((d) => d.trim()).join(' ').trim();
  return [
    `#### \`${ix.name}\``,
    '',
    docs || '',
    docs ? '' : null,
    `<!-- ocip:ix ${prog} ${ix.name} -->`,
    `Discriminator \`${hex(ix.discriminator)}\`. Arguments: ${args}.`,
    '',
    '| # | Account | Flags | Notes |',
    '|---|---|---|---|',
    ...ix.accounts.map((a, i) => `| ${i + 1} | \`${a.name}\` | ${flagsOf(a)} | ${noteOf(a)} |`),
    '<!-- /ocip:ix -->',
    '',
  ]
    .filter((l) => l !== null)
    .join('\n');
}

for (const prog of ['cross_core', 'cross_settle']) {
  const blocks = IDLS[prog].instructions.filter((ix) => !hasMarked('ix', `${prog} ${ix.name}`)).map((ix) => ixBlock(prog, ix));
  replaceGenerated(`ix-${prog}`, blocks.length ? blocks.join('\n') : '(none)');
}

// ---------------------------------------------------------------- write

if (process.argv.includes('--check')) {
  if (spec !== original) {
    console.error('docs/spec/OCIP-1.md is out of date; run `node scripts/ocip-sync.mjs`');
    process.exit(1);
  }
  console.log('OCIP-1 tables are current');
} else {
  writeFileSync(resolve(ROOT, SPEC_PATH), crlf ? spec.replace(/\n/g, '\r\n') : spec);
  console.log(spec === original ? 'OCIP-1 already current' : 'OCIP-1 updated');
}
