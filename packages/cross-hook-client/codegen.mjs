// Regenerates src/generated from the Anchor IDL (idl/cross_hook.json, copied from target/idl after anchor idl build).
import { readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createFromRoot } from 'codama';
import { rootNodeFromAnchor } from '@codama/nodes-from-anchor';
import { renderVisitor } from '@codama/renderers-js';

const pkg = fileURLToPath(new URL('./', import.meta.url));
const idl = JSON.parse(readFileSync(new URL('./idl/cross_hook.json', import.meta.url), 'utf8'));
rmSync(`${pkg}src/generated`, { recursive: true, force: true });
await createFromRoot(rootNodeFromAnchor(idl)).accept(
  renderVisitor(pkg, { generatedFolder: 'src/generated', importExtension: 'js', syncPackageJson: true, formatCode: false }),
);
console.log('generated src/generated');
