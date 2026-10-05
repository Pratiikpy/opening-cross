// Regenerates every program client from its committed IDL:
//   anchor idl build -o packages/<client>/idl/<program>.json   (inside programs/<program>)
//   pnpm --filter @opening-cross/codegen generate
import { readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createFromRoot } from 'codama';
import { rootNodeFromAnchor } from '@codama/nodes-from-anchor';
import { renderVisitor } from '@codama/renderers-js';

const CLIENTS = [
  { program: 'cross_gate', pkg: 'cross-gate-client' },
  { program: 'cross_core', pkg: 'cross-core-client' },
  { program: 'cross_settle', pkg: 'cross-settle-client' },
];

for (const { program, pkg } of CLIENTS) {
  const dir = fileURLToPath(new URL(`../${pkg}/`, import.meta.url));
  const idl = JSON.parse(readFileSync(`${dir}idl/${program}.json`, 'utf8'));
  rmSync(`${dir}src/generated`, { recursive: true, force: true });
  await createFromRoot(rootNodeFromAnchor(idl)).accept(
    renderVisitor(dir, { generatedFolder: 'src/generated', importExtension: 'js', syncPackageJson: false, formatCode: false }),
  );
  console.log(`generated ${pkg}`);
}
