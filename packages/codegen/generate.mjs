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
  { program: 'cross_calendar', pkg: 'cross-calendar-client' },
  { program: 'treasury', pkg: 'treasury-client' },
  { program: 'cross_mandate', pkg: 'cross-mandate-client' },
  { program: 'cross_graduate', pkg: 'cross-graduate-client' },
  { program: 'cross_backing', pkg: 'cross-backing-client' },
  { program: 'cross_bounty', pkg: 'cross-bounty-client' },
  { program: 'cross_listing', pkg: 'cross-listing-client' },
  { program: 'cross_basket', pkg: 'cross-basket-client' },
  { program: 'cross_conviction', pkg: 'cross-conviction-client' },
];

// ONLY=cross_core,treasury regenerates just those clients.
const only = process.env.ONLY?.split(',').filter(Boolean);

for (const { program, pkg } of CLIENTS) {
  if (only && !only.includes(program)) continue;
  const dir = fileURLToPath(new URL(`../${pkg}/`, import.meta.url));
  const idl = JSON.parse(readFileSync(`${dir}idl/${program}.json`, 'utf8'));
  rmSync(`${dir}src/generated`, { recursive: true, force: true });
  await createFromRoot(rootNodeFromAnchor(idl)).accept(
    renderVisitor(dir, { generatedFolder: 'src/generated', importExtension: 'js', syncPackageJson: false, formatCode: false }),
  );
  console.log(`generated ${pkg}`);
}
