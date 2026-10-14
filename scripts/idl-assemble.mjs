// Assembles an Anchor IDL from the output of
//   cargo test --release --features idl-build __anchor_private_print_idl -- --show-output --quiet
// run inside a program's directory. It does what `anchor idl build` does with that output (the program
// section, then the events, errors and the types the events bring), for machines where the anchor
// binary cannot run. Usage: node scripts/idl-assemble.mjs <cargo-test-output-file> <idl-out-file>
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error('usage: node scripts/idl-assemble.mjs <cargo-test-output> <idl-out>');
  process.exit(2);
}
const text = readFileSync(input, 'utf8').replace(/\0/g, '');
const sections = [...text.matchAll(/--- IDL begin (\w+) ---\n([\s\S]*?)\n--- IDL end \1 ---/g)].map(([, kind, body]) => {
  let value = JSON.parse(body);
  // The address section is a JSON string that holds a JSON string.
  if (typeof value === 'string' && /^["[{]/.test(value)) value = JSON.parse(value);
  return { kind, value };
});
const program = sections.find((s) => s.kind === 'program')?.value;
if (!program) throw new Error('no program section: was the crate built with the idl-build feature?');
const address = sections.find((s) => s.kind === 'address')?.value;
const errors = sections.filter((s) => s.kind === 'errors').flatMap((s) => s.value);
const events = sections.filter((s) => s.kind === 'event').map((s) => s.value);

const types = new Map((program.types ?? []).map((t) => [t.name, t]));
for (const e of events) for (const t of e.types ?? []) types.set(t.name, t);
// Code-unit order, as the CLI sorts: capitals before lower case, so full paths (`crate::module::Type`) follow the bare names.
const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
const idl = {
  address: address ?? program.address,
  metadata: program.metadata,
  instructions: [...program.instructions].sort(byName),
  accounts: [...(program.accounts ?? [])].sort(byName),
  events: events.map((e) => e.event).sort(byName),
  errors,
  types: [...types.values()].sort(byName),
};
// The macros print type names qualified by their module path (`crate::module::Type`). The CLI prints the bare name when it
// is unique among the IDL's types and the full path when two types share one (two Meteora programs both define
// `BaseFeeParameters`), so a reference always resolves to exactly one type.
const lastSegment = (n) => n.split('::').pop();
const shortNames = new Map();
{
  const all = [...new Set([...idl.types, ...idl.accounts, ...idl.events].map((t) => t.name))];
  const count = new Map();
  for (const n of all) count.set(lastSegment(n), (count.get(lastSegment(n)) ?? 0) + 1);
  for (const n of all) if (count.get(lastSegment(n)) === 1) shortNames.set(n, lastSegment(n));
}
const bare = (n) => (typeof n === 'string' ? (shortNames.get(n) ?? n) : n);
const strip = (v) => {
  if (Array.isArray(v)) return v.map(strip);
  if (v && typeof v === 'object') {
    const out = {};
    if ('name' in v) out.name = bare(v.name);
    if ('kind' in v) out.kind = strip(v.kind);
    for (const [k, x] of Object.entries(v)) if (k !== 'name' && k !== 'kind') out[k] = strip(x);
    return out;
  }
  return v;
};
for (const k of ['accounts', 'events', 'types']) idl[k] = strip(idl[k]);
idl.instructions = strip(idl.instructions);
idl.types.sort(byName);
idl.events.sort(byName);
idl.accounts.sort(byName);
for (const k of ['accounts', 'events', 'errors', 'types']) if (idl[k].length === 0) delete idl[k];
// serde_json writes non-ASCII characters as they are; one committed IDL (cross_core) was written with backslash-u escapes.
// An existing file keeps whichever style and trailing newline it has, so regenerating an unchanged IDL changes no byte.
const existing = existsSync(output) ? readFileSync(output, 'utf8') : '';
const escapesAlready = /\\u[0-9a-f]{4}/.test(existing);
const ascii = (text) => text.replace(/[^\x00-\x7f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
const body = JSON.stringify(idl, null, 2);
writeFileSync(output, (escapesAlready ? ascii(body) : body) + (existing.endsWith('\n') ? '\n' : ''));
console.log(`wrote ${output}: ${idl.instructions.length} instructions, ${(idl.accounts ?? []).length} accounts, ${(idl.events ?? []).length} events, ${(idl.errors ?? []).length} errors, ${(idl.types ?? []).length} types`);
