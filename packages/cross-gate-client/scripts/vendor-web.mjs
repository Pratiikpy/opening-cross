// Copies this package's TypeScript source into the web app, with the one change the web app's bundler needs.
//
//   node scripts/vendor-web.mjs           write the copy
//   node scripts/vendor-web.mjs --check   exit 1 if the copy differs from the source (the test runs this)
//
// Why a copy: this package is NodeNext TypeScript, so its relative imports end in `.js` (`./generated/index.js`) and a
// TypeScript compiler maps them to the `.ts` files. The web app is bundled by Turbopack, which does not map `.js` to `.ts`, and
// the web app does not list this package as a dependency. Dropping the extension from relative imports is the only change; the
// copy is otherwise byte for byte the source, so there is one implementation and a test that fails when the copy is stale.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const SOURCE = join(HERE, '..', 'src');
export const TARGET = join(HERE, '..', '..', '..', 'apps', 'web', 'src', 'app', 'gates', '_lib', 'gate-client');

const BANNER = '// Vendored from packages/cross-gate-client/src by scripts/vendor-web.mjs. Do not edit here: change the package and run `pnpm --filter @opening-cross/cross-gate-client vendor:web`.\n';

/** Relative imports and re-exports without their `.js`. Everything else is untouched. */
export function rewrite(text) {
  return text.replace(/(\b(?:from|import)\s*)(['"])(\.{1,2}\/[^'"]*?)\.js\2/g, '$1$2$3$2');
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []));
}

/** The files the copy should hold, as `relative path -> contents`. */
export function expected() {
  const out = new Map();
  for (const file of walk(SOURCE)) out.set(relative(SOURCE, file).split('\\').join('/'), BANNER + rewrite(readFileSync(file, 'utf8').replace(/\r\n/g, '\n')));
  return out;
}

/** The copy as it is now. */
export function actual() {
  const out = new Map();
  if (!existsSync(TARGET)) return out;
  for (const file of walk(TARGET)) out.set(relative(TARGET, file).split('\\').join('/'), readFileSync(file, 'utf8').replace(/\r\n/g, '\n'));
  return out;
}

/** What differs: files missing from the copy, files that should not be there, and files whose contents differ. */
export function differences() {
  const want = expected();
  const have = actual();
  return {
    missing: [...want.keys()].filter((k) => !have.has(k)),
    extra: [...have.keys()].filter((k) => !want.has(k)),
    changed: [...want.keys()].filter((k) => have.has(k) && have.get(k) !== want.get(k)),
  };
}

function write() {
  rmSync(TARGET, { recursive: true, force: true });
  for (const [rel, text] of expected()) {
    const path = join(TARGET, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes('--check')) {
    const d = differences();
    const n = d.missing.length + d.extra.length + d.changed.length;
    if (n > 0) {
      console.error(`the web copy of the gate client is stale (${d.missing.length} missing, ${d.extra.length} extra, ${d.changed.length} changed); run: pnpm --filter @opening-cross/cross-gate-client vendor:web`);
      process.exit(1);
    }
    console.log('the web copy of the gate client is current');
  } else {
    write();
    console.log(`wrote ${expected().size} files to ${relative(process.cwd(), TARGET)}`);
  }
}
