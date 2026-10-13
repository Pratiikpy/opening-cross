// Writes the documentation corpus as one JSON file, for running the docs MCP server where the repository is not checked out.
//   tsx scripts/docs-corpus.ts [repository root] [output file]
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readCorpus } from '../src/docs-index.js';

const root = process.argv[2] ?? fileURLToPath(new URL('../../../', import.meta.url));
const out = process.argv[3] ?? 'docs-corpus.json';
const corpus = readCorpus(root);
writeFileSync(out, JSON.stringify(corpus));
console.log(`${corpus.files.length} documents at revision ${corpus.revision} written to ${out}`);
