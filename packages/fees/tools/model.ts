// Rewrites the generated tables of docs/economics/FEE_MODEL.md from the model.
//   pnpm --filter @opening-cross/fees model
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderDocument } from '../src/tables.js';

const path = fileURLToPath(new URL('../../../docs/economics/FEE_MODEL.md', import.meta.url));
const before = readFileSync(path, 'utf8');
const after = renderDocument(before);
writeFileSync(path, after);
console.log(before === after ? 'FEE_MODEL.md already up to date' : 'FEE_MODEL.md updated');
